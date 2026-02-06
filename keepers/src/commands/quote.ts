import { Token } from "@uniswap/sdk-core";
import { parseUnits, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { buildPoolKey } from "../uniswap/pool";
import { applyBpsBuffer, formatQuotePrice, quoteExactInputSingle } from "../uniswap/quoter";
import { logger } from "../logger";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { createRunId, outputReport, RunReport } from "../report";
import { fetchVaultState } from "../vault/state";

type QuoteOptions = {
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

export const quoteCommand = async (options: QuoteOptions = {}) => {
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

    const { state: stateBefore, context } = await fetchVaultState(config, publicClient);

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? zeroAddress;
    if (fee === undefined || tickSpacing === undefined) {
      throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for quoting");
    }

    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);

    const bufferBps = options.bufferBps ? Number(options.bufferBps) : 0;
    const runId = createRunId();

    if (options.amount0) {
      const amount0 = parseUnits(options.amount0, Number(context.token0Decimals));
      const zeroForOne = context.token0.toLowerCase() === poolKey.currency0.toLowerCase();
      const amount1Quoted = await quoteExactInputSingle(publicClient, {
        quoter: config.quoterAddress,
        poolKey,
        zeroForOne,
        exactAmount: amount0,
        hookData: config.policy.hookDataHex
      });
      const amount1 = applyBpsBuffer(amount1Quoted, bufferBps);
      const price = formatQuotePrice(
        amount0,
        amount1Quoted,
        Number(context.token0Decimals),
        Number(context.token1Decimals)
      );

      const report: RunReport = {
        runId,
        command: "quote",
        createdAt: new Date().toISOString(),
        chainId,
        addresses: {
          vault: config.vaultAddress,
          positionManager: config.positionManagerAddress ?? context.positionManager,
          poolId: stateBefore.pool.poolId ?? undefined,
          token0: context.token0,
          token1: context.token1,
          quoter: config.quoterAddress
        },
        tokens: {
          token0: { address: context.token0, decimals: context.token0Decimals },
          token1: { address: context.token1, decimals: context.token1Decimals }
        },
        policy: config.policy,
        decision: { action: "execute", reason: "quote" },
        stateBefore,
        plan: {
          direction: "token0->token1",
          amount0: amount0.toString(),
          amount1Quoted: amount1Quoted.toString(),
          amount1: amount1.toString(),
          priceToken1PerToken0: price,
          bufferBps
        }
      };

      await outputReport(report, options);
      return;
    }

    const amount1 = parseUnits(options.amount1 ?? "0", Number(context.token1Decimals));
    const zeroForOne = context.token1.toLowerCase() === poolKey.currency0.toLowerCase();
    const amount0Quoted = await quoteExactInputSingle(publicClient, {
      quoter: config.quoterAddress,
      poolKey,
      zeroForOne,
      exactAmount: amount1,
      hookData: config.policy.hookDataHex
    });
    const amount0 = applyBpsBuffer(amount0Quoted, bufferBps);
    const price = formatQuotePrice(
      amount1,
      amount0Quoted,
      Number(context.token1Decimals),
      Number(context.token0Decimals)
    );

    const report: RunReport = {
      runId,
      command: "quote",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: config.positionManagerAddress ?? context.positionManager,
        poolId: stateBefore.pool.poolId ?? undefined,
        token0: context.token0,
        token1: context.token1,
        quoter: config.quoterAddress
      },
      tokens: {
        token0: { address: context.token0, decimals: context.token0Decimals },
        token1: { address: context.token1, decimals: context.token1Decimals }
      },
      policy: config.policy,
      decision: { action: "execute", reason: "quote" },
      stateBefore,
      plan: {
        direction: "token1->token0",
        amount1: amount1.toString(),
        amount0Quoted: amount0Quoted.toString(),
        amount0: amount0.toString(),
        priceToken0PerToken1: price,
        bufferBps
      }
    };

    await outputReport(report, options);
  } catch (err) {
    logger.error("Quote failed", { error: formatError(err) });
    throw err;
  }
};
