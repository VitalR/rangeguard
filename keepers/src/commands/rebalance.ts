import { Token } from "@uniswap/sdk-core";
import { keccak256, parseUnits, toHex } from "viem";
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

type RebalanceOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const rebalanceCommand = async (options: RebalanceOptions) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [token0, token1, token0Decimals, token1Decimals, keeper, maxSlippageBps, positionManager, ticks, initialized] =
      await Promise.all([
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "token0"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "token1"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "token0Decimals"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "token1Decimals"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "keeper"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "maxSlippageBps"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "positionManager"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "ticks"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "isPositionInitialized"
        })
      ]);

    if (!initialized) {
      throw new KeeperError("Vault position not initialized");
    }

    invariant(
      keeper.toLowerCase() === account.address.toLowerCase(),
      "Vault keeper does not match configured key",
      { keeper, configured: account.address }
    );

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      throw new KeeperError("policy.maxSlippageBps exceeds vault maxSlippageBps");
    }

    const lower = Number(ticks[0]);
    const upper = Number(ticks[1]);
    const spacing = Number(ticks[2]);
    const positionId = ticks[3] as bigint;

    const positionManagerAddress = config.positionManagerAddress ?? positionManager;
    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);

    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
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

    if (!shouldRebalance) {
      logger.info("Rebalance not needed", { tickCurrent, lower, upper, outOfRange, nearEdge });
      return;
    }

    await assertCooldown(config.policy, config.vaultAddress, "rebalance");

    const { lower: newLower, upper: newUpper } = centerRange(tickCurrent, widthTicks, spacing);

    const [balance0, balance1] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token0]
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token1]
      })
    ]);

    let amount0 = balance0 as bigint;
    let amount1 = balance1 as bigint;
    if (!config.policy.useFullBalances) {
      if (!options.amount0 || !options.amount1) {
        throw new KeeperError("Provide --amount0 and --amount1 when useFullBalances=false");
      }
      amount0 = parseUnits(options.amount0, Number(token0Decimals));
      amount1 = parseUnits(options.amount1, Number(token1Decimals));
    }

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
      token0,
      token1,
      required0: amount0Max,
      required1: amount1Max,
      throwOnMissing: false
    });

    const dryRun = !options.send;
    logger.info(dryRun ? "Dry run: rebalance" : "Sending rebalance", {
      unlockDataHash: keccak256(unlockData),
      params
    });

    if (dryRun) {
      return;
    }

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "rebalance",
      args: [params],
      account: account.address
    });

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    logger.info("Rebalance tx sent", { hash });
    await publicClient.waitForTransactionReceipt({ hash });

    const updatedTicks = await publicClient.readContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "ticks"
    });

    logger.info("Rebalance complete", {
      positionId: updatedTicks[3].toString(),
      lower: Number(updatedTicks[0]),
      upper: Number(updatedTicks[1]),
      spacing: Number(updatedTicks[2])
    });

    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Rebalance failed", { error: formatError(err) });
    throw err;
  }
};
