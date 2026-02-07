import { parseUnits } from "viem";
import { PublicClient } from "viem";
import { Address, PoolKey } from "./types";
import { formatError, KeeperError } from "./utils/errors";
import { applyBpsBuffer, formatQuotePrice, quoteExactInputSingle } from "./uniswap/quoter";

type QuoteInput = {
  publicClient: PublicClient;
  quoter: Address;
  poolKey: PoolKey;
  zeroForOne: boolean;
  exactAmount: bigint;
  hookData?: `0x${string}`;
};

type QuoteFn = (params: QuoteInput) => Promise<bigint>;

export type AmountSelectionParams = {
  publicClient: PublicClient;
  poolKey: PoolKey;
  token0: Address;
  token1: Address;
  token0Decimals: number;
  token1Decimals: number;
  balance0: bigint;
  balance1: bigint;
  amount0Input?: string;
  amount1Input?: string;
  useFullBalances: boolean;
  quoterAddress?: Address;
  hookData?: `0x${string}`;
  bufferBps?: number;
  maxSpendBps?: number;
  quoteFn?: QuoteFn;
};

export type AmountSelectionResult = {
  amount0: bigint;
  amount1: bigint;
  derived: boolean;
  scaled: boolean;
  warnings: string[];
  quote?: {
    direction: "token0->token1" | "token1->token0";
    amountIn: bigint;
    amountOut: bigint;
    bufferBps: number;
    price: string;
  };
};

const clampAmount = (amount: bigint, limit: bigint, label: string, warnings: string[]): bigint => {
  if (amount > limit) {
    warnings.push(`${label} amount clamped to vault balance`);
    return limit;
  }
  return amount;
};

const applyMaxSpend = (balance: bigint, maxSpendBps: number): bigint => {
  if (maxSpendBps >= 10_000) {
    return balance;
  }
  if (maxSpendBps <= 0) {
    return 0n;
  }
  return (balance * BigInt(maxSpendBps)) / 10_000n;
};

const scaleInputToFit = (input: bigint, derived: bigint, limit: bigint): bigint => {
  if (derived === 0n) {
    throw new KeeperError("Derived amount is zero; cannot scale input");
  }
  return (input * limit * 995n) / (derived * 1000n);
};

export const selectAmounts = async (params: AmountSelectionParams): Promise<AmountSelectionResult> => {
  const {
    publicClient,
    poolKey,
    token0,
    token1,
    token0Decimals,
    token1Decimals,
    balance0,
    balance1,
    amount0Input,
    amount1Input,
    useFullBalances,
    quoterAddress,
    hookData,
    bufferBps = 200,
    maxSpendBps = 10_000,
    quoteFn
  } = params;

  const warnings: string[] = [];
  const limit0 = applyMaxSpend(balance0, maxSpendBps);
  const limit1 = applyMaxSpend(balance1, maxSpendBps);

  let amount0 = useFullBalances ? limit0 : 0n;
  let amount1 = useFullBalances ? limit1 : 0n;
  let derived = false;
  let scaled = false;
  let quote: AmountSelectionResult["quote"];

  const quoteExact = quoteFn
    ? quoteFn
    : async (input: QuoteInput) =>
        quoteExactInputSingle(publicClient, {
          quoter: input.quoter,
          poolKey: input.poolKey,
          zeroForOne: input.zeroForOne,
          exactAmount: input.exactAmount,
          hookData: input.hookData
        });

  if (useFullBalances) {
    if (amount0Input) {
      amount0 = clampAmount(parseUnits(amount0Input, token0Decimals), limit0, "token0", warnings);
    }
    if (amount1Input) {
      amount1 = clampAmount(parseUnits(amount1Input, token1Decimals), limit1, "token1", warnings);
    }
    return { amount0, amount1, derived, scaled, warnings };
  }

  if (!amount0Input && !amount1Input) {
    throw new KeeperError("Provide --amount0 and/or --amount1 when useFullBalances=false");
  }

  if (amount0Input && amount1Input) {
    amount0 = clampAmount(parseUnits(amount0Input, token0Decimals), limit0, "token0", warnings);
    amount1 = clampAmount(parseUnits(amount1Input, token1Decimals), limit1, "token1", warnings);
    return { amount0, amount1, derived, scaled, warnings };
  }

  if (!quoterAddress) {
    throw new KeeperError("QUOTER_ADDRESS is required to derive the other token amount");
  }

  if (amount0Input) {
    amount0 = clampAmount(parseUnits(amount0Input, token0Decimals), limit0, "token0", warnings);
    const zeroForOne = token0.toLowerCase() === poolKey.currency0.toLowerCase();
    let quotedAmount1: bigint;
    let derivedAmount1: bigint;
    try {
      quotedAmount1 = await quoteExact({
        publicClient,
        quoter: quoterAddress,
        poolKey,
        zeroForOne,
        exactAmount: amount0,
        hookData
      });
      derivedAmount1 = applyBpsBuffer(quotedAmount1, bufferBps);
      const price = formatQuotePrice(amount0, quotedAmount1, token0Decimals, token1Decimals);
      quote = {
        direction: "token0->token1",
        amountIn: amount0,
        amountOut: quotedAmount1,
        bufferBps,
        price
      };
    } catch (err) {
      if (limit1 <= 0n) {
        throw new KeeperError("Quote failed and token1 balance is zero; provide --amount1 or enable useFullBalances", {
          error: formatError(err)
        });
      }
      warnings.push(`Quote failed; using full token1 balance (${formatError(err)})`);
      amount1 = limit1;
      return { amount0, amount1, derived, scaled, warnings };
    }

    for (let i = 0; i < 5; i += 1) {
      if (derivedAmount1 <= limit1) {
        break;
      }
      amount0 = scaleInputToFit(amount0, derivedAmount1, limit1);
      if (amount0 <= 0n) {
        throw new KeeperError("Scaled amount0 fell to zero while fitting token1 balance");
      }
      quotedAmount1 = await quoteExact({
        publicClient,
        quoter: quoterAddress,
        poolKey,
        zeroForOne,
        exactAmount: amount0,
        hookData
      });
      derivedAmount1 = applyBpsBuffer(quotedAmount1, bufferBps);
      scaled = true;
    }

    if (derivedAmount1 > limit1) {
      throw new KeeperError("Derived token1 amount exceeds vault balance after scaling", {
        balance1: limit1.toString(),
        derivedAmount1: derivedAmount1.toString()
      });
    }

    if (scaled) {
      warnings.push("Scaled amount0 to fit token1 balance");
    }

    amount1 = derivedAmount1;
    derived = true;
    return { amount0, amount1, derived, scaled, warnings, quote };
  }

  amount1 = clampAmount(parseUnits(amount1Input ?? "0", token1Decimals), limit1, "token1", warnings);
  const zeroForOne = token1.toLowerCase() === poolKey.currency0.toLowerCase();
  let quotedAmount0: bigint;
  let derivedAmount0: bigint;
  try {
    quotedAmount0 = await quoteExact({
      publicClient,
      quoter: quoterAddress,
      poolKey,
      zeroForOne,
      exactAmount: amount1,
      hookData
    });
    derivedAmount0 = applyBpsBuffer(quotedAmount0, bufferBps);
    const price = formatQuotePrice(amount1, quotedAmount0, token1Decimals, token0Decimals);
    quote = {
      direction: "token1->token0",
      amountIn: amount1,
      amountOut: quotedAmount0,
      bufferBps,
      price
    };
  } catch (err) {
    if (limit0 <= 0n) {
      throw new KeeperError("Quote failed and token0 balance is zero; provide --amount0 or enable useFullBalances", {
        error: formatError(err)
      });
    }
    warnings.push(`Quote failed; using full token0 balance (${formatError(err)})`);
    amount0 = limit0;
    return { amount0, amount1, derived, scaled, warnings };
  }

  for (let i = 0; i < 5; i += 1) {
    if (derivedAmount0 <= limit0) {
      break;
    }
    amount1 = scaleInputToFit(amount1, derivedAmount0, limit0);
    if (amount1 <= 0n) {
      throw new KeeperError("Scaled amount1 fell to zero while fitting token0 balance");
    }
    quotedAmount0 = await quoteExact({
      publicClient,
      quoter: quoterAddress,
      poolKey,
      zeroForOne,
      exactAmount: amount1,
      hookData
    });
    derivedAmount0 = applyBpsBuffer(quotedAmount0, bufferBps);
    scaled = true;
  }

  if (derivedAmount0 > limit0) {
    throw new KeeperError("Derived token0 amount exceeds vault balance after scaling", {
      balance0: limit0.toString(),
      derivedAmount0: derivedAmount0.toString()
    });
  }

  if (scaled) {
    warnings.push("Scaled amount1 to fit token0 balance");
  }

  amount0 = derivedAmount0;
  derived = true;
  return { amount0, amount1, derived, scaled, warnings, quote };
};
