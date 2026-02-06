import { Token } from "@uniswap/sdk-core";
import { zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { erc20Abi } from "../abi/ERC20";
import { getPoolKeyFromPosition, buildPoolKey, getPoolSlot0 } from "../uniswap/pool";
import { checkPermit2Allowances } from "../uniswap/permit2";
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

    const [
      token0,
      token1,
      token0Decimals,
      token1Decimals,
      keeper,
      maxSlippageBps,
      positionManager,
      ticks,
      initialized
    ] = await Promise.all([
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

    const [token0Balance, token1Balance, ethBalance] = await Promise.all([
      publicClient.readContract({
        address: token0,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [config.vaultAddress]
      }),
      publicClient.readContract({
        address: token1,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [config.vaultAddress]
      }),
      publicClient.getBalance({ address: config.vaultAddress })
    ]);

    invariant(
      keeper.toLowerCase() === account.address.toLowerCase(),
      "Vault keeper does not match configured key",
      { keeper, configured: account.address }
    );

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

    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));

    let currentTick: number | null = null;
    let poolId: string | null = null;
    const hooks = config.poolHooks ?? zeroAddress;
    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;

    if (initialized) {
      const positionManagerAddress = config.positionManagerAddress ?? positionManager;
      const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);
      const poolState = await getPoolSlot0(
        publicClient,
        config.stateViewAddress,
        poolKey,
        token0Currency,
        token1Currency
      );
      currentTick = poolState.tickCurrent;
      poolId = poolState.poolId;

      await checkPermit2Allowances({
        publicClient,
        vault: config.vaultAddress,
        positionManager: positionManagerAddress,
        token0,
        token1,
        required0: 0n,
        required1: 0n,
        throwOnMissing: false
      });
    } else if (fee !== undefined && tickSpacing !== undefined) {
      const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
      const poolState = await getPoolSlot0(
        publicClient,
        config.stateViewAddress,
        poolKey,
        token0Currency,
        token1Currency
      );
      currentTick = poolState.tickCurrent;
      poolId = poolState.poolId;
    } else {
      logger.warn("Missing pool config; cannot derive poolId/tick", {
        poolFee: fee,
        poolTickSpacing: tickSpacing
      });
    }

    if (poolId && config.poolId && config.poolId !== poolId) {
      logger.warn("POOL_ID override does not match derived poolId", {
        derived: poolId,
        override: config.poolId
      });
    }

    const widthTicks = config.policy.widthTicks;
    const edgeThresholdTicks = Math.max(1, Math.floor((widthTicks * config.policy.edgeBps) / 10_000));

    const inRange =
      currentTick !== null && initialized ? currentTick > lower && currentTick < upper : null;
    const outOfRange =
      currentTick !== null && initialized ? currentTick <= lower || currentTick >= upper : null;
    const nearEdge =
      currentTick !== null && initialized
        ? currentTick <= lower + edgeThresholdTicks || currentTick >= upper - edgeThresholdTicks
        : null;

    let healthBps: number | null = null;
    const width = upper - lower;
    if (currentTick !== null && initialized && width > 0) {
      if (currentTick <= lower || currentTick >= upper) {
        healthBps = 0;
      } else {
        const distance = Math.min(currentTick - lower, upper - currentTick);
        healthBps = Math.max(0, Math.min(10_000, Math.floor((distance * 10_000) / width)));
      }
    }

    let suggested: { lower: number; upper: number } | null = null;
    if (currentTick !== null && spacing > 0) {
      try {
        suggested = centerRange(currentTick, widthTicks, spacing);
      } catch (err) {
        logger.warn("Failed to compute suggested range", { error: formatError(err) });
      }
    }

    const output = {
      vaultBalances: {
        token0: token0Balance,
        token1: token1Balance,
        eth: ethBalance
      },
      position: {
        initialized,
        positionId: positionId.toString(),
        lower,
        upper,
        spacing
      },
      pool: {
        poolId,
        tick: currentTick
      },
      inRange,
      outOfRange,
      nearEdge,
      healthBps,
      suggested,
      policy: config.policy
    };

    console.log(JSON.stringify(output, replacer, 2));
  } catch (err) {
    logger.error("Status failed", { error: formatError(err) });
    throw err;
  }
};
