import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { KeeperError } from "../utils/errors";

export const listPositionIds = async (publicClient: any, vaultAddress: `0x${string}`): Promise<bigint[]> => {
  const ids = await publicClient.readContract({
    address: vaultAddress,
    abi: rangeGuardVaultAbi,
    functionName: "getPositionIds"
  });
  return ids as bigint[];
};

export const selectPositionId = async (
  publicClient: any,
  vaultAddress: `0x${string}`,
  positionId?: string
): Promise<{ positionId: bigint; positionIds: bigint[] }> => {
  const ids = await listPositionIds(publicClient, vaultAddress);
  if (positionId) {
    const parsed = BigInt(positionId);
    const exists = ids.some((id) => id === parsed);
    if (!exists) {
      throw new KeeperError("PositionId is not tracked by the vault", {
        positionId,
        tracked: ids.map((id) => id.toString())
      });
    }
    return { positionId: parsed, positionIds: ids };
  }
  if (ids.length === 1) {
    return { positionId: ids[0], positionIds: ids };
  }
  if (ids.length === 0) {
    throw new KeeperError("No tracked positions in vault");
  }
  throw new KeeperError("Multiple positions detected. Provide --positionId.", {
    tracked: ids.map((id) => id.toString())
  });
};
