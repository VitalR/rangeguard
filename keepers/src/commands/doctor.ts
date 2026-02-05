import { Token } from "@uniswap/sdk-core";
import { zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { erc20Abi } from "../abi/ERC20";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey, getPoolSlot0 } from "../uniswap/pool";
import { logger } from "../logger";
import { formatError, invariant, KeeperError } from "../utils/errors";

const redactPrivateKey = (value: string): string => {
  if (value.length <= 10) {
    return "0x***";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

export const doctorCommand = async () => {
  try {
    const config = await loadConfig();
    const { publicClient, account } = createClients(config);

    logger.info("Loaded config", {
      config: {
        ...config,
        keeperPrivateKey: redactPrivateKey(config.keeperPrivateKey)
      }
    });

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [vaultKeeper, positionManager, vaultToken0, vaultToken1, vaultTicks] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "keeper"
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "positionManager"
      }),
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
        functionName: "ticks"
      })
    ]);

    const errors: string[] = [];
    const warnings: string[] = [];

    if (vaultKeeper.toLowerCase() !== account.address.toLowerCase()) {
      errors.push(`keeper mismatch: vault=${vaultKeeper}, derived=${account.address}`);
    }

    if (
      config.positionManagerAddress &&
      config.positionManagerAddress.toLowerCase() !== positionManager.toLowerCase()
    ) {
      warnings.push(`positionManager mismatch: vault=${positionManager}, env=${config.positionManagerAddress}`);
    }

    if (!config.token0 || !config.token1) {
      errors.push("TOKEN0 and TOKEN1 must be set to verify vault token addresses");
    } else {
      if (config.token0.toLowerCase() !== vaultToken0.toLowerCase()) {
        errors.push(`token0 mismatch: vault=${vaultToken0}, env=${config.token0}`);
      }
      if (config.token1.toLowerCase() !== vaultToken1.toLowerCase()) {
        errors.push(`token1 mismatch: vault=${vaultToken1}, env=${config.token1}`);
      }
    }

    const spacingFromVault = Number(vaultTicks[2]);
    const tickSpacing = config.poolTickSpacing ?? (spacingFromVault > 0 ? spacingFromVault : undefined);
    const fee = config.poolFee;
    const hooks = config.poolHooks ?? zeroAddress;

    if (!tickSpacing) {
      errors.push("POOL_TICK_SPACING is required (or vault tick spacing must be set)");
    } else if (config.policy.widthTicks % tickSpacing !== 0) {
      errors.push("policy.widthTicks must be a multiple of tick spacing");
    }

    if (fee === undefined) {
      errors.push("POOL_FEE is required to derive the poolId");
    }

    if (config.token0 && config.token1 && fee !== undefined && tickSpacing) {
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
      const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
      const poolState = await getPoolSlot0(
        publicClient,
        config.stateViewAddress,
        poolKey,
        token0Currency,
        token1Currency
      );

      if (config.poolId && config.poolId !== poolState.poolId) {
        warnings.push(`POOL_ID override does not match derived poolId: derived=${poolState.poolId}, env=${config.poolId}`);
      }

      logger.info("Pool state", { poolId: poolState.poolId, tick: poolState.tickCurrent });
    } else {
      errors.push("Missing TOKEN0/TOKEN1/POOL_FEE/POOL_TICK_SPACING to derive poolId and read tick");
    }

    if (warnings.length > 0) {
      logger.warn("Doctor warnings", { warnings });
    }

    if (errors.length > 0) {
      throw new KeeperError("Doctor failed", { errors });
    }

    logger.info("Doctor OK");
  } catch (err) {
    logger.error("Doctor failed", { error: formatError(err) });
    throw err;
  }
};
