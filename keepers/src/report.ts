import fs from "node:fs/promises";
import path from "node:path";
import { keccak256 } from "viem";
import { formatUnitsSafe } from "./utils/format";

export type VaultState = {
  balances: {
    token0: bigint;
    token1: bigint;
    eth: bigint;
  };
  position: {
    initialized: boolean;
    positionId: string;
    lower: number;
    upper: number;
    spacing: number;
  };
  pool: {
    poolId: string | null;
    tick: number | null;
  };
  inRange: boolean | null;
  outOfRange: boolean | null;
  nearEdge: boolean | null;
  healthBps: number | null;
};

export type RunReport = {
  runId: string;
  command: string;
  createdAt: string;
  chainId: number;
  addresses: {
    vault: string;
    positionManager: string;
    poolId?: string | null;
    token0: string;
    token1: string;
    quoter?: string;
  };
  tokens: {
    token0: { address: string; decimals: number };
    token1: { address: string; decimals: number };
  };
  policy: {
    widthTicks: number;
    edgeBps: number;
    cooldownSeconds: number;
    maxSlippageBps: number;
    useFullBalances: boolean;
  };
  decision?: {
    action: "execute" | "skip";
    reason: string;
  };
  stateBefore?: VaultState;
  plan?: Record<string, unknown>;
  tx?: Record<string, unknown>;
  stateAfter?: VaultState;
  warnings?: string[];
  reportPath?: string;
  debug?: Record<string, unknown>;
};

export type OutputOptions = {
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

export const createRunId = (): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${rand}`;
};

const toReportPath = (command: string, runId: string, out?: string): string => {
  if (out) {
    return path.isAbsolute(out) ? out : path.join(process.cwd(), out);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(process.cwd(), "runs", `${stamp}_${command}_${runId}.json`);
};

const stringifyReport = (report: RunReport): string =>
  JSON.stringify(
    report,
    (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    },
    2
  );

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

export const writeReport = async (report: RunReport, out?: string): Promise<string> => {
  const reportPath = toReportPath(report.command, report.runId, out);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, stringifyReport(report));
  return reportPath;
};

const formatStateLine = (label: string, value: string | number | null | undefined) => {
  if (value === null || value === undefined) {
    return `${label}: n/a`;
  }
  return `${label}: ${value}`;
};

export const renderSummary = (report: RunReport): string => {
  const lines: string[] = [];
  lines.push(`Run ${report.command} (${report.runId})`);
  lines.push(`Network: chainId ${report.chainId}`);
  lines.push(`Vault: ${report.addresses.vault} | PositionManager: ${report.addresses.positionManager}`);
  if (report.addresses.poolId) {
    lines.push(`PoolId: ${report.addresses.poolId}`);
  }

  const before = report.stateBefore;
  if (before) {
    lines.push(formatStateLine("Pool tick", before.pool.tick));
    lines.push(
      `Position: ${before.position.positionId} [${before.position.lower}, ${before.position.upper}] spacing ${before.position.spacing}`
    );
    lines.push(
      `Range: inRange=${before.inRange ?? "n/a"} outOfRange=${before.outOfRange ?? "n/a"} nearEdge=${
        before.nearEdge ?? "n/a"
      } healthBps=${before.healthBps ?? "n/a"}`
    );
    const token0Balance = formatUnitsSafe(before.balances.token0, report.tokens.token0.decimals);
    const token1Balance = formatUnitsSafe(before.balances.token1, report.tokens.token1.decimals);
    const ethBalance = formatUnitsSafe(before.balances.eth, 18);
    lines.push(`Balances: token0=${token0Balance} token1=${token1Balance} eth=${ethBalance}`);
  }

  lines.push(
    `Policy: width=${report.policy.widthTicks}, edgeBps=${report.policy.edgeBps}, cooldown=${
      report.policy.cooldownSeconds
    }s, maxSlipBps=${report.policy.maxSlippageBps}`
  );

  if (report.decision) {
    lines.push(`Decision: ${report.decision.action} (${report.decision.reason})`);
  }

  if (report.plan) {
    const plan = report.plan as Record<string, unknown>;
    if (plan.tickLower !== undefined && plan.tickUpper !== undefined) {
      const quote = plan.quote as Record<string, unknown> | null | undefined;
      const quoteLine =
        quote && quote.price
          ? ` quotePrice=${quote.price} bufferBps=${quote.bufferBps ?? "n/a"}`
          : "";
      lines.push(
        `Plan: ticks [${plan.tickLower}, ${plan.tickUpper}] amount0=${plan.amount0 ?? "n/a"} amount1=${
          plan.amount1 ?? "n/a"
        }${quoteLine}`
      );
    } else if (plan.direction) {
      lines.push(
        `Plan: ${plan.direction} amountIn=${plan.amount0 ?? plan.amount1 ?? "n/a"} amountOut=${
          plan.amount1 ?? plan.amount0 ?? "n/a"
        } bufferBps=${plan.bufferBps ?? "n/a"}`
      );
    } else {
      lines.push(`Plan: ${JSON.stringify(report.plan)}`);
    }
  }

  if (report.tx) {
    const tx = report.tx as Record<string, unknown>;
    const hash = tx.hash ?? "dry-run";
    const block = tx.blockNumber ?? "n/a";
    const events = Array.isArray(tx.events) ? safeStringify(tx.events) : "n/a";
    lines.push(`Tx: ${hash} block=${block} events=${events}`);
  }

  const after = report.stateAfter;
  if (after) {
    const token0Balance = formatUnitsSafe(after.balances.token0, report.tokens.token0.decimals);
    const token1Balance = formatUnitsSafe(after.balances.token1, report.tokens.token1.decimals);
    const ethBalance = formatUnitsSafe(after.balances.eth, 18);
    lines.push(
      `Post: position=${after.position.positionId} [${after.position.lower}, ${after.position.upper}] spacing ${
        after.position.spacing
      }`
    );
    lines.push(`Post balances: token0=${token0Balance} token1=${token1Balance} eth=${ethBalance}`);
  }

  if (report.warnings && report.warnings.length > 0) {
    lines.push(`Warnings: ${report.warnings.join("; ")}`);
  }

  return lines.join("\n");
};

export const outputReport = async (report: RunReport, options: OutputOptions): Promise<void> => {
  const reportPath = await writeReport(report, options.out);
  report.reportPath = reportPath;

  if (options.json) {
    console.log(stringifyReport(report));
    return;
  }

  console.log(renderSummary(report));
  console.log(`Report saved to ${reportPath}`);
};

export const hashCalldata = (calldata?: `0x${string}`): string | undefined => {
  if (!calldata) {
    return undefined;
  }
  return keccak256(calldata);
};
