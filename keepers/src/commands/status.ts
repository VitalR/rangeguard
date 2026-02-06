import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { formatError, invariant } from "../utils/errors";
import { createRunId, outputReport, RunReport } from "../report";
import { fetchVaultState } from "../vault/state";

export type StatusOptions = {
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

export const statusCommand = async (options: StatusOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [{ state, context }, maxSlippageBps] = await Promise.all([
      fetchVaultState(config, publicClient, account),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "maxSlippageBps"
      })
    ]);

    const warnings: string[] = [];

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      warnings.push("Policy maxSlippageBps exceeds vault maxSlippageBps");
    }

    if (context.initialized) {
      const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;
      await checkPermit2Allowances({
        publicClient,
        vault: config.vaultAddress,
        positionManager: positionManagerAddress,
        token0: context.token0,
        token1: context.token1,
        required0: 0n,
        required1: 0n,
        throwOnMissing: false
      });
    }

    const runId = createRunId();
    const report: RunReport = {
      runId,
      command: "status",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: config.positionManagerAddress ?? context.positionManager,
        poolId: state.pool.poolId ?? undefined,
        token0: context.token0,
        token1: context.token1,
        quoter: config.quoterAddress
      },
      tokens: {
        token0: { address: context.token0, decimals: context.token0Decimals },
        token1: { address: context.token1, decimals: context.token1Decimals }
      },
      policy: config.policy,
      decision: { action: "execute", reason: "status" },
      stateBefore: state,
      warnings
    };

    await outputReport(report, options);
  } catch (err) {
    logger.error("Status failed", { error: formatError(err) });
    throw err;
  }
};
