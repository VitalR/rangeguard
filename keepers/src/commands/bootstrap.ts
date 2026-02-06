import { Token } from "@uniswap/sdk-core";
import { keccak256, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey, buildPoolFromState } from "../uniswap/pool";
import { computeBootstrapTicks } from "../uniswap/ticks";
import { buildPositionFromAmounts } from "../uniswap/position";
import { buildBootstrapUnlockData } from "../uniswap/planner";
import { decodeUniswapError, extractRevertData, getRevertHint } from "../uniswap/errorDecoder";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";
import { selectAmounts } from "../amounts";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { parseVaultEvents } from "../vault/events";
import { fetchVaultState } from "../vault/state";

type BootstrapOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
  maxSpendBps?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const bootstrapCommand = async (options: BootstrapOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [{ state: stateBefore, context }, maxSlippageBps] = await Promise.all([
      fetchVaultState(config, publicClient, account),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "maxSlippageBps"
      })
    ]);

    if (context.initialized) {
      throw new KeeperError("Vault position already initialized");
    }

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      throw new KeeperError("policy.maxSlippageBps exceeds vault maxSlippageBps");
    }

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? zeroAddress;
    if (fee === undefined || tickSpacing === undefined) {
      throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for bootstrap");
    }

    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);

    const { pool, poolId, tickCurrent } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      {
        currency0: context.token0,
        currency1: context.token1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks as `0x${string}`
      },
      token0Currency,
      token1Currency,
      config.poolId
    );

    const { lower, upper } = computeBootstrapTicks(tickCurrent, tickSpacing, config.policy.widthTicks);

    await assertCooldown(config.policy, config.vaultAddress, "bootstrap");

    const amountSelection = await selectAmounts({
      publicClient,
      poolKey,
      token0: context.token0,
      token1: context.token1,
      token0Decimals: context.token0Decimals,
      token1Decimals: context.token1Decimals,
      balance0: stateBefore.balances.token0,
      balance1: stateBefore.balances.token1,
      amount0Input: options.amount0,
      amount1Input: options.amount1,
      useFullBalances: config.policy.useFullBalances,
      quoterAddress: config.quoterAddress,
      hookData: config.policy.hookDataHex,
      bufferBps: options.bufferBps ? Number(options.bufferBps) : undefined,
      maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : undefined
    });

    const amount0 = amountSelection.amount0;
    const amount1 = amountSelection.amount1;

    if (lower <= tickCurrent && tickCurrent < upper) {
      if (amount0 <= 0n || amount1 <= 0n) {
        throw new KeeperError(
          "Range includes current tick; both token balances must be > 0. Deposit WETH to the vault and retry.",
          { amount0, amount1 }
        );
      }
    }

    const position = buildPositionFromAmounts({
      pool,
      tickLower: lower,
      tickUpper: upper,
      amount0,
      amount1
    });

    const liquidity = toBigInt(position.liquidity);
    const amount0Max = amount0;
    const amount1Max = amount1;

    const unlockData = buildBootstrapUnlockData({
      pool,
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      amount0Max,
      amount1Max,
      owner: config.vaultAddress,
      hookData: config.policy.hookDataHex
    });

    if (unlockData === "0x") {
      throw new KeeperError("Unlock data is empty");
    }

    const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;
    await checkPermit2Allowances({
      publicClient,
      vault: config.vaultAddress,
      positionManager: positionManagerAddress,
      token0: context.token0,
      token1: context.token1,
      required0: amount0Max,
      required1: amount1Max,
      throwOnMissing: false
    });

    const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
    const params = {
      tickLower: lower,
      tickUpper: upper,
      tickSpacing,
      deadline,
      unlockData,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      callValue: 0n
    };

    const expectedTokenId = (await publicClient.readContract({
      address: positionManagerAddress,
      abi: [
        {
          type: "function",
          name: "nextTokenId",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }]
        }
      ],
      functionName: "nextTokenId"
    })) as bigint;

    const dryRun = !options.send;
    const unlockDataLength = (unlockData.length - 2) / 2;

    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "bootstrapPosition",
        args: [params],
        account: account.address
      });
    } catch (err) {
      const revertData = extractRevertData(err);
      const decoded = revertData ? decodeUniswapError(revertData) : null;
      if (decoded) {
        logger.error("Bootstrap revert decoded", {
          selector: decoded.selector,
          error: decoded.name,
          args: decoded.args,
          hint: getRevertHint(decoded.name)
        });
      } else if (revertData) {
        logger.error("Bootstrap revert selector", { selector: revertData.slice(0, 10) });
      }
      throw err;
    }

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
      command: "bootstrap",
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
        tickLower: lower,
        tickUpper: upper,
        tickSpacing,
        currentTick: tickCurrent,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        bufferBps: options.bufferBps ? Number(options.bufferBps) : 200,
        maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : 10_000,
        quote: amountSelection.quote ?? null
      },
      warnings: amountSelection.warnings
    };

    if (options.verbose) {
      const calldata = (simulation.request as { data?: `0x${string}` }).data;
      report.debug = {
        unlockDataHash: keccak256(unlockData),
        unlockDataLength,
        calldataHash: hashCalldata(calldata),
        gasEstimate: gasEstimate?.toString()
      };
    }

    if (dryRun) {
      report.tx = {
        dryRun: true,
        expectedTokenId: expectedTokenId.toString()
      };
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
    logger.error("Bootstrap failed", { error: formatError(err) });
    throw err;
  }
};
