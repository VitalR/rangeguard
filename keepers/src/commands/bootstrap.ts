import { Token } from "@uniswap/sdk-core";
import { keccak256, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { rangeGuardVaultAbi } from "../abi/RangeGuardVault";
import { buildPoolKey, buildPoolFromState } from "../uniswap/pool";
import { computeBootstrapTicks } from "../uniswap/ticks";
import {
  buildPositionFromAmounts,
  computeBoundaryLiquidity,
  computeBoundaryMinAmountForLiquidityOne,
  getBoundarySqrtRatios
} from "../uniswap/position";
import { buildBootstrapUnlockData } from "../uniswap/planner";
import { decodeUniswapError, extractRevertData, getRevertHint } from "../uniswap/errorDecoder";
import { checkPermit2Allowances } from "../uniswap/permit2";
import { logger } from "../logger";
import { deadlineFromNow } from "../utils/time";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { assertCooldown, recordAction } from "../policy/policy";
import { selectAmounts } from "../amounts";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { parseVaultEvents } from "../vault/events";
import { fetchVaultState } from "../vault/state";
import { isPoolInitialized } from "../uniswap/poolState";
import { assertTickNotNearBounds, isTickNearBounds, tickSanityMessage } from "../uniswap/sanity";

type BootstrapOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  bufferBps?: string;
  maxSpendBps?: string;
  widthTicks?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

export const bootstrapCommand = async (options: BootstrapOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    const [{ state: stateBefore, context }, maxSlippageBps] = await Promise.all([
      fetchVaultState(config, publicClient, account),
      publicClient.readContract({
        address: config.vaultAddress,
        abi: rangeGuardVaultAbi,
        functionName: "maxSlippageBps"
      })
    ]);

    if (context.positionIds.length > 0) {
      logger.warn("Vault already tracks positions; bootstrap will add another", {
        positionIds: context.positionIds.map((id) => id.toString())
      });
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

    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const poolKey = buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);

    const { pool, poolId, tickCurrent, sqrtPriceX96 } = await buildPoolFromState(
      publicClient,
      config.stateViewAddress,
      {
        currency0: context.token0,
        currency1: context.token1,
        fee: poolKey.fee,
        tickSpacing: poolKey.tickSpacing,
        hooks: poolKey.hooks as `0x${string}`
      },
      token0Currency,
      token1Currency,
      config.poolId
    );

    const poolInit = isPoolInitialized({ sqrtPriceX96, tick: tickCurrent });
    if (!poolInit.initialized && sqrtPriceX96 === 0n) {
      throw new KeeperError(
        `Pool appears UNINITIALIZED (${poolInit.reason}). Run: npm run initPool -- --priceUsdcPerWeth 2000 --send`,
        { poolId, poolKey }
      );
    }
    assertTickNotNearBounds(tickCurrent);

    const widthTicks =
      options.widthTicks !== undefined ? Number(options.widthTicks) : config.policy.widthTicks;
    if (!Number.isFinite(widthTicks) || widthTicks <= 0) {
      throw new KeeperError("widthTicks must be a positive integer");
    }
    if (widthTicks % tickSpacing !== 0 || widthTicks % (2 * tickSpacing) !== 0) {
      throw new KeeperError("widthTicks/2 must align to tick spacing");
    }
    const policy = { ...config.policy, widthTicks };

    const { lower, upper, mode, maxAligned, minAligned } = computeBootstrapTicks(
      tickCurrent,
      tickSpacing,
      widthTicks
    );

    await assertCooldown(config.policy, config.vaultAddress, "bootstrap");

    const bootstrapWarnings: string[] = [];
    if (tickCurrent >= maxAligned || tickCurrent <= minAligned) {
      bootstrapWarnings.push(
        "Pool tick is at extreme bound; pool may be uninitialized or POOL_ID/fee/spacing/hooks may be wrong"
      );
    }
    if (isTickNearBounds(tickCurrent)) {
      bootstrapWarnings.push(tickSanityMessage(tickCurrent));
    }
    if (mode !== "IN_RANGE") {
      bootstrapWarnings.push(
        `Boundary tick mode active (${mode}); mint will be one-sided. Consider initializing a fresh demo pool if you need inRange.`
      );
    } else if (tickCurrent < lower || tickCurrent >= upper) {
      bootstrapWarnings.push("Computed bootstrap range does not include current tick");
    }

    const amountSelection = await selectAmounts({
      publicClient,
      poolKey,
      token0: context.token0,
      token1: context.token1,
      token0Decimals: context.token0Decimals,
      token1Decimals: context.token1Decimals,
      balance0: stateBefore.balances.token0,
      balance1: stateBefore.balances.token1,
      amount0Input: options.amount0,
      amount1Input: options.amount1,
      useFullBalances: policy.useFullBalances,
      quoterAddress: config.quoterAddress,
      hookData: policy.hookDataHex,
      bufferBps: options.bufferBps ? Number(options.bufferBps) : undefined,
      maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : undefined
    });

    let amount0 = amountSelection.amount0;
    let amount1 = amountSelection.amount1;
    const mintMode = mode === "ABOVE_MAX" ? "token1-only" : mode === "BELOW_MIN" ? "token0-only" : "in-range";

    const maxSpendBps = options.maxSpendBps ? Number(options.maxSpendBps) : 10_000;
    const limit0 = (stateBefore.balances.token0 * BigInt(maxSpendBps)) / 10_000n;
    const limit1 = (stateBefore.balances.token1 * BigInt(maxSpendBps)) / 10_000n;

    if (mode === "ABOVE_MAX") {
      if (amount1 <= 0n) {
        throw new KeeperError("Pool tick beyond max aligned tick; token1-only mint requires amount1 > 0", {
          amount0,
          amount1
        });
      }
      if (amount0 > 0n) {
        amount0 = 0n;
      }
    } else if (mode === "BELOW_MIN") {
      if (amount0 <= 0n) {
        throw new KeeperError("Pool tick below min aligned tick; token0-only mint requires amount0 > 0", {
          amount0,
          amount1
        });
      }
      if (amount1 > 0n) {
        amount1 = 0n;
      }
    } else if (lower <= tickCurrent && tickCurrent < upper) {
      if (amount0 <= 0n || amount1 <= 0n) {
        throw new KeeperError(
          "Range includes current tick; both token balances must be > 0. Deposit WETH to the vault and retry.",
          { amount0, amount1 }
        );
      }
    }

    let liquidity: bigint;
    let boundaryMinAmount: bigint | undefined;
    if (mode === "IN_RANGE") {
      const position = buildPositionFromAmounts({
        pool,
        tickLower: lower,
        tickUpper: upper,
        amount0,
        amount1
      });
      liquidity = toBigInt(position.liquidity);
    } else {
      const boundaryDetails = getBoundarySqrtRatios(lower, upper);
      boundaryMinAmount = computeBoundaryMinAmountForLiquidityOne({
        tickLower: lower,
        tickUpper: upper,
        mode
      });
      if (options.verbose) {
        logger.info("Boundary mint math", {
          tickLower: lower,
          tickUpper: upper,
          sqrtLowerX96: boundaryDetails.sqrtLowerX96.toString(),
          sqrtUpperX96: boundaryDetails.sqrtUpperX96.toString(),
          diff: boundaryDetails.diff.toString(),
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          minAmount: boundaryMinAmount.toString()
        });
      }
      if (mode === "ABOVE_MAX" && amount1 < boundaryMinAmount) {
        if (limit1 >= boundaryMinAmount) {
          amount1 = boundaryMinAmount;
          bootstrapWarnings.push(
            `amount1 bumped to minimum required for boundary mint (${boundaryMinAmount.toString()})`
          );
        } else {
          throw new KeeperError("amount1 too low for boundary mint; deposit more token1", {
            requiredAmount1: boundaryMinAmount.toString(),
            maxSpendAmount1: limit1.toString()
          });
        }
      } else if (mode === "BELOW_MIN" && amount0 < boundaryMinAmount) {
        if (limit0 >= boundaryMinAmount) {
          amount0 = boundaryMinAmount;
          bootstrapWarnings.push(
            `amount0 bumped to minimum required for boundary mint (${boundaryMinAmount.toString()})`
          );
        } else {
          throw new KeeperError("amount0 too low for boundary mint; deposit more token0", {
            requiredAmount0: boundaryMinAmount.toString(),
            maxSpendAmount0: limit0.toString()
          });
        }
      }
      liquidity = computeBoundaryLiquidity({
        tickLower: lower,
        tickUpper: upper,
        amount0,
        amount1,
        mode
      });
      if (options.verbose) {
        logger.info("Boundary liquidity result", {
          amount0: amount0.toString(),
          amount1: amount1.toString(),
          liquidity: liquidity.toString()
        });
      }
    }
    const amount0Max = amount0;
    const amount1Max = amount1;

    if (liquidity <= 0n) {
      throw new KeeperError("Computed liquidity is zero; adjust amounts or tick range", {
        tickLower: lower,
        tickUpper: upper,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        mode
      });
    }

    const unlockData = buildBootstrapUnlockData({
      pool,
      tickLower: lower,
      tickUpper: upper,
      liquidity,
      amount0Max,
      amount1Max,
      owner: config.vaultAddress,
      hookData: policy.hookDataHex
    });

    if (unlockData === "0x") {
      throw new KeeperError("Unlock data is empty");
    }

    const positionManagerAddress = config.positionManagerAddress ?? context.positionManager;
    const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
    await checkPermit2Allowances({
      publicClient,
      vault: config.vaultAddress,
      positionManager: positionManagerAddress,
      token0: context.token0,
      token1: context.token1,
      required0: amount0Max,
      required1: amount1Max,
      throwOnMissing: false,
      willSetPermit2: true,
      maxApprove0: amount0Max,
      maxApprove1: amount1Max,
      deadline
    });

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

    let gasEstimate: bigint | undefined;
    if (options.verbose) {
      try {
        gasEstimate = await publicClient.estimateContractGas(simulation.request);
      } catch {
        gasEstimate = undefined;
      }
    }

    const runId = createRunId();
    const report: RunReport = {
      runId,
      command: "bootstrap",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: positionManagerAddress,
        poolId,
        token0: context.token0,
        token1: context.token1,
        quoter: config.quoterAddress
      },
      tokens: {
        token0: { address: context.token0, decimals: context.token0Decimals },
        token1: { address: context.token1, decimals: context.token1Decimals }
      },
      policy,
      decision: { action: "execute", reason: dryRun ? "dry-run" : "send" },
      stateBefore,
      plan: {
        tickLower: lower,
        tickUpper: upper,
        tickSpacing,
        currentTick: tickCurrent,
        boundaryMode: mode,
        mintMode,
        minAlignedTick: minAligned,
        maxAlignedTick: maxAligned,
        widthTicks,
        amount0: amount0.toString(),
        amount1: amount1.toString(),
        bufferBps: options.bufferBps ? Number(options.bufferBps) : 200,
        maxSpendBps: options.maxSpendBps ? Number(options.maxSpendBps) : 10_000,
        quote: amountSelection.quote ?? null,
        boundaryMinAmount: boundaryMinAmount?.toString()
      },
      warnings: [...bootstrapWarnings, ...amountSelection.warnings]
    };

    if (options.verbose) {
      const calldata = (simulation.request as { data?: `0x${string}` }).data;
      report.debug = {
        unlockDataHash: keccak256(unlockData),
        unlockDataLength,
        calldataHash: hashCalldata(calldata),
        gasEstimate: gasEstimate?.toString()
      };
    }

    if (dryRun) {
      report.tx = {
        dryRun: true,
        expectedTokenId: expectedTokenId.toString()
      };
      report.stateAfter = stateBefore;
      await outputReport(report, options);
      return;
    }

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    const { state: stateAfter } = await fetchVaultState(config, publicClient, account);
    const events = parseVaultEvents(receipt.logs, config.vaultAddress);

    report.tx = {
      dryRun: false,
      hash,
      blockNumber: receipt.blockNumber?.toString(),
      events
    };
    report.stateAfter = stateAfter;

    if (options.verbose) {
      report.debug = {
        ...(report.debug ?? {}),
        receiptLogsCount: receipt.logs.length
      };
    }

    await outputReport(report, options);
    await recordAction(config.policy, config.vaultAddress);
  } catch (err) {
    logger.error("Bootstrap failed", { error: formatError(err) });
    throw err;
  }
};
