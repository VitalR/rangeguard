import { Token } from "@uniswap/sdk-core";
import { keccak256, parseUnits, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey, buildPoolFromState } from "../uniswap/pool";
import { centerRange } from "../uniswap/ticks";
import { buildPositionFromAmounts, slippagePercent } from "../uniswap/position";
import { buildBootstrapUnlockData } from "../uniswap/planner";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";

type BootstrapOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const bootstrapCommand = async (options: BootstrapOptions) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [token0, token1, token0Decimals, token1Decimals, keeper, maxSlippageBps, positionManager, initialized] =
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
          functionName: "isPositionInitialized"
        })
      ]);

    if (initialized) {
      throw new KeeperError("Vault position already initialized");
    }

    if (keeper.toLowerCase() !== account.address.toLowerCase()) {
      logger.warn("Vault keeper does not match configured key", { keeper, configured: account.address });
    }

    if (config.policy.maxSlippageBps > Number(maxSlippageBps)) {
      throw new KeeperError("policy.maxSlippageBps exceeds vault maxSlippageBps");
    }

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? zeroAddress;
    if (fee === undefined || tickSpacing === undefined) {
      throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for bootstrap");
    }

    const token0Currency = new Token(config.chainId, token0, Number(token0Decimals));
    const token1Currency = new Token(config.chainId, token1, Number(token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);

    const { pool, tickCurrent } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      {
        currency0: token0 as `0x${string}`,
        currency1: token1 as `0x${string}`,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks as `0x${string}`
      },
      token0Currency,
      token1Currency,
      config.poolId
    );

    const { lower, upper } = centerRange(tickCurrent, config.policy.widthTicks, tickSpacing);

    await assertCooldown(config.policy, config.vaultAddress, "bootstrap");

    const [balance0, balance1] = await Promise.all([
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

    let amount0 = balance0 as bigint;
    let amount1 = balance1 as bigint;
    if (!config.policy.useFullBalances) {
      if (!options.amount0 || !options.amount1) {
        throw new KeeperError("Provide --amount0 and --amount1 when useFullBalances=false");
      }
      amount0 = parseUnits(options.amount0, Number(token0Decimals));
      amount1 = parseUnits(options.amount1, Number(token1Decimals));
    }

    const position = buildPositionFromAmounts({
      pool,
      tickLower: lower,
      tickUpper: upper,
      amount0,
      amount1
    });

    const slippage = slippagePercent(config.policy.maxSlippageBps);
    const mintAmounts = position.mintAmountsWithSlippage(slippage);

    const liquidity = toBigInt(position.liquidity);
    const amount0Max = toBigInt(mintAmounts.amount0);
    const amount1Max = toBigInt(mintAmounts.amount1);

    const unlockData = buildBootstrapUnlockData({
      pool,
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      amount0Max,
      amount1Max,
      owner: config.vaultAddress,
      hookData: config.policy.hookDataHex
    });

    const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
    const params = {
      tickLower: lower,
      tickUpper: upper,
      tickSpacing,
      deadline,
      unlockData,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      callValue: 0n
    };

    const expectedTokenId = (await publicClient.readContract({
      address: config.positionManagerAddress ?? positionManager,
      abi: [
        {
          type: "function",
          name: "nextTokenId",
          stateMutability: "view",
          inputs: [],
          outputs: [{ name: "", type: "uint256" }]
        }
      ],
      functionName: "nextTokenId"
    })) as bigint;

    const dryRun = !options.send;
    logger.info(dryRun ? "Dry run: bootstrap" : "Sending bootstrap", {
      expectedTokenId: expectedTokenId.toString(),
      unlockDataHash: keccak256(unlockData),
      params
    });

    if (dryRun) {
      return;
    }

    const simulation = await publicClient.simulateContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "bootstrapPosition",
      args: [params],
      account: account.address
    });

    const hash = await walletClient.writeContract(simulation.request);
    logger.info("Bootstrap tx sent", { hash });

    const updatedTicks = await publicClient.readContract({
      address: config.vaultAddress,
      abi: rangeGuardVaultAbi,
      functionName: "ticks"
    });
    logger.info("Bootstrap complete", {
      positionId: updatedTicks[3].toString(),
      lower: Number(updatedTicks[0]),
      upper: Number(updatedTicks[1]),
      spacing: Number(updatedTicks[2])
    });

    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Bootstrap failed", { error: formatError(err) });
    throw err;
  }
};
