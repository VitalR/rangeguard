import { Token } from "@uniswap/sdk-core";
import { keccak256, parseUnits, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { erc20Abi } from "../abi/ERC20";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey, buildPoolFromState } from "../uniswap/pool";
import { computeBootstrapTicks } from "../uniswap/ticks";
import { buildPositionFromAmounts } from "../uniswap/position";
import { buildBootstrapUnlockData } from "../uniswap/planner";
import { decodeUniswapError, extractRevertData, getRevertHint } from "../uniswap/errorDecoder";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { applyBpsBuffer, formatQuotePrice, quoteExactInputSingle } from "../uniswap/quoter";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";

type BootstrapOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  quoteBpsBuffer?: string;
};

const minBigInt = (a: bigint, b: bigint): bigint => (a < b ? a : b);

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

    invariant(
      keeper.toLowerCase() === account.address.toLowerCase(),
      "Vault keeper does not match configured key",
      { keeper, configured: account.address }
    );

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

    const { lower, upper } = computeBootstrapTicks(tickCurrent, tickSpacing, config.policy.widthTicks);

    await assertCooldown(config.policy, config.vaultAddress, "bootstrap");

    const [balance0, balance1] = await Promise.all([
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
      })
    ]);

    let amount0 = balance0 as bigint;
    let amount1 = balance1 as bigint;
    if (!config.policy.useFullBalances) {
      if (!options.amount0 && !options.amount1) {
        throw new KeeperError("Provide --amount0 and/or --amount1 when useFullBalances=false");
      }
      if (options.amount0 && options.amount1) {
        amount0 = parseUnits(options.amount0, Number(token0Decimals));
        amount1 = parseUnits(options.amount1, Number(token1Decimals));
      } else if (options.amount0) {
        if (!config.quoterAddress) {
          throw new KeeperError("QUOTER_ADDRESS is required to derive token1 amount");
        }
        amount0 = parseUnits(options.amount0, Number(token0Decimals));
        const zeroForOne = token0.toLowerCase() === poolKey.currency0.toLowerCase();
        const quotedAmount1 = await quoteExactInputSingle(publicClient, {
          quoter: config.quoterAddress,
          poolKey,
          zeroForOne,
          exactAmount: amount0,
          hookData: config.policy.hookDataHex
        });
        const quoteBpsBuffer = options.quoteBpsBuffer ? Number(options.quoteBpsBuffer) : 200;
        amount1 = applyBpsBuffer(quotedAmount1, quoteBpsBuffer);
        const price = formatQuotePrice(amount0, quotedAmount1, Number(token0Decimals), Number(token1Decimals));
        logger.info("Derived token1 amount from quote", {
          amount0,
          quotedAmount1,
          amount1,
          priceToken1PerToken0: price,
          quoteBpsBuffer
        });
        if (amount1 > (balance1 as bigint)) {
          throw new KeeperError("Vault token1 balance is below required derived amount", {
            balance1,
            requiredAmount1: amount1
          });
        }
      } else {
        throw new KeeperError("Provide --amount0 when --amount1 is omitted");
      }
    } else {
      if (options.amount0) {
        const override0 = parseUnits(options.amount0, Number(token0Decimals));
        amount0 = minBigInt(amount0, override0);
      }
      if (options.amount1) {
        const override1 = parseUnits(options.amount1, Number(token1Decimals));
        amount1 = minBigInt(amount1, override1);
      }
    }

    if (lower <= tickCurrent && tickCurrent < upper) {
      if (amount0 <= 0n || amount1 <= 0n) {
        throw new KeeperError(
          "Range includes current tick; both token balances must be > 0. Deposit WETH to the vault and retry.",
          { amount0, amount1 }
        );
      }
    }

    const position = buildPositionFromAmounts({
      pool,
      tickLower: lower,
      tickUpper: upper,
      amount0,
      amount1
    });

    const liquidity = toBigInt(position.liquidity);
    const amount0Max = amount0;
    const amount1Max = amount1;

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

    if (unlockData === "0x") {
      throw new KeeperError("Unlock data is empty");
    }

    const positionManagerAddress = config.positionManagerAddress ?? positionManager;
    await checkPermit2Allowances({
      publicClient,
      vault: config.vaultAddress,
      positionManager: positionManagerAddress,
      token0,
      token1,
      required0: amount0Max,
      required1: amount1Max,
      throwOnMissing: false
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
      address: positionManagerAddress,
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
    const unlockDataLength = (unlockData.length - 2) / 2;
    logger.info(dryRun ? "Dry run: bootstrap" : "Sending bootstrap", {
      expectedTokenId: expectedTokenId.toString(),
      currentTick: tickCurrent,
      tickLower: lower,
      tickUpper: upper,
      tickSpacing,
      alignedLower: lower % tickSpacing === 0,
      alignedUpper: upper % tickSpacing === 0,
      amount0,
      amount1,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      callValue: 0n,
      unlockDataHash: keccak256(unlockData),
      unlockDataLength,
      params
    });

    let simulation;
    try {
      simulation = await publicClient.simulateContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "bootstrapPosition",
        args: [params],
        account: account.address
      });
    } catch (err) {
      const revertData = extractRevertData(err);
      const decoded = revertData ? decodeUniswapError(revertData) : null;
      if (decoded) {
        logger.error("Bootstrap revert decoded", {
          selector: decoded.selector,
          error: decoded.name,
          args: decoded.args,
          hint: getRevertHint(decoded.name)
        });
      } else if (revertData) {
        logger.error("Bootstrap revert selector", { selector: revertData.slice(0, 10) });
      }
      throw err;
    }

    if (dryRun) {
      logger.info("Dry run: bootstrap simulation ok");
      return;
    }

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    logger.info("Bootstrap tx sent", { hash, expectedTokenId: expectedTokenId.toString() });
    await publicClient.waitForTransactionReceipt({ hash });

    const [updatedTicks, updatedInitialized] = await Promise.all([
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
    logger.info("Bootstrap status", {
      initialized: updatedInitialized,
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
