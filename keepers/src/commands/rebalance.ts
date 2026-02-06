import { Token } from "@uniswap/sdk-core";
import { keccak256, toHex } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { stateViewAbi } from "../abi/StateView";
import { getPoolKeyFromPosition, buildPoolFromState } from "../uniswap/pool";
import { centerRange } from "../uniswap/ticks";
import { buildPositionFromAmounts, buildPositionFromLiquidity, slippagePercent } from "../uniswap/position";
import { buildRebalanceUnlockData } from "../uniswap/planner";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";
import { selectAmounts } from "../amounts";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { parseVaultEvents } from "../vault/events";
import { fetchVaultState } from "../vault/state";

type RebalanceOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
  maxSpendBps?: string;
  force?: boolean;
  dryPlan?: boolean;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const rebalanceCommand = async (options: RebalanceOptions = {}) => {
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

    if (!context.initialized) {
      throw new KeeperError("Vault position not initialized");
    }

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      throw new KeeperError("policy.maxSlippageBps exceeds vault maxSlippageBps");
    }

    const lower = Number(context.ticks[0]);
    const upper = Number(context.ticks[1]);
    const spacing = Number(context.ticks[2]);
    const positionId = context.ticks[3] as bigint;

    const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;
    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);

    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const { pool, poolId, tickCurrent } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency,
      config.poolId
    );

    const widthTicks = config.policy.widthTicks;
    const edgeThresholdTicks = Math.max(1, Math.floor((widthTicks * config.policy.edgeBps) / 10_000));
    const outOfRange = tickCurrent <= lower || tickCurrent >= upper;
    const nearEdge = tickCurrent <= lower + edgeThresholdTicks || tickCurrent >= upper - edgeThresholdTicks;

    const shouldRebalance =
      (config.policy.rebalanceIfOutOfRange && outOfRange) ||
      (config.policy.rebalanceIfNearEdge && nearEdge);

    const runId = createRunId();

    if (!options.force && !shouldRebalance) {
      const report: RunReport = {
        runId,
        command: "rebalance",
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
        decision: {
          action: "skip",
          reason: "Trigger conditions not met"
        },
        stateBefore
      };
      await outputReport(report, options);
      return;
    }

    try {
      await assertCooldown(config.policy, config.vaultAddress, "rebalance");
    } catch (err) {
      if (!options.force && err instanceof KeeperError) {
        const report: RunReport = {
          runId,
          command: "rebalance",
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
          decision: {
            action: "skip",
            reason: "Skipped due to cooldown"
          },
          stateBefore
        };
        await outputReport(report, options);
        return;
      }
      if (!options.force) {
        throw err;
      }
    }

    const { lower: newLower, upper: newUpper } = centerRange(tickCurrent, widthTicks, spacing);

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

    const newPosition = buildPositionFromAmounts({
      pool,
      tickLower: newLower,
      tickUpper: newUpper,
      amount0,
      amount1
    });

    const slippage = slippagePercent(config.policy.maxSlippageBps);
    const mintAmounts = newPosition.mintAmountsWithSlippage(slippage);
    const newLiquidity = toBigInt(newPosition.liquidity);
    const amount0Max = toBigInt(mintAmounts.amount0);
    const amount1Max = toBigInt(mintAmounts.amount1);

    const salt = toHex(positionId, { size: 32 });
    const oldInfo = await publicClient.readContract({
      address: config.stateViewAddress,
      abi: stateViewAbi,
      functionName: "getPositionInfo",
      args: [poolId, positionManagerAddress, lower, upper, salt]
    });
    const oldLiquidity = oldInfo[0] as bigint;

    const oldPosition = buildPositionFromLiquidity({
      pool,
      tickLower: lower,
      tickUpper: upper,
      liquidity: oldLiquidity
    });

    const burnAmounts = oldPosition.burnAmountsWithSlippage(slippage);
    const amount0Min = toBigInt(burnAmounts.amount0);
    const amount1Min = toBigInt(burnAmounts.amount1);

    const unlockData = buildRebalanceUnlockData({
      pool,
      oldTokenId: positionId,
      oldLiquidity,
      amount0Min,
      amount1Min,
      newTickLower: newLower,
      newTickUpper: newUpper,
      newLiquidity,
      amount0Max,
      amount1Max,
      owner: config.vaultAddress,
      hookData: config.policy.hookDataHex
    });

    const params = {
      newPositionId: 0n,
      newTickLower: newLower,
      newTickUpper: newUpper,
      deadline: deadlineFromNow(config.defaultDeadlineSeconds),
      unlockData,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      callValue: 0n
    };

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

    const dryRun = !options.send;

    if (options.dryPlan) {
      const report: RunReport = {
        runId,
        command: "rebalance",
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
        decision: { action: "execute", reason: "dryPlan" },
        stateBefore,
        plan: {
          tickLower: newLower,
          tickUpper: newUpper,
          tickSpacing: spacing,
          currentTick: tickCurrent,
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          bufferBps: options.bufferBps ? Number(options.bufferBps) : 200,
          maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : 10_000,
          quote: amountSelection.quote ?? null
        },
        warnings: amountSelection.warnings
      };
      await outputReport(report, options);
      return;
    }

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "rebalance",
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

    const report: RunReport = {
      runId,
      command: "rebalance",
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
        tickLower: newLower,
        tickUpper: newUpper,
        tickSpacing: spacing,
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
    logger.error("Rebalance failed", { error: formatError(err) });
    throw err;
  }
};
