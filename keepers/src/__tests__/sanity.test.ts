import assert from "node:assert/strict";
import { assertTickNotNearBounds, isTickNearBounds } from "../uniswap/sanity";

{
  assert.ok(isTickNearBounds(887271), "tick near bounds should be flagged");
  assert.ok(!isTickNearBounds(599), "normal tick should be ok");
}

assert.throws(() => assertTickNotNearBounds(887271), /Pool tick is near global bounds/);

console.log("sanity.test.ts OK");
