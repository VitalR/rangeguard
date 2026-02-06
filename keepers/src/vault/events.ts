import { decodeEventLog } from "viem";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";

export type VaultEvent = {
  name: string;
  args: Record<string, unknown>;
};

export const parseVaultEvents = (
  logs: Array<{ address: string; data: `0x${string}`; topics: `0x${string}`[] }>,
  vault: string
) => {
  const events: VaultEvent[] = [];
  const vaultLower = vault.toLowerCase();

  for (const log of logs) {
    if (log.address.toLowerCase() !== vaultLower) {
      continue;
    }
    if (log.topics.length === 0) {
      continue;
    }
    try {
      const decoded = decodeEventLog({
        abi: rangeGuardVaultAbi,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]]
      });
      if (decoded.eventName) {
        events.push({ name: decoded.eventName, args: decoded.args as Record<string, unknown> });
      }
    } catch {
      continue;
    }
  }

  return events;
};
