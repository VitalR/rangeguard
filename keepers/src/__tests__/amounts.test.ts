import assert from "node:assert/strict";
import { selectAmounts } from "../amounts";
import { Address, PoolKey } from "../types";

const poolKey: PoolKey = {
  currency0: "0x0000000000000000000000000000000000000001",
  currency1: "0x0000000000000000000000000000000000000002",
  fee: 3000,
  tickSpacing: 60,
  hooks: "0x0000000000000000000000000000000000000000"
};

const mockQuote = async ({ exactAmount }: { exactAmount: bigint }) => exactAmount * 2n;

const baseParams = {
  publicClient: {} as never,
  poolKey,
  token0: poolKey.currency0,
  token1: poolKey.currency1,
  token0Decimals: 6,
  token1Decimals: 6,
  balance0: 1_000_000_000n,
  balance1: 1_000_000_000n,
  useFullBalances: false,
  quoterAddress: "0x0000000000000000000000000000000000000009" as Address,
  hookData: "0x" as `0x${string}`,
  bufferBps: 200,
  maxSpendBps: 10_000,
  quoteFn: async (params: any) => mockQuote(params)
};

{
  const result = await selectAmounts({
    ...baseParams,
    amount0Input: "10"
  });
  assert.equal(result.derived, true, "token0-only should derive token1");
  assert.ok(result.amount1 > 0n, "derived token1 should be > 0");
}

{
  const result = await selectAmounts({
    ...baseParams,
    amount1Input: "10"
  });
  assert.equal(result.derived, true, "token1-only should derive token0");
  assert.ok(result.amount0 > 0n, "derived token0 should be > 0");
}

{
  const result = await selectAmounts({
    ...baseParams,
    balance1: 1_000n,
    amount0Input: "10"
  });
  assert.equal(result.scaled, true, "should scale amount0 to fit token1 balance");
  assert.ok(result.amount1 <= 1_000n, "scaled amount1 should fit balance");
}

console.log("amounts.test.ts OK");
