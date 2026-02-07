import assert from "node:assert/strict";
import { isPoolInitialized } from "../uniswap/poolState";

{
  const ok = isPoolInitialized({ sqrtPriceX96: 1n, tick: 599 });
  assert.equal(ok.initialized, true);
}

{
  const bad = isPoolInitialized({ sqrtPriceX96: 1n, tick: 887271 });
  assert.equal(bad.initialized, false);
}

{
  const bad = isPoolInitialized({ sqrtPriceX96: 1n, tick: -887271 });
  assert.equal(bad.initialized, false);
}

{
  const bad = isPoolInitialized({ sqrtPriceX96: 0n, tick: 0 });
  assert.equal(bad.initialized, false);
}

console.log("poolState.test.ts OK");
