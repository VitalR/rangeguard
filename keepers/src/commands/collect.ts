import { Token } from "@uniswap/sdk-core";
import { keccak256 } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { getPoolKeyFromPosition, buildPoolFromState } from "../uniswap/pool";
import { buildCollectUnlockData } from "../uniswap/planner";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";

type CollectOptions = {
  send?: boolean;
};

export const collectCommand = async (options: CollectOptions) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [token0, token1, token0Decimals, token1Decimals, keeper, positionManager, ticks, initialized] =
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

    if (!initialized) {
      throw new KeeperError("Vault position not initialized");
    }

    invariant(
      keeper.toLowerCase() === account.address.toLowerCase(),
      "Vault keeper does not match configured key",
      { keeper, configured: account.address }
    );

    const positionId = ticks[3] as bigint;
    const positionManagerAddress = config.positionManagerAddress ?? positionManager;

    const poolKey = await getPoolKeyFromPosition(publicClient, positionManagerAddress, positionId);
    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
    const { pool } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      poolKey,
      token0Currency,
      token1Currency,
      config.poolId
    );

    const unlockData = buildCollectUnlockData({
      tokenId: positionId,
      hookData: config.policy.hookDataHex,
      currency0: pool.currency0,
      currency1: pool.currency1,
      recipient: config.vaultAddress
    });

    await assertCooldown(config.policy, config.vaultAddress, "collect");

    const params = {
      deadline: deadlineFromNow(config.defaultDeadlineSeconds),
      unlockData,
      callValue: 0n,
      maxApprove0: 0n,
      maxApprove1: 0n
    };

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

    const dryRun = !options.send;
    logger.info(dryRun ? "Dry run: collect" : "Sending collect", {
      positionId: positionId.toString(),
      unlockDataHash: keccak256(unlockData),
      params
    });

    if (dryRun) {
      return;
    }

    const [balance0Before, balance1Before] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token0]
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token1]
      })
    ]);

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "collect",
      args: [params],
      account: account.address
    });

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    logger.info("Collect tx sent", { hash });
    await publicClient.waitForTransactionReceipt({ hash });

    const [balance0After, balance1After] = await Promise.all([
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token0]
      }),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "balanceOf",
        args: [token1]
      })
    ]);

    logger.info("Collect balances", {
      balance0Before,
      balance0After,
      balance1Before,
      balance1After
    });

    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Collect failed", { error: formatError(err) });
    throw err;
  }
};
