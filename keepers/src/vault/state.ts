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
import { isPoolInitialized } from "../uniswap/poolState";

export type PositionSnapshot = {
  initialized: boolean;
  positionId: bigint;
  lower: number;
  upper: number;
  spacing: number;
};

export type VaultContext = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  token0Decimals: number;
  token1Decimals: number;
  keeper: `0x${string}`;
  positionManager: `0x${string}`;
  positionIds: bigint[];
  position?: PositionSnapshot;
};

export const fetchVaultState = async (
  config: KeeperConfig,
  publicClient: any,
  account?: { address: string },
  positionId?: bigint
): Promise<{ state: VaultState; context: VaultContext }> => {
  const [
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    keeper,
    positionManager,
    positionIds
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
      functionName: "getPositionIds"
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

  let selectedId: bigint | undefined = positionId;
  if (selectedId === undefined && (positionIds as bigint[]).length === 1) {
    selectedId = (positionIds as bigint[])[0];
  }

  let selectedPosition: PositionSnapshot | undefined;
  if (selectedId !== undefined) {
    const ticks = await publicClient.readContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "ticks",
      args: [selectedId]
    });
    const initialized = await publicClient.readContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "isPositionInitialized",
      args: [selectedId]
    });
    selectedPosition = {
      initialized: Boolean(initialized),
      positionId: selectedId,
      lower: Number(ticks[0]),
      upper: Number(ticks[1]),
      spacing: Number(ticks[2])
    };
  }

  const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
  const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));

  let currentTick: number | null = null;
  let poolId: string | null = null;
  let sqrtPriceX96: bigint | null = null;
  const hooks = config.poolHooks ?? zeroAddress;
  const fee = config.poolFee;
  const tickSpacing = config.poolTickSpacing;

  if (selectedPosition?.initialized) {
    const positionManagerAddress = config.positionManagerAddress ?? positionManager;
    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, selectedPosition.positionId);
    const poolState = await getPoolSlot0(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency
    );
    currentTick = poolState.tickCurrent;
    poolId = poolState.poolId;
    sqrtPriceX96 = poolState.sqrtPriceX96;
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
    sqrtPriceX96 = poolState.sqrtPriceX96;
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
    currentTick !== null && selectedPosition?.initialized
      ? currentTick > selectedPosition.lower && currentTick < selectedPosition.upper
      : null;
  const outOfRange =
    currentTick !== null && selectedPosition?.initialized
      ? currentTick <= selectedPosition.lower || currentTick >= selectedPosition.upper
      : null;
  const nearEdge =
    currentTick !== null && selectedPosition?.initialized
      ? currentTick <= selectedPosition.lower + edgeThresholdTicks ||
        currentTick >= selectedPosition.upper - edgeThresholdTicks
      : null;

  let healthBps: number | null = null;
  const width =
    selectedPosition && selectedPosition.initialized
      ? selectedPosition.upper - selectedPosition.lower
      : 0;
  if (currentTick !== null && selectedPosition?.initialized && width > 0) {
    if (currentTick <= selectedPosition.lower || currentTick >= selectedPosition.upper) {
      healthBps = 0;
    } else {
      const distance = Math.min(
        currentTick - selectedPosition.lower,
        selectedPosition.upper - currentTick
      );
      healthBps = Math.max(0, Math.min(10_000, Math.floor((distance * 10_000) / width)));
    }
  }

  if (currentTick !== null && selectedPosition?.spacing && selectedPosition.spacing > 0) {
    try {
      centerRange(currentTick, widthTicks, selectedPosition.spacing);
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
    position: selectedPosition
      ? {
          initialized: selectedPosition.initialized,
          positionId: selectedPosition.positionId.toString(),
          lower: selectedPosition.lower,
          upper: selectedPosition.upper,
          spacing: selectedPosition.spacing
        }
      : null,
    positions: positionIds.map((id: bigint) => {
      return {
        initialized: true,
        positionId: id.toString()
      };
    }),
    pool: {
      poolId,
      tick: currentTick,
      sqrtPriceX96: sqrtPriceX96 ? sqrtPriceX96.toString() : null
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
    positionIds: positionIds as bigint[],
    position: selectedPosition
  };

  return { state, context };
};
