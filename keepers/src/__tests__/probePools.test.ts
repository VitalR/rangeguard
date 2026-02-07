import assert from "node:assert/strict";
import { formatProbeTable, isNoDataError, readSlot0Safe } from "../commands/probePools";

{
  const err = new Error('The contract function "getSlot0" returned no data ("0x").');
  assert.ok(isNoDataError(err), "no-data error should be detected");
}

{
  const readContract = async () => {
    throw new Error('The contract function "getSlot0" returned no data ("0x").');
  };
  const result = await readSlot0Safe(
    readContract,
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000000"
  );
  assert.equal(result.status, "no-data");
}

{
  const table = formatProbeTable([
    {
      fee: 3000,
      tickSpacing: 60,
      hooks: "0x0000000000000000000000000000000000000000",
      poolId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      status: "initialized",
      tick: 123,
      nearBounds: false
    }
  ]);
  assert.ok(table.includes("fee"), "table should include headers");
  assert.ok(table.includes("initialized"), "table should include status");
}

console.log("probePools.test.ts OK");
