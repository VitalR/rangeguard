import { formatUnits } from "viem";
import { PublicClient } from "viem";
import { v4QuoterAbi } from "../abi/V4Quoter";
import { Address, PoolKey } from "../types";
import { KeeperError } from "../utils/errors";

const MAX_UINT128 = (1n << 128n) - 1n;

type QuoteSingleParams = {
  quoter: Address;
  poolKey: PoolKey;
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData?: `0x${string}`;
};

export const applyBpsBuffer = (value: bigint, bpsBuffer: number): bigint => {
  if (!Number.isFinite(bpsBuffer) || bpsBuffer < 0 || bpsBuffer > 10_000) {
    throw new KeeperError(`Invalid quoteBpsBuffer: ${bpsBuffer}`);
  }
  return (value * BigInt(10_000 + bpsBuffer)) / 10_000n;
};

export const formatQuotePrice = (
  amountIn: bigint,
  amountOut: bigint,
  decimalsIn: number,
  decimalsOut: number
): string => {
  const inFloat = Number(formatUnits(amountIn, decimalsIn));
  const outFloat = Number(formatUnits(amountOut, decimalsOut));
  if (!Number.isFinite(inFloat) || inFloat === 0) {
    return "0";
  }
  return (outFloat / inFloat).toFixed(8);
};

export const quoteExactInputSingle = async (
  publicClient: PublicClient,
  params: QuoteSingleParams
): Promise<bigint> => {
  if (params.exactAmount <= 0n) {
    throw new KeeperError("Quote amount must be positive");
  }
  if (params.exactAmount > MAX_UINT128) {
    throw new KeeperError("Quote amount exceeds uint128");
  }

  const [amountOut] = (await publicClient.readContract({
    address: params.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        poolKey: params.poolKey,
        zeroForOne: params.zeroForOne,
        exactAmount: params.exactAmount,
        hookData: params.hookData ?? "0x"
      }
    ]
  })) as [bigint, bigint];

  return amountOut;
};

export const quoteExactOutputSingle = async (
  publicClient: PublicClient,
  params: QuoteSingleParams
): Promise<bigint> => {
  if (params.exactAmount <= 0n) {
    throw new KeeperError("Quote amount must be positive");
  }
  if (params.exactAmount > MAX_UINT128) {
    throw new KeeperError("Quote amount exceeds uint128");
  }

  const [amountIn] = (await publicClient.readContract({
    address: params.quoter,
    abi: v4QuoterAbi,
    functionName: "quoteExactOutputSingle",
    args: [
      {
        poolKey: params.poolKey,
        zeroForOne: params.zeroForOne,
        exactAmount: params.exactAmount,
        hookData: params.hookData ?? "0x"
      }
    ]
  })) as [bigint, bigint];

  return amountIn;
};
