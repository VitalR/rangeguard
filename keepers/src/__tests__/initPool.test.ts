import assert from "node:assert/strict";
import { resolveSqrtPriceX96 } from "../commands/initPool";

{
  const value = resolveSqrtPriceX96({ sqrtPriceX96: "0x10" });
  assert.equal(value, 16n);
}

{
  const value = resolveSqrtPriceX96({ priceUsdcPerWeth: "2000" });
  assert.ok(value > 0n);
}

console.log("initPool.test.ts OK");
