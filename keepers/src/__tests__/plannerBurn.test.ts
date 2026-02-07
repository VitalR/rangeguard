import assert from "node:assert/strict";
import { decodeAbiParameters } from "viem";
import { buildBurnPositionUnlockData } from "../uniswap/planner";

const tokenId = 123n;
const amount0Min = 5n;
const amount1Min = 6n;
const hookData = "0x1234";
const currency0 = "0x0000000000000000000000000000000000000001";
const currency1 = "0x0000000000000000000000000000000000000002";
const recipient = "0x0000000000000000000000000000000000000003";

const unlockData = buildBurnPositionUnlockData({
  tokenId,
  amount0Min,
  amount1Min,
  hookData,
  currency0,
  currency1,
  recipient
});

const [actions, params] = decodeAbiParameters(
  [
    { name: "actions", type: "bytes" },
    { name: "params", type: "bytes[]" }
  ],
  unlockData
);

assert.equal(actions, "0x0311");
assert.equal(params.length, 2);

const [decodedTokenId, decodedAmount0Min, decodedAmount1Min, decodedHookData] = decodeAbiParameters(
  [
    { name: "tokenId", type: "uint256" },
    { name: "amount0Min", type: "uint128" },
    { name: "amount1Min", type: "uint128" },
    { name: "hookData", type: "bytes" }
  ],
  params[0]
);

assert.equal(decodedTokenId, tokenId);
assert.equal(decodedAmount0Min, amount0Min);
assert.equal(decodedAmount1Min, amount1Min);
assert.equal(decodedHookData, hookData);

const [decodedCurrency0, decodedCurrency1, decodedRecipient] = decodeAbiParameters(
  [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "recipient", type: "address" }
  ],
  params[1]
);

assert.equal(decodedCurrency0, currency0);
assert.equal(decodedCurrency1, currency1);
assert.equal(decodedRecipient, recipient);

console.log("plannerBurn.test.ts OK");
