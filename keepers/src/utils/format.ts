import { formatUnits } from "viem";

export const formatBigint = (value: bigint): string => value.toString();

export const formatUnitsSafe = (value: bigint, decimals: number): string => {
  try {
    return formatUnits(value, decimals);
  } catch {
    return value.toString();
  }
};

export const shortenAddress = (address: string): string => {
  if (address.length <= 10) {
    return address;
  }
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
};
