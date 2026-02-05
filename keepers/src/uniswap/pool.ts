import { Pool } from "@uniswap/v4-sdk";
import { Token } from "@uniswap/sdk-core";
import { PublicClient, encodeAbiParameters, keccak256 } from "viem";
import { positionManagerAbi } from "../abi/PositionManager";
import { stateViewAbi } from "../abi/StateView";
import { Address, Hex, PoolKey } from "../types";
import { KeeperError } from "../utils/errors";

export const getPoolKeyFromPosition = async (
  publicClient: PublicClient,
  positionManager: Address,
  tokenId: bigint
): Promise<PoolKey> => {
  const result = (await publicClient.readContract({
    address: positionManager,
    abi: positionManagerAbi,
    functionName: "getPoolAndPositionInfo",
    args: [tokenId]
  })) as unknown as [PoolKey, Hex];

  return {
    currency0: result[0].currency0,
    currency1: result[0].currency1,
    fee: Number(result[0].fee),
    tickSpacing: Number(result[0].tickSpacing),
    hooks: result[0].hooks
  };
};

export const derivePoolId = (poolKey: PoolKey): Hex => {
  return keccak256(
    encodeAbiParameters(
      [
        { name: "currency0", type: "address" },
        { name: "currency1", type: "address" },
        { name: "fee", type: "uint24" },
        { name: "tickSpacing", type: "int24" },
        { name: "hooks", type: "address" }
      ],
      [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
    )
  ) as Hex;
};

export const buildPoolKey = (token0: Token, token1: Token, fee: number, tickSpacing: number, hooks: Address) => {
  return Pool.getPoolKey(token0, token1, fee, tickSpacing, hooks) as PoolKey;
};

export const buildPoolFromState = async (
  publicClient: PublicClient,
  stateViewAddress: Address,
  poolKey: PoolKey,
  token0: Token,
  token1: Token,
  poolIdOverride?: Hex
): Promise<{ pool: Pool; poolId: Hex; tickCurrent: number; sqrtPriceX96: bigint; liquidity: bigint }> => {
  const poolId = poolIdOverride ?? derivePoolId(poolKey);

  const [slot0, liquidityRaw] = await Promise.all([
    publicClient.readContract({
      address: stateViewAddress,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId]
    }),
    publicClient.readContract({
      address: stateViewAddress,
      abi: stateViewAbi,
      functionName: "getLiquidity",
      args: [poolId]
    })
  ]);

  const sqrtPriceX96 = slot0[0] as bigint;
  const tickCurrent = Number(slot0[1]);
  const liquidity = liquidityRaw as bigint;

  if (!Number.isFinite(tickCurrent)) {
    throw new KeeperError("Invalid tick from StateView");
  }

  const pool = new Pool(
    token0,
    token1,
    poolKey.fee,
    poolKey.tickSpacing,
    poolKey.hooks,
    sqrtPriceX96.toString(),
    liquidity.toString(),
    tickCurrent,
    []
  );

  return { pool, poolId, tickCurrent, sqrtPriceX96, liquidity };
};

export const getPoolSlot0 = async (
  publicClient: PublicClient,
  stateViewAddress: Address,
  poolKey: PoolKey,
  token0: Token,
  token1: Token,
  poolIdOverride?: Hex
): Promise<{ poolId: Hex; tickCurrent: number; sqrtPriceX96: bigint }> => {
  const poolId = poolIdOverride ?? derivePoolId(poolKey);
  const slot0 = await publicClient.readContract({
    address: stateViewAddress,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId]
  });

  const sqrtPriceX96 = slot0[0] as bigint;
  const tickCurrent = Number(slot0[1]);

  if (!Number.isFinite(tickCurrent)) {
    throw new KeeperError("Invalid tick from StateView");
  }

  return { poolId, tickCurrent, sqrtPriceX96 };
};
