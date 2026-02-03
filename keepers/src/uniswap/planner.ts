import { V4PositionPlanner, Pool } from "@uniswap/v4-sdk";
import { Address, Hex } from "../types";

const toBigintIsh = (value: bigint): string => value.toString();

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

export const buildRebalanceUnlockData = (params: {
  pool: Pool;
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
  const planner = new V4PositionPlanner();
  planner.addDecrease(
    toBigintIsh(params.oldTokenId),
    toBigintIsh(params.oldLiquidity),
    toBigintIsh(params.amount0Min),
    toBigintIsh(params.amount1Min),
    params.hookData ?? "0x"
  );
  planner.addMint(
    params.pool,
    params.newTickLower,
    params.newTickUpper,
    toBigintIsh(params.newLiquidity),
    toBigintIsh(params.amount0Max),
    toBigintIsh(params.amount1Max),
    params.owner,
    params.hookData ?? "0x"
  );
  planner.addSettlePair(params.pool.currency0, params.pool.currency1);
  planner.addTakePair(params.pool.currency0, params.pool.currency1, params.owner);
  return planner.finalize() as Hex;
};
