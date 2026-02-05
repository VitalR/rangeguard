import assert from "node:assert/strict";
import { computeRangeTicks } from "../uniswap/ticks";

const spacing = 60;
const widthTicks = 1200;

{
  const { lower, upper } = computeRangeTicks(12345, spacing, widthTicks);
  assert.equal(Math.abs(lower % spacing), 0, "lower should align to spacing");
  assert.equal(upper - lower, widthTicks, "width should match");
}

{
  const { lower, upper } = computeRangeTicks(-12345, spacing, widthTicks);
  assert.equal(Math.abs(lower % spacing), 0, "negative lower should align to spacing");
  assert.equal(upper - lower, widthTicks, "negative width should match");
}

assert.throws(() => computeRangeTicks(0, spacing, 1210), /multiple of tick spacing/);

console.log("ticks.test.ts OK");
