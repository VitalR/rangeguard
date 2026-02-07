import { Position, Pool } from "@uniswap/v4-sdk";
import { TickMath } from "@uniswap/v3-sdk";
import { Percent } from "@uniswap/sdk-core";
import { KeeperError } from "../utils/errors";
import type { BootstrapMode } from "./ticks";

const toBigintIsh = (value: bigint): string => value.toString();
const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());
const Q96 = 1n << 96n;
const ceilDiv = (num: bigint, den: bigint): bigint => {
  if (den === 0n) {
    throw new KeeperError("Division by zero");
  }
  return (num + den - 1n) / den;
};

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

export const buildPositionForMintWithMode = (params: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  mode: BootstrapMode;
  useFullPrecision?: boolean;
}) => {
  const { pool, tickLower, tickUpper, amount0, amount1, mode, useFullPrecision = true } = params;

  if (mode === "ABOVE_MAX") {
    if (amount1 <= 0n) {
      throw new KeeperError("Boundary ABOVE_MAX requires amount1 > 0");
    }
    return Position.fromAmount1({
      pool,
      tickLower,
      tickUpper,
      amount1: toBigintIsh(amount1)
    });
  }

  if (mode === "BELOW_MIN") {
    if (amount0 <= 0n) {
      throw new KeeperError("Boundary BELOW_MIN requires amount0 > 0");
    }
    return Position.fromAmount0({
      pool,
      tickLower,
      tickUpper,
      amount0: toBigintIsh(amount0),
      useFullPrecision
    });
  }

  return buildPositionFromAmounts({ pool, tickLower, tickUpper, amount0, amount1, useFullPrecision });
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

export const getSqrtRatioAtTick = (tick: number): bigint => toBigInt(TickMath.getSqrtRatioAtTick(tick));

export const getBoundarySqrtRatios = (tickLower: number, tickUpper: number) => {
  const sqrtLowerX96 = getSqrtRatioAtTick(tickLower);
  const sqrtUpperX96 = getSqrtRatioAtTick(tickUpper);
  if (sqrtUpperX96 <= sqrtLowerX96) {
    throw new KeeperError("Invalid sqrt ratio ordering for ticks", {
      tickLower,
      tickUpper
    });
  }
  const diff = sqrtUpperX96 - sqrtLowerX96;
  return { sqrtLowerX96, sqrtUpperX96, diff };
};

export const computeBoundaryLiquidity = (params: {
  tickLower: number;
  tickUpper: number;
  amount0: bigint;
  amount1: bigint;
  mode: BootstrapMode;
}): bigint => {
  const { tickLower, tickUpper, amount0, amount1, mode } = params;
  if (mode === "IN_RANGE") {
    throw new KeeperError("Boundary liquidity computation requires ABOVE_MAX or BELOW_MIN");
  }
  const { sqrtLowerX96, sqrtUpperX96, diff } = getBoundarySqrtRatios(tickLower, tickUpper);
  if (mode === "ABOVE_MAX") {
    if (amount1 <= 0n) {
      throw new KeeperError("Boundary ABOVE_MAX requires amount1 > 0");
    }
    return (amount1 * Q96) / diff;
  }
  if (amount0 <= 0n) {
    throw new KeeperError("Boundary BELOW_MIN requires amount0 > 0");
  }
  return (amount0 * sqrtLowerX96 * sqrtUpperX96) / (Q96 * diff);
};

export const computeBoundaryMinAmountForLiquidityOne = (params: {
  tickLower: number;
  tickUpper: number;
  mode: BootstrapMode;
}): bigint => {
  const { tickLower, tickUpper, mode } = params;
  if (mode === "IN_RANGE") {
    throw new KeeperError("Boundary min amount requires ABOVE_MAX or BELOW_MIN");
  }
  const { sqrtLowerX96, sqrtUpperX96, diff } = getBoundarySqrtRatios(tickLower, tickUpper);
  if (mode === "ABOVE_MAX") {
    return ceilDiv(diff, Q96);
  }
  const denom = sqrtLowerX96 * sqrtUpperX96;
  return ceilDiv(Q96 * diff, denom);
};

export const slippagePercent = (maxSlippageBps: number) => new Percent(maxSlippageBps, 10_000);
