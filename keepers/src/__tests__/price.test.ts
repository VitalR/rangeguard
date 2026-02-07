import assert from "node:assert/strict";
import { encodeSqrtRatioX96, computeSqrtPriceFromUsdcPerWeth, parseSqrtPriceX96, isUint160 } from "../uniswap/price";

{
  const sqrt = encodeSqrtRatioX96(10n ** 18n, 2000n * 10n ** 6n);
  assert.ok(sqrt > 0n);
  assert.equal(isUint160(sqrt), true);
}

{
  const sqrt = computeSqrtPriceFromUsdcPerWeth(2000);
  assert.ok(sqrt > 0n);
  assert.equal(isUint160(sqrt), true);
}

{
  const hex = parseSqrtPriceX96("0x10");
  assert.equal(hex, 16n);
  const dec = parseSqrtPriceX96("42");
  assert.equal(dec, 42n);
}

console.log("price.test.ts OK");
