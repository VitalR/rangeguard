import assert from "node:assert/strict";
import { formatUnits, parseUnits } from "viem";
import { applyBpsBuffer, formatQuotePrice, quoteExactInputSingle } from "../uniswap/quoter";
import { PoolKey } from "../types";

const mockClient = {
  readContract: async () => [500000000000000000n, 123n]
};

const poolKey: PoolKey = {
  currency0: "0x0000000000000000000000000000000000000001",
  currency1: "0x0000000000000000000000000000000000000002",
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000"
};

{
  const amount0 = parseUnits("10", 6);
  assert.equal(amount0.toString(), "10000000");
  const amount1 = parseUnits("0.05", 18);
  assert.equal(formatUnits(amount1, 18), "0.05");
}

{
  const buffered = applyBpsBuffer(100n, 200);
  assert.equal(buffered.toString(), "102");
}

{
  const amountOut = await quoteExactInputSingle(mockClient as never, {
    quoter: "0x0000000000000000000000000000000000000009",
    poolKey,
    zeroForOne: true,
    exactAmount: 1000n,
    hookData: "0x"
  });
  assert.equal(amountOut.toString(), "500000000000000000");
  const price = formatQuotePrice(1000n, amountOut, 6, 18);
  assert.ok(price.length > 0);
}

console.log("quote.test.ts OK");
