import { Token } from "@uniswap/sdk-core";
import { keccak256, parseUnits } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { getPoolKeyFromPosition, buildPoolFromState } from "../uniswap/pool";
import { buildBurnPositionUnlockData } from "../uniswap/planner";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { parseVaultEvents } from "../vault/events";
import { fetchVaultState } from "../vault/state";
import { selectPositionId } from "../vault/positions";
import { positionManagerAbi } from "../abi/PositionManager";

type CloseOptions = {
  send?: boolean;
  force?: boolean;
  amount0Min?: string;
  amount1Min?: string;
  hookDataHex?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
  positionId?: string;
};

export const closePositionCommand = async (options: CloseOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const { positionId } = await selectPositionId(
      publicClient,
      config.vaultAddress,
      options.positionId
    );

    const [{ state: stateBefore, context }, maxSlippageBps] = await Promise.all([
      fetchVaultState(config, publicClient, account, positionId),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "maxSlippageBps"
      })
    ]);

    if (!context.position?.initialized) {
      throw new KeeperError("Vault position not initialized");
    }

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      throw new KeeperError("policy.maxSlippageBps exceeds vault maxSlippageBps");
    }

    const lower = Number(context.position.lower);
    const upper = Number(context.position.upper);

    const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;
    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);

    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const { poolId } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency,
      config.poolId
    );

    if (options.force) {
      logger.warn("Cooldown ignored due to --force", { action: "closePosition" });
    } else {
      await assertCooldown(config.policy, config.vaultAddress, "closePosition");
    }

    const amount0Min = options.amount0Min
      ? parseUnits(options.amount0Min, Number(context.token0Decimals))
      : 0n;
    const amount1Min = options.amount1Min
      ? parseUnits(options.amount1Min, Number(context.token1Decimals))
      : 0n;
    const hookDataRaw = options.hookDataHex ?? "0x";
    if (!/^0x[0-9a-fA-F]*$/.test(hookDataRaw)) {
      throw new KeeperError("hookDataHex must be hex");
    }
    const hookData = hookDataRaw as `0x${string}`;

    const unlockData = buildBurnPositionUnlockData({
      tokenId: positionId,
      amount0Min,
      amount1Min,
      hookData,
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      recipient: config.vaultAddress
    });

    const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
    const params = {
      positionId,
      deadline,
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
      throwOnMissing: false,
      willSetPermit2: true,
      maxApprove0: params.maxApprove0,
      maxApprove1: params.maxApprove1,
      deadline
    });

    const dryRun = !options.send;

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "closePosition",
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
      command: "closePosition",
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
        tickLower: lower,
        tickUpper: upper,
        amount0Min: amount0Min.toString(),
        amount1Min: amount1Min.toString()
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
    const positionIds = (await publicClient.readContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "getPositionIds"
    })) as bigint[];
    const vaultCleared = !positionIds.some((id) => id === positionId);
    let burned = false;
    try {
      await publicClient.readContract({
        address: positionManagerAddress,
        abi: positionManagerAbi,
        functionName: "ownerOf",
        args: [positionId]
      });
    } catch {
      burned = true;
    }

    report.tx = {
      dryRun: false,
      hash,
      blockNumber: receipt.blockNumber?.toString(),
      events,
      burned,
      vaultCleared
    };
    report.stateAfter = stateAfter;

    if (!vaultCleared) {
      report.warnings = [...(report.warnings ?? []), "Vault still tracks position after close"];
      logger.warn("Vault tracking still includes position", { positionId: positionId.toString() });
    }
    if (!burned) {
      report.warnings = [
        ...(report.warnings ?? []),
        "Position token still exists; burn may not have executed"
      ];
      logger.warn("Position token still exists after close", { positionId: positionId.toString() });
    }

    if (options.verbose) {
      report.debug = {
        ...(report.debug ?? {}),
        receiptLogsCount: receipt.logs.length
      };
    }

    await outputReport(report, options);
    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Close position failed", { error: formatError(err) });
    throw err;
  }
};
