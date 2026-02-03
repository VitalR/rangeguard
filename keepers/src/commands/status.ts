import { Token } from "@uniswap/sdk-core";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { getPoolKeyFromPosition, buildPoolFromState } from "../uniswap/pool";
import { centerRange } from "../uniswap/ticks";
import { logger } from "../logger";
import { formatError, invariant } from "../utils/errors";

const replacer = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

export const statusCommand = async () => {
  try {
    const config = await loadConfig();
    const { publicClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [token0, token1, token0Decimals, token1Decimals, keeper, maxSlippageBps, positionManager, ticks, initialized] =
      await Promise.all([
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
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "keeper"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "maxSlippageBps"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "positionManager"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "ticks"
        }),
        publicClient.readContract({
          address: config.vaultAddress,
          abi: rangeGuardVaultAbi,
          functionName: "isPositionInitialized"
        })
      ]);

    if (keeper.toLowerCase() !== account.address.toLowerCase()) {
      logger.warn("Vault keeper does not match configured key", { keeper, configured: account.address });
    }

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      logger.warn("Policy maxSlippageBps exceeds vault maxSlippageBps", {
        policy: config.policy.maxSlippageBps,
        vault: Number(maxSlippageBps)
      });
    }

    const lower = Number(ticks[0]);
    const upper = Number(ticks[1]);
    const spacing = Number(ticks[2]);
    const positionId = ticks[3] as bigint;

    let currentTick: number | null = null;
    if (initialized) {
      const positionManagerAddress = config.positionManagerAddress ?? positionManager;
      const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);
      const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
      const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
      const { tickCurrent } = await buildPoolFromState(
        publicClient,
        config.stateViewAddress,
        poolKey,
        token0Currency,
        token1Currency,
        config.poolId
      );
      currentTick = tickCurrent;
    }

    const widthTicks = config.policy.widthTicks;
    const edgeThresholdTicks = Math.max(1, Math.floor((widthTicks * config.policy.edgeBps) / 10_000));

    const outOfRange =
      currentTick !== null ? currentTick <= lower || currentTick >= upper : false;
    const nearEdge =
      currentTick !== null
        ? currentTick <= lower + edgeThresholdTicks || currentTick >= upper - edgeThresholdTicks
        : false;

    let suggested: { lower: number; upper: number } | null = null;
    if (currentTick !== null && spacing > 0) {
      try {
        suggested = centerRange(currentTick, widthTicks, spacing);
      } catch (err) {
        logger.warn("Failed to compute suggested range", { error: formatError(err) });
      }
    }

    const output = {
      positionId: positionId.toString(),
      lower,
      upper,
      spacing,
      tick: currentTick,
      outOfRange,
      nearEdge,
      suggested,
      policy: config.policy
    };

    console.log(JSON.stringify(output, replacer, 2));
  } catch (err) {
    logger.error("Status failed", { error: formatError(err) });
    throw err;
  }
};
