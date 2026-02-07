import { KeeperError } from "../utils/errors";
import { Hex } from "../types";

const Q96 = 2n ** 96n;

const sqrtBigInt = (value: bigint): bigint => {
  if (value < 0n) {
    throw new KeeperError("Cannot sqrt negative bigint");
  }
  if (value < 2n) {
    return value;
  }
  let x0 = value / 2n;
  let x1 = (x0 + value / x0) / 2n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) / 2n;
  }
  return x0;
};

export const encodeSqrtRatioX96 = (amount1: bigint, amount0: bigint): bigint => {
  if (amount0 <= 0n || amount1 <= 0n) {
    throw new KeeperError("Amounts must be positive");
  }
  const ratioX192 = (amount1 << 192n) / amount0;
  return sqrtBigInt(ratioX192);
};

export const parseSqrtPriceX96 = (value: string): bigint => {
  if (value.startsWith("0x") || value.startsWith("0X")) {
    return BigInt(value as Hex);
  }
  return BigInt(value);
};

export const computeSqrtPriceFromUsdcPerWeth = (priceUsdcPerWeth: number): bigint => {
  if (!Number.isFinite(priceUsdcPerWeth) || priceUsdcPerWeth <= 0) {
    throw new KeeperError("priceUsdcPerWeth must be positive");
  }
  const amount1 = 10n ** 18n;
  const amount0 = BigInt(Math.trunc(priceUsdcPerWeth * 1e6));
  return encodeSqrtRatioX96(amount1, amount0);
};

export const isUint160 = (value: bigint): boolean => value >= 0n && value <= (1n << 160n) - 1n;
