import { KeeperError } from "../utils/errors";
import { Hex } from "../types";

export type Slot0 = {
  sqrtPriceX96: bigint;
  tick: number;
};

export const isPoolInitialized = (slot0: Slot0 | null): { initialized: boolean; reason?: string } => {
  if (!slot0) {
    return { initialized: false, reason: "slot0 empty" };
  }
  if (slot0.sqrtPriceX96 === 0n) {
    return { initialized: false, reason: "sqrtPriceX96=0" };
  }
  if (Math.abs(slot0.tick) >= 887270) {
    return { initialized: false, reason: `tick near bounds (${slot0.tick})` };
  }
  return { initialized: true };
};

export const parseSlot0 = (raw: readonly unknown[]): Slot0 => {
  const sqrtPriceX96 = raw[0] as bigint;
  const tick = Number(raw[1]);
  if (!Number.isFinite(tick)) {
    throw new KeeperError("Invalid tick from StateView");
  }
  return { sqrtPriceX96, tick };
};

export const toHexBigInt = (value: string): bigint => {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value as Hex);
  }
  return BigInt(value);
};
