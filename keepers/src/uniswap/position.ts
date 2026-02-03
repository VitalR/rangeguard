import { Position, Pool } from "@uniswap/v4-sdk";
import { Percent } from "@uniswap/sdk-core";
import { KeeperError } from "../utils/errors";

const toBigintIsh = (value: bigint): string => value.toString();

export const buildPositionFromAmounts = (params: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  useFullPrecision?: boolean;
}) => {
  const { pool, tickLower, tickUpper, amount0, amount1, useFullPrecision = true } = params;

  if (amount0 > 0n && amount1 > 0n) {
    return Position.fromAmounts({
      pool,
      tickLower,
      tickUpper,
      amount0: toBigintIsh(amount0),
      amount1: toBigintIsh(amount1),
      useFullPrecision
    });
  }
  if (amount0 > 0n) {
    return Position.fromAmount0({
      pool,
      tickLower,
      tickUpper,
      amount0: toBigintIsh(amount0),
      useFullPrecision
    });
  }
  if (amount1 > 0n) {
    return Position.fromAmount1({
      pool,
      tickLower,
      tickUpper,
      amount1: toBigintIsh(amount1)
    });
  }
  throw new KeeperError("Both amount0 and amount1 are zero");
};

export const buildPositionFromLiquidity = (params: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}) => {
  const { pool, tickLower, tickUpper, liquidity } = params;
  return new Position({ pool, tickLower, tickUpper, liquidity: toBigintIsh(liquidity) });
};

export const slippagePercent = (maxSlippageBps: number) => new Percent(maxSlippageBps, 10_000);
