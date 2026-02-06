import { Token } from "@uniswap/sdk-core";
import { parseUnits, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey } from "../uniswap/pool";
import { applyBpsBuffer, formatQuotePrice, quoteExactInputSingle } from "../uniswap/quoter";
import { logger } from "../logger";
import { formatError, invariant, KeeperError } from "../utils/errors";

type QuoteOptions = {
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
};

export const quoteCommand = async (options: QuoteOptions) => {
  try {
    const config = await loadConfig();
    const { publicClient } = createClients(config);

    if (!config.quoterAddress) {
      throw new KeeperError("QUOTER_ADDRESS is required for quoting");
    }

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    if (!options.amount0 && !options.amount1) {
      throw new KeeperError("Provide --amount0 or --amount1 to quote");
    }
    if (options.amount0 && options.amount1) {
      throw new KeeperError("Provide only one of --amount0 or --amount1");
    }

    const [token0, token1, token0Decimals, token1Decimals] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "token0"
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "token1"
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "token0Decimals"
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "token1Decimals"
      })
    ]);

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? zeroAddress;
    if (fee === undefined || tickSpacing === undefined) {
      throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for quoting");
    }

    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);

    const bufferBps = options.bufferBps ? Number(options.bufferBps) : 0;

    if (options.amount0) {
      const amount0 = parseUnits(options.amount0, Number(token0Decimals));
      const zeroForOne = token0.toLowerCase() === poolKey.currency0.toLowerCase();
      const amount1Quoted = await quoteExactInputSingle(publicClient, {
        quoter: config.quoterAddress,
        poolKey,
        zeroForOne,
        exactAmount: amount0,
        hookData: config.policy.hookDataHex
      });
      const amount1 = applyBpsBuffer(amount1Quoted, bufferBps);
      const price = formatQuotePrice(amount0, amount1Quoted, Number(token0Decimals), Number(token1Decimals));
      logger.info("Quote token0->token1", { amount0, amount1Quoted, amount1, priceToken1PerToken0: price, bufferBps });
      return;
    }

    const amount1 = parseUnits(options.amount1 ?? "0", Number(token1Decimals));
    const zeroForOne = token1.toLowerCase() === poolKey.currency0.toLowerCase();
    const amount0Quoted = await quoteExactInputSingle(publicClient, {
      quoter: config.quoterAddress,
      poolKey,
      zeroForOne,
      exactAmount: amount1,
      hookData: config.policy.hookDataHex
    });
    const amount0 = applyBpsBuffer(amount0Quoted, bufferBps);
    const price = formatQuotePrice(amount1, amount0Quoted, Number(token1Decimals), Number(token0Decimals));
    logger.info("Quote token1->token0", { amount1, amount0Quoted, amount0, priceToken0PerToken1: price, bufferBps });
  } catch (err) {
    logger.error("Quote failed", { error: formatError(err) });
    throw err;
  }
};
