import { Token } from "@uniswap/sdk-core";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { poolManagerAbi } from "../abi/PoolManager";
import { buildPoolKey, getPoolSlot0, derivePoolId } from "../uniswap/pool";
import { computeSqrtPriceFromUsdcPerWeth, isUint160, parseSqrtPriceX96 } from "../uniswap/price";
import { isPoolInitialized } from "../uniswap/poolState";
import { logger } from "../logger";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { decodeUniswapError, extractRevertData, getRevertHint } from "../uniswap/errorDecoder";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";

type InitPoolOptions = {
  priceUsdcPerWeth?: string;
  sqrtPriceX96?: string;
  hookDataHex?: string;
  send?: boolean;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

export const resolveSqrtPriceX96 = (options: InitPoolOptions): bigint => {
  if (options.sqrtPriceX96) {
    const value = parseSqrtPriceX96(options.sqrtPriceX96);
    if (!isUint160(value)) {
      throw new KeeperError("sqrtPriceX96 must fit uint160");
    }
    return value;
  }
  const price = options.priceUsdcPerWeth ? Number(options.priceUsdcPerWeth) : 2000;
  const value = computeSqrtPriceFromUsdcPerWeth(price);
  if (!isUint160(value)) {
    throw new KeeperError("sqrtPriceX96 must fit uint160");
  }
  return value;
};

export const initPoolCommand = async (options: InitPoolOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? "0x0000000000000000000000000000000000000000";
    if (fee === undefined || tickSpacing === undefined) {
      throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for initPool");
    }
    if (!config.poolManagerAddress) {
      throw new KeeperError("POOL_MANAGER_ADDRESS is required for initPool");
    }

    const token0 = config.token0;
    const token1 = config.token1;
    if (!token0 || !token1) {
      throw new KeeperError("TOKEN0 and TOKEN1 are required for initPool");
    }

    const [token0Decimals, token1Decimals] = await Promise.all([
      publicClient.readContract({
        address: token0,
        abi: [
          { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
        ],
        functionName: "decimals"
      }),
      publicClient.readContract({
        address: token1,
        abi: [
          { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }
        ],
        functionName: "decimals"
      })
    ]);
    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
    const poolId = derivePoolId(poolKey);

    const sqrtPriceX96 = resolveSqrtPriceX96(options);
    const hookData = (options.hookDataHex ?? "0x") as `0x${string}`;

    const slot0 = await getPoolSlot0(publicClient, config.stateViewAddress, poolKey, token0Currency, token1Currency);
    const poolInit = isPoolInitialized({
      sqrtPriceX96: slot0.sqrtPriceX96,
      tick: slot0.tickCurrent
    });

    const dryRun = !options.send;
    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        address: config.poolManagerAddress,
        abi: poolManagerAbi,
        functionName: "initialize",
        args: [poolKey, sqrtPriceX96, hookData],
        account: account.address
      });
    } catch (err) {
      const revertData = extractRevertData(err);
      const decoded = revertData ? decodeUniswapError(revertData) : null;
      if (decoded) {
        logger.error("InitPool revert decoded", {
          selector: decoded.selector,
          error: decoded.name,
          args: decoded.args,
          hint: getRevertHint(decoded.name)
        });
      } else if (revertData) {
        logger.error("InitPool revert selector", { selector: revertData.slice(0, 10) });
      }
      throw err;
    }

    let gasEstimate: bigint | undefined;
    if (options.verbose) {
      try {
        gasEstimate = await publicClient.estimateContractGas(simulation.request);
      } catch {
        gasEstimate = undefined;
      }
    }

    const runId = createRunId();
    const report: RunReport = {
      runId,
      command: "initPool",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: config.positionManagerAddress ?? "0x0000000000000000000000000000000000000000",
        poolId,
        token0,
        token1
      },
      tokens: {
        token0: { address: token0, decimals: Number(token0Decimals) },
        token1: { address: token1, decimals: Number(token1Decimals) }
      },
      policy: config.policy,
      decision: { action: "execute", reason: dryRun ? "dry-run" : "send" },
      plan: {
        poolId,
        poolKey,
        sqrtPriceX96: sqrtPriceX96.toString(),
        priceUsdcPerWeth: options.priceUsdcPerWeth ? Number(options.priceUsdcPerWeth) : 2000,
        hookData,
        poolInitialized: poolInit.initialized,
        reason: poolInit.reason
      }
    };

    if (options.verbose) {
      const calldata = (simulation.request as { data?: `0x${string}` }).data;
      report.debug = {
        calldataHash: hashCalldata(calldata),
        gasEstimate: gasEstimate?.toString()
      };
    }

    if (poolInit.initialized) {
      report.decision = {
        action: "skip",
        reason: "Pool already initialized"
      };
      report.tx = { dryRun: true };
      await outputReport(report, options);
      return;
    }

    if (dryRun) {
      report.tx = { dryRun: true };
      await outputReport(report, options);
      return;
    }

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const updatedSlot0 = await getPoolSlot0(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency
    );
    const updatedInit = isPoolInitialized({
      sqrtPriceX96: updatedSlot0.sqrtPriceX96,
      tick: updatedSlot0.tickCurrent
    });

    report.tx = {
      dryRun: false,
      hash,
      blockNumber: receipt.blockNumber?.toString()
    };
    report.stateAfter = {
      balances: { token0: 0n, token1: 0n, eth: 0n },
      position: null,
      positions: [],
      pool: {
        poolId,
        tick: updatedSlot0.tickCurrent,
        sqrtPriceX96: updatedSlot0.sqrtPriceX96.toString()
      },
      inRange: null,
      outOfRange: null,
      nearEdge: null,
      healthBps: null
    };

    report.plan = {
      ...(report.plan ?? {}),
      poolInitializedAfter: updatedInit.initialized,
      tickAfter: updatedSlot0.tickCurrent
    };

    if (options.verbose) {
      report.debug = {
        ...(report.debug ?? {}),
        receiptLogsCount: receipt.logs.length
      };
    }

    await outputReport(report, options);
  } catch (err) {
    logger.error("InitPool failed", { error: formatError(err) });
    throw err;
  }
};
