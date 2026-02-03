import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PolicyConfig } from "../types";
import { nowSeconds } from "../utils/time";
import { KeeperError } from "../utils/errors";

const stateDir = path.join(os.homedir(), ".rangeguard");
const statePath = path.join(stateDir, "keeper-state.json");

type KeeperState = {
  lastActionAt?: Record<string, number>;
};

const readState = async (): Promise<KeeperState> => {
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return JSON.parse(raw) as KeeperState;
  } catch {
    return {};
  }
};

const writeState = async (state: KeeperState): Promise<void> => {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2));
};

export const assertCooldown = async (policy: PolicyConfig, vaultAddress: string, action: string) => {
  if (policy.cooldownSeconds <= 0) {
    return;
  }
  const state = await readState();
  const last = state.lastActionAt?.[vaultAddress.toLowerCase()];
  if (!last) {
    return;
  }
  const nextAllowed = last + policy.cooldownSeconds;
  if (nowSeconds() < nextAllowed) {
    const wait = nextAllowed - nowSeconds();
    throw new KeeperError(`Cooldown active for ${action}. Retry in ${wait}s.`);
  }
};

export const recordAction = async (policy: PolicyConfig, vaultAddress: string) => {
  if (policy.cooldownSeconds <= 0) {
    return;
  }
  const state = await readState();
  const next: KeeperState = {
    ...state,
    lastActionAt: {
      ...(state.lastActionAt ?? {}),
      [vaultAddress.toLowerCase()]: nowSeconds()
    }
  };
  await writeState(next);
};
