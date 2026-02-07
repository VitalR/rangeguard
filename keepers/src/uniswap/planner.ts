import { V4PositionPlanner, Pool } from "@uniswap/v4-sdk";
import { encodeAbiParameters } from "viem";
import { Address, Hex } from "../types";
import { KeeperError } from "../utils/errors";

const toBigintIsh = (value: bigint): string => value.toString();
const MAX_UINT128 = (1n << 128n) - 1n;
const ACTIONS = {
  DECREASE_LIQUIDITY: 0x01,
  MINT_POSITION: 0x02,
  BURN_POSITION: 0x03,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12
} as const;

export const buildBootstrapUnlockData = (params: {
  pool: Pool;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
  hookData?: Hex;
}): Hex => {
  const planner = new V4PositionPlanner();
  planner.addMint(
    params.pool,
    params.tickLower,
    params.tickUpper,
    toBigintIsh(params.liquidity),
    toBigintIsh(params.amount0Max),
    toBigintIsh(params.amount1Max),
    params.owner,
    params.hookData ?? "0x"
  );
  planner.addSettlePair(params.pool.currency0, params.pool.currency1);
  return planner.finalize() as Hex;
};

export const buildCollectUnlockData = (params: {
  tokenId: bigint;
  hookData?: Hex;
  currency0: Pool["currency0"];
  currency1: Pool["currency1"];
  recipient: Address;
}): Hex => {
  const planner = new V4PositionPlanner();
  planner.addDecrease(toBigintIsh(params.tokenId), 0, 0, 0, params.hookData ?? "0x");
  planner.addTakePair(params.currency0, params.currency1, params.recipient);
  return planner.finalize() as Hex;
};

export const buildCloseUnlockData = (params: {
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  hookData?: Hex;
  currency0: Pool["currency0"];
  currency1: Pool["currency1"];
  recipient: Address;
}): Hex => {
  const planner = new V4PositionPlanner();
  planner.addDecrease(
    toBigintIsh(params.tokenId),
    toBigintIsh(params.liquidity),
    toBigintIsh(params.amount0Min),
    toBigintIsh(params.amount1Min),
    params.hookData ?? "0x"
  );
  planner.addTakePair(params.currency0, params.currency1, params.recipient);
  return planner.finalize() as Hex;
};

export const buildRebalanceUnlockData = (params: {
  pool: Pool;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  oldTokenId: bigint;
  oldLiquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  newTickLower: number;
  newTickUpper: number;
  newLiquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
  hookData?: Hex;
}): Hex => {
  if (params.amount0Min > MAX_UINT128 || params.amount1Min > MAX_UINT128) {
    throw new KeeperError("amount0Min/amount1Min exceeds uint128");
  }
  if (params.amount0Max > MAX_UINT128 || params.amount1Max > MAX_UINT128) {
    throw new KeeperError("amount0Max/amount1Max exceeds uint128");
  }

  const actions = `0x${[
    ACTIONS.DECREASE_LIQUIDITY,
    ACTIONS.MINT_POSITION,
    ACTIONS.CLOSE_CURRENCY,
    ACTIONS.CLOSE_CURRENCY
  ]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}` as Hex;

  const decreaseParams = encodeAbiParameters(
    [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint256" },
      { name: "amount0Min", type: "uint128" },
      { name: "amount1Min", type: "uint128" },
      { name: "hookData", type: "bytes" }
    ],
    [params.oldTokenId, params.oldLiquidity, params.amount0Min, params.amount1Min, params.hookData ?? "0x"]
  );

  const mintParams = encodeAbiParameters(
    [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" }
        ]
      },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint256" },
      { name: "amount0Max", type: "uint128" },
      { name: "amount1Max", type: "uint128" },
      { name: "owner", type: "address" },
      { name: "hookData", type: "bytes" }
    ],
    [
      params.poolKey,
      params.newTickLower,
      params.newTickUpper,
      params.newLiquidity,
      params.amount0Max,
      params.amount1Max,
      params.owner,
      params.hookData ?? "0x"
    ]
  );

  const close0Params = encodeAbiParameters([{ name: "currency", type: "address" }], [params.poolKey.currency0]);
  const close1Params = encodeAbiParameters([{ name: "currency", type: "address" }], [params.poolKey.currency1]);

  return encodeAbiParameters(
    [
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" }
    ],
    [actions, [decreaseParams, mintParams, close0Params, close1Params]]
  ) as Hex;
};

export const buildBurnPositionUnlockData = (params: {
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  hookData?: Hex;
  currency0: Address;
  currency1: Address;
  recipient: Address;
}): Hex => {
  if (params.amount0Min < 0n || params.amount1Min < 0n) {
    throw new KeeperError("amount0Min/amount1Min must be non-negative");
  }
  if (params.amount0Min > MAX_UINT128 || params.amount1Min > MAX_UINT128) {
    throw new KeeperError("amount0Min/amount1Min exceeds uint128");
  }

  const actions = `0x${[ACTIONS.BURN_POSITION, ACTIONS.TAKE_PAIR]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  const burnParams = encodeAbiParameters(
    [
      { name: "tokenId", type: "uint256" },
      { name: "amount0Min", type: "uint128" },
      { name: "amount1Min", type: "uint128" },
      { name: "hookData", type: "bytes" }
    ],
    [params.tokenId, params.amount0Min, params.amount1Min, params.hookData ?? "0x"]
  );
  const takeParams = encodeAbiParameters(
    [
      { name: "currency0", type: "address" },
      { name: "currency1", type: "address" },
      { name: "recipient", type: "address" }
    ],
    [params.currency0, params.currency1, params.recipient]
  );
  return encodeAbiParameters(
    [
      { name: "actions", type: "bytes" },
      { name: "params", type: "bytes[]" }
    ],
    [actions, [burnParams, takeParams]]
  ) as Hex;
};
