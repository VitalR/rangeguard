import { Token } from "@uniswap/sdk-core";
import { keccak256 } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { getPoolKeyFromPosition, buildPoolFromState } from "../uniswap/pool";
import { buildCollectUnlockData } from "../uniswap/planner";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { parseVaultEvents } from "../vault/events";
import { fetchVaultState } from "../vault/state";

type CollectOptions = {
  send?: boolean;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

export const collectCommand = async (options: CollectOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const { state: stateBefore, context } = await fetchVaultState(config, publicClient, account);

    if (!context.initialized) {
      throw new KeeperError("Vault position not initialized");
    }

    const positionId = context.ticks[3] as bigint;
    const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;

    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);
    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const { pool, poolId } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency,
      config.poolId
    );

    const unlockData = buildCollectUnlockData({
      tokenId: positionId,
      hookData: config.policy.hookDataHex,
      currency0: pool.currency0,
      currency1: pool.currency1,
      recipient: config.vaultAddress
    });

    await assertCooldown(config.policy, config.vaultAddress, "collect");

    const params = {
      deadline: deadlineFromNow(config.defaultDeadlineSeconds),
      unlockData,
      callValue: 0n,
      maxApprove0: 0n,
      maxApprove1: 0n
    };

    await checkPermit2Allowances({
      publicClient,
      vault: config.vaultAddress,
      positionManager: positionManagerAddress,
      token0: context.token0,
      token1: context.token1,
      required0: 0n,
      required1: 0n,
      throwOnMissing: false
    });

    const dryRun = !options.send;

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "collect",
      args: [params],
      account: account.address
    });

    let gasEstimate: bigint | undefined;
    if (options.verbose) {
      try {
        gasEstimate = await publicClient.estimateContractGas(simulation.request);
      } catch {
        gasEstimate = undefined;
      }
    }

    const runId = createRunId();
    const report: RunReport = {
      runId,
      command: "collect",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: positionManagerAddress,
        poolId,
        token0: context.token0,
        token1: context.token1,
        quoter: config.quoterAddress
      },
      tokens: {
        token0: { address: context.token0, decimals: context.token0Decimals },
        token1: { address: context.token1, decimals: context.token1Decimals }
      },
      policy: config.policy,
      decision: { action: "execute", reason: dryRun ? "dry-run" : "send" },
      stateBefore,
      plan: {
        positionId: positionId.toString(),
        deadline: params.deadline.toString(),
        callValue: "0"
      }
    };

    if (options.verbose) {
      const calldata = (simulation.request as { data?: `0x${string}` }).data;
      report.debug = {
        unlockDataHash: keccak256(unlockData),
        calldataHash: hashCalldata(calldata),
        gasEstimate: gasEstimate?.toString()
      };
    }

    if (dryRun) {
      report.tx = { dryRun: true };
      report.stateAfter = stateBefore;
      await outputReport(report, options);
      return;
    }

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const { state: stateAfter } = await fetchVaultState(config, publicClient, account);
    const events = parseVaultEvents(receipt.logs, config.vaultAddress);

    report.tx = {
      dryRun: false,
      hash,
      blockNumber: receipt.blockNumber?.toString(),
      events
    };
    report.stateAfter = stateAfter;

    if (options.verbose) {
      report.debug = {
        ...(report.debug ?? {}),
        receiptLogsCount: receipt.logs.length
      };
    }

    await outputReport(report, options);
    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Collect failed", { error: formatError(err) });
    throw err;
  }
};
