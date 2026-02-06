import { Token } from "@uniswap/sdk-core";
import { zeroAddress } from "viem";
import { erc20Abi } from "../abi/ERC20";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { KeeperConfig } from "../types";
import { buildPoolKey, getPoolKeyFromPosition, getPoolSlot0 } from "../uniswap/pool";
import { centerRange } from "../uniswap/ticks";
import { formatError, invariant } from "../utils/errors";
import { logger } from "../logger";
import { VaultState } from "../report";

export type VaultContext = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  keeper: `0x${string}`;
  positionManager: `0x${string}`;
  ticks: readonly [bigint, bigint, bigint, bigint];
  initialized: boolean;
};

export const fetchVaultState = async (
  config: KeeperConfig,
  publicClient: any,
  account?: { address: string }
): Promise<{ state: VaultState; context: VaultContext }> => {
  const [
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    keeper,
    positionManager,
    ticks,
    initialized
  ] = await Promise.all([
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

  const [token0Balance, token1Balance, ethBalance] = await Promise.all([
    publicClient.readContract({
      address: token0,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [config.vaultAddress]
    }),
    publicClient.readContract({
      address: token1,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [config.vaultAddress]
    }),
    publicClient.getBalance({ address: config.vaultAddress })
  ]);

  if (account) {
    invariant(
      keeper.toLowerCase() === account.address.toLowerCase(),
      "Vault keeper does not match configured key",
      { keeper, configured: account.address }
    );
  }

  const lower = Number(ticks[0]);
  const upper = Number(ticks[1]);
  const spacing = Number(ticks[2]);
  const positionId = ticks[3] as bigint;

  const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
  const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));

  let currentTick: number | null = null;
  let poolId: string | null = null;
  const hooks = config.poolHooks ?? zeroAddress;
  const fee = config.poolFee;
  const tickSpacing = config.poolTickSpacing;

  if (initialized) {
    const positionManagerAddress = config.positionManagerAddress ?? positionManager;
    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);
    const poolState = await getPoolSlot0(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency
    );
    currentTick = poolState.tickCurrent;
    poolId = poolState.poolId;
  } else if (fee !== undefined && tickSpacing !== undefined) {
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
    const poolState = await getPoolSlot0(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency
    );
    currentTick = poolState.tickCurrent;
    poolId = poolState.poolId;
  }

  if (poolId && config.poolId && config.poolId !== poolId) {
    logger.warn("POOL_ID override does not match derived poolId", {
      derived: poolId,
      override: config.poolId
    });
  }

  const widthTicks = config.policy.widthTicks;
  const edgeThresholdTicks = Math.max(1, Math.floor((widthTicks * config.policy.edgeBps) / 10_000));

  const inRange =
    currentTick !== null && initialized ? currentTick > lower && currentTick < upper : null;
  const outOfRange =
    currentTick !== null && initialized ? currentTick <= lower || currentTick >= upper : null;
  const nearEdge =
    currentTick !== null && initialized
      ? currentTick <= lower + edgeThresholdTicks || currentTick >= upper - edgeThresholdTicks
      : null;

  let healthBps: number | null = null;
  const width = upper - lower;
  if (currentTick !== null && initialized && width > 0) {
    if (currentTick <= lower || currentTick >= upper) {
      healthBps = 0;
    } else {
      const distance = Math.min(currentTick - lower, upper - currentTick);
      healthBps = Math.max(0, Math.min(10_000, Math.floor((distance * 10_000) / width)));
    }
  }

  if (currentTick !== null && spacing > 0) {
    try {
      centerRange(currentTick, widthTicks, spacing);
    } catch (err) {
      logger.warn("Failed to compute suggested range", { error: formatError(err) });
    }
  }

  const state: VaultState = {
    balances: {
      token0: token0Balance,
      token1: token1Balance,
      eth: ethBalance
    },
    position: {
      initialized,
      positionId: positionId.toString(),
      lower,
      upper,
      spacing
    },
    pool: {
      poolId,
      tick: currentTick
    },
    inRange,
    outOfRange,
    nearEdge,
    healthBps
  };

  const context: VaultContext = {
    token0,
    token1,
    token0Decimals: Number(token0Decimals),
    token1Decimals: Number(token1Decimals),
    keeper,
    positionManager,
    ticks: ticks as readonly [bigint, bigint, bigint, bigint],
    initialized: Boolean(initialized)
  };

  return { state, context };
};
