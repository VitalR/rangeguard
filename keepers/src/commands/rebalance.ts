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
import { selectPositionId } from "../vault/positions";
import { assertTickNotNearBounds } from "../uniswap/sanity";

type RebalanceOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
  maxSpendBps?: string;
  force?: boolean;
  dryPlan?: boolean;
  widthTicks?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
  positionId?: string;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const rebalanceCommand = async (options: RebalanceOptions = {}) => {
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
    const spacing = Number(context.position.spacing);

    const widthTicks =
      options.widthTicks !== undefined ? Number(options.widthTicks) : config.policy.widthTicks;
    if (!Number.isFinite(widthTicks) || widthTicks <= 0 || !Number.isInteger(widthTicks)) {
      throw new KeeperError("widthTicks must be a positive integer");
    }
    if (widthTicks % (2 * spacing) !== 0) {
      throw new KeeperError("widthTicks/2 must align to tick spacing");
    }
    const policy = { ...config.policy, widthTicks };

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
    assertTickNotNearBounds(tickCurrent);

    const edgeThresholdTicks = Math.max(1, Math.floor((widthTicks * policy.edgeBps) / 10_000));
    const outOfRange = tickCurrent <= lower || tickCurrent >= upper;
    const nearEdge = tickCurrent <= lower + edgeThresholdTicks || tickCurrent >= upper - edgeThresholdTicks;

    const shouldRebalance =
      (policy.rebalanceIfOutOfRange && outOfRange) || (policy.rebalanceIfNearEdge && nearEdge);

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
        policy,
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
          policy,
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

    const usedFallbackBalances = !policy.useFullBalances && !options.amount0 && !options.amount1;
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
      useFullBalances: policy.useFullBalances || usedFallbackBalances,
      quoterAddress: config.quoterAddress,
      hookData: policy.hookDataHex,
      bufferBps: options.bufferBps ? Number(options.bufferBps) : undefined,
      maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : undefined
    });
    const amountWarnings = [...amountSelection.warnings];
    if (usedFallbackBalances) {
      amountWarnings.unshift("useFullBalances=false but no amounts provided; using full balances");
    }

    const amount0 = amountSelection.amount0;
    const amount1 = amountSelection.amount1;

    if (newLower <= tickCurrent && tickCurrent < newUpper) {
      if (amount0 <= 0n || amount1 <= 0n) {
        throw new KeeperError(
          "Rebalance range includes current tick; both token balances must be > 0. Deposit token0/token1 and retry.",
          { amount0, amount1 }
        );
      }
    }

    const newPosition = buildPositionFromAmounts({
      pool,
      tickLower: newLower,
      tickUpper: newUpper,
      amount0,
      amount1
    });

    const slippage = slippagePercent(policy.maxSlippageBps);
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
      poolKey,
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
      hookData: policy.hookDataHex
    });

    const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
    const params = {
      positionId,
      newPositionId: 0n,
      newTickLower: newLower,
      newTickUpper: newUpper,
      deadline,
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
      throwOnMissing: false,
      willSetPermit2: true,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      deadline
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
        policy,
        decision: { action: "execute", reason: "dryPlan" },
        stateBefore,
      plan: {
        positionId: positionId.toString(),
        tickLower: newLower,
        tickUpper: newUpper,
        tickSpacing: spacing,
        currentTick: tickCurrent,
        widthTicks,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        bufferBps: options.bufferBps ? Number(options.bufferBps) : 200,
        maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : 10_000,
        quote: amountSelection.quote ?? null
      },
        warnings: amountWarnings
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
      policy,
      decision: { action: "execute", reason: dryRun ? "dry-run" : "send" },
      stateBefore,
      plan: {
        positionId: positionId.toString(),
        tickLower: newLower,
        tickUpper: newUpper,
        tickSpacing: spacing,
        currentTick: tickCurrent,
        widthTicks,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        bufferBps: options.bufferBps ? Number(options.bufferBps) : 200,
        maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : 10_000,
        quote: amountSelection.quote ?? null
      },
      warnings: amountWarnings
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
