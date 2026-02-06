import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunReport, writeReport } from "../report";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rangeguard-report-"));
const outPath = path.join(tmpDir, "report.json");

const report: RunReport = {
  runId: "test",
  command: "status",
  createdAt: new Date().toISOString(),
  chainId: 11155111,
  addresses: {
    vault: "0x0000000000000000000000000000000000000001",
    positionManager: "0x0000000000000000000000000000000000000002",
    poolId: "0x0000000000000000000000000000000000000000000000000000000000000003",
    token0: "0x0000000000000000000000000000000000000004",
    token1: "0x0000000000000000000000000000000000000005"
  },
  tokens: {
    token0: { address: "0x0000000000000000000000000000000000000004", decimals: 6 },
    token1: { address: "0x0000000000000000000000000000000000000005", decimals: 18 }
  },
  policy: {
    widthTicks: 1200,
    edgeBps: 1000,
    cooldownSeconds: 60,
    maxSlippageBps: 30,
    useFullBalances: true
  },
  stateBefore: {
    balances: { token0: 10n, token1: 20n, eth: 0n },
    position: { initialized: true, positionId: "1", lower: -60, upper: 1200, spacing: 60 },
    pool: { poolId: "0x123", tick: 1 },
    inRange: true,
    outOfRange: false,
    nearEdge: false,
    healthBps: 5000
  }
};

const savedPath = await writeReport(report, outPath);
const raw = await fs.readFile(savedPath, "utf-8");
const parsed = JSON.parse(raw);

assert.equal(parsed.command, "status");
assert.ok(parsed.addresses);
assert.ok(parsed.stateBefore);

console.log("report.test.ts OK");
