import assert from "node:assert/strict";
import { selectPositionId } from "../vault/positions";

const makeClient = (ids: bigint[]) => ({
  readContract: async () => ids
});

{
  const { positionId, positionIds } = await selectPositionId(
    makeClient([1n]) as never,
    "0x0000000000000000000000000000000000000001",
    undefined
  );
  assert.equal(positionId, 1n);
  assert.equal(positionIds.length, 1);
}

{
  const { positionId } = await selectPositionId(
    makeClient([1n, 2n]) as never,
    "0x0000000000000000000000000000000000000001",
    "2"
  );
  assert.equal(positionId, 2n);
}

{
  let threw = false;
  try {
    await selectPositionId(makeClient([1n, 2n]) as never, "0x0000000000000000000000000000000000000001");
  } catch {
    threw = true;
  }
  assert.equal(threw, true, "should require positionId when multiple positions exist");
}

console.log("positions.test.ts OK");
