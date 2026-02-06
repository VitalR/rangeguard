import assert from "node:assert/strict";
import { Token } from "@uniswap/sdk-core";
import { Pool } from "@uniswap/v4-sdk";
import { buildBootstrapUnlockData } from "../uniswap/planner";
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
  const { lower, upper } = computeBootstrapTicks(599, spacing, widthTicks);
  assert.equal(Math.abs(lower % spacing), 0, "bootstrap lower should align");
  assert.equal(Math.abs(upper % spacing), 0, "bootstrap upper should align");
  assert.ok(lower <= 599 && 599 < upper, "bootstrap range should include current tick");
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

console.log("ticks.test.ts OK");
