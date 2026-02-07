import { Token } from "@uniswap/sdk-core";
import { zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { erc20Abi } from "../abi/ERC20";
import { stateViewAbi } from "../abi/StateView";
import { derivePoolId, buildPoolKey } from "../uniswap/pool";
import { parseSlot0 } from "../uniswap/poolState";
import { isTickNearBounds } from "../uniswap/sanity";
import { logger } from "../logger";
import { formatError } from "../utils/errors";
import { Address, Hex, PoolKey } from "../types";

export type ProbeResult = {
  fee: number;
  tickSpacing: number;
  hooks: Address;
  poolId: Hex;
  status: "initialized" | "uninitialized" | "no-data" | "error";
  tick?: number;
  nearBounds?: boolean;
  reason?: string;
};

export type ProbeOptions = {
  json?: boolean;
  limit?: string;
  preferFee?: string;
};

const FEES = [500, 3000, 10000];
const SPACINGS = [10, 60, 200];
const HOOKS: Address[] = [zeroAddress];

export const isNoDataError = (err: unknown): boolean => {
  if (!(err instanceof Error)) {
    return false;
  }
  return /returned no data/i.test(err.message) || /no data/i.test(err.message) || /"0x"\)/i.test(err.message);
};

const shortHex = (value: string, head = 6, tail = 4) => {
  if (value.length <= head + tail) {
    return value;
  }
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
};

export const formatProbeTable = (results: ProbeResult[]): string => {
  const headers = ["fee", "spacing", "hooks", "poolId", "status", "tick", "sanity"];
  const rows = results.map((item) => [
    item.fee.toString(),
    item.tickSpacing.toString(),
    shortHex(item.hooks),
    shortHex(item.poolId),
    item.status,
    item.tick !== undefined ? item.tick.toString() : "-",
    item.nearBounds ? "near-bounds" : "ok"
  ]);
  const widths = headers.map((header, idx) => {
    const maxRow = Math.max(...rows.map((row) => row[idx].length), header.length);
    return Math.max(maxRow, header.length);
  });
  const formatRow = (row: string[]) =>
    row.map((cell, idx) => cell.padEnd(widths[idx])).join(" | ").trimEnd();
  const divider = widths.map((w) => "-".repeat(w)).join("-|-");
  const lines = [formatRow(headers), divider, ...rows.map(formatRow)];
  return lines.join("\n");
};

export const readSlot0Safe = async (
  readContract: (args: { address: Address; abi: typeof stateViewAbi; functionName: "getSlot0"; args: [Hex] }) => Promise<unknown>,
  stateViewAddress: Address,
  poolId: Hex
): Promise<{ slot0: readonly unknown[] | null; reason?: string; status: ProbeResult["status"] }> => {
  try {
    const slot0 = (await readContract({
      address: stateViewAddress,
      abi: stateViewAbi,
      functionName: "getSlot0",
      args: [poolId]
    })) as readonly unknown[];
    return { slot0, status: "initialized" };
  } catch (err) {
    if (isNoDataError(err)) {
      return { slot0: null, status: "no-data", reason: "returned no data" };
    }
    return { slot0: null, status: "error", reason: formatError(err) };
  }
};

export const probePoolsCommand = async (options: ProbeOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient } = createClients(config);

    if (!config.token0 || !config.token1) {
      throw new Error("TOKEN0 and TOKEN1 must be set in .env");
    }

    const [token0Decimals, token1Decimals] = await Promise.all([
      publicClient.readContract({
        address: config.token0,
        abi: erc20Abi,
        functionName: "decimals"
      }),
      publicClient.readContract({
        address: config.token1,
        abi: erc20Abi,
        functionName: "decimals"
      })
    ]);

    const token0Currency = new Token(config.chainId, config.token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, config.token1, Number(token1Decimals));

    const limit = options.limit ? Number(options.limit) : undefined;
    const preferFee = options.preferFee ? Number(options.preferFee) : undefined;

    const results: ProbeResult[] = [];
    let successCount = 0;

    for (const fee of FEES) {
      for (const tickSpacing of SPACINGS) {
        for (const hooks of HOOKS) {
          const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
          const poolId = derivePoolId(poolKey as PoolKey);
          const slot0Result = await readSlot0Safe(publicClient.readContract, config.stateViewAddress, poolId);
          if (!slot0Result.slot0) {
            results.push({
              fee,
              tickSpacing,
              hooks,
              poolId,
              status: slot0Result.status,
              reason: slot0Result.reason
            });
            continue;
          }
          const parsed = parseSlot0(slot0Result.slot0);
          if (parsed.sqrtPriceX96 === 0n) {
            results.push({
              fee,
              tickSpacing,
              hooks,
              poolId,
              status: "uninitialized",
              tick: parsed.tick,
              reason: "sqrtPriceX96=0"
            });
            continue;
          }
          const nearBounds = isTickNearBounds(parsed.tick);
          results.push({
            fee,
            tickSpacing,
            hooks,
            poolId,
            status: "initialized",
            tick: parsed.tick,
            nearBounds
          });
          if (!nearBounds) {
            successCount += 1;
            if (limit && successCount >= limit) {
              break;
            }
          }
        }
        if (limit && successCount >= limit) {
          break;
        }
      }
      if (limit && successCount >= limit) {
        break;
      }
    }

    if (preferFee !== undefined) {
      results.sort((a, b) => Math.abs(a.fee - preferFee) - Math.abs(b.fee - preferFee));
    }

    if (options.json) {
      console.log(JSON.stringify({ results }, null, 2));
      return;
    }

    console.log(formatProbeTable(results));
  } catch (err) {
    logger.error("probePools failed", { error: formatError(err) });
    throw err;
  }
};
