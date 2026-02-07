import assert from "node:assert/strict";
import { Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v4-sdk";
import { buildBootstrapUnlockData, buildCloseUnlockData } from "../uniswap/planner";
import { computeBoundaryLiquidity, computeBoundaryMinAmountForLiquidityOne, getSqrtRatioAtTick } from "../uniswap/position";
import { alignDown, alignUp, computeBootstrapTicks, computeRangeTicks } from "../uniswap/ticks";

const spacing = 60;
const widthTicks = 1200;

{
  assert.equal(alignDown(123, spacing), 120, "alignDown should floor");
  assert.equal(alignUp(123, spacing), 180, "alignUp should ceil");
  assert.equal(alignDown(-123, spacing), -180, "alignDown should floor negatives");
  assert.equal(alignUp(-123, spacing), -120, "alignUp should ceil negatives");
}

{
  const { lower, upper, mode } = computeBootstrapTicks(599, spacing, widthTicks);
  assert.equal(Math.abs(lower % spacing), 0, "bootstrap lower should align");
  assert.equal(Math.abs(upper % spacing), 0, "bootstrap upper should align");
  assert.ok(lower <= 599 && 599 < upper, "bootstrap range should include current tick");
  assert.equal(mode, "IN_RANGE", "bootstrap mode should be IN_RANGE");
}

{
  const nearMaxTick = 887271;
  const { lower, upper, mode, maxAligned, minAligned } = computeBootstrapTicks(nearMaxTick, spacing, widthTicks);
  assert.equal(maxAligned, 887220, "maxAligned should clamp to max aligned tick");
  assert.equal(minAligned, -887220, "minAligned should clamp to min aligned tick");
  assert.equal(lower, 886020, "bootstrap lower should pin to boundary");
  assert.equal(upper, 887220, "bootstrap upper should pin to boundary");
  assert.equal(mode, "ABOVE_MAX", "bootstrap mode should be ABOVE_MAX");
}

{
  const { lower, upper } = computeRangeTicks(12345, spacing, widthTicks);
  assert.equal(Math.abs(lower % spacing), 0, "lower should align to spacing");
  assert.equal(upper - lower, widthTicks, "width should match");
}

assert.throws(() => computeRangeTicks(0, spacing, 1210), /multiple of tick spacing/);

{
  const token0 = new Token(11155111, "0x0000000000000000000000000000000000000001", 6);
  const token1 = new Token(11155111, "0x0000000000000000000000000000000000000002", 18);
  const pool = new Pool(
    token0,
    token1,
    3000,
    60,
    "0x0000000000000000000000000000000000000000",
    "79228162514264337593543950336",
    "1",
    0,
    []
  );
  const unlockData = buildBootstrapUnlockData({
    pool,
    tickLower: -60,
    tickUpper: 120,
    liquidity: 1n,
    amount0Max: 1n,
    amount1Max: 1n,
    owner: "0x0000000000000000000000000000000000000003"
  });
  assert.ok(unlockData !== "0x", "unlockData should not be empty");
}

{
  const token0 = new Token(11155111, "0x0000000000000000000000000000000000000001", 6);
  const token1 = new Token(11155111, "0x0000000000000000000000000000000000000002", 18);
  const pool = new Pool(
    token0,
    token1,
    3000,
    60,
    "0x0000000000000000000000000000000000000000",
    "79228162514264337593543950336",
    "1",
    0,
    []
  );
  const unlockData = buildCloseUnlockData({
    tokenId: 1n,
    liquidity: 1n,
    amount0Min: 0n,
    amount1Min: 0n,
    currency0: pool.currency0,
    currency1: pool.currency1,
    recipient: "0x0000000000000000000000000000000000000003"
  });
  assert.ok(unlockData !== "0x", "close unlockData should not be empty");
}

{
  const sqrtLowerX96 = getSqrtRatioAtTick(886020);
  const sqrtUpperX96 = getSqrtRatioAtTick(887220);
  const diff = sqrtUpperX96 - sqrtLowerX96;
  const amount1 = 49_999_999_986_101_543n;
  const minAmount1 = computeBoundaryMinAmountForLiquidityOne({
    tickLower: 886020,
    tickUpper: 887220,
    mode: "ABOVE_MAX"
  });
  const liquidity = computeBoundaryLiquidity({
    tickLower: 886020,
    tickUpper: 887220,
    amount0: 0n,
    amount1: minAmount1,
    mode: "ABOVE_MAX"
  });
  assert.ok(diff > 0n, "sqrt diff should be non-zero");
  assert.ok(minAmount1 > amount1, "min amount1 should exceed derived amount");
  assert.ok(liquidity > 0n, "ABOVE_MAX mode should mint non-zero liquidity from amount1");
}

console.log("ticks.test.ts OK");
