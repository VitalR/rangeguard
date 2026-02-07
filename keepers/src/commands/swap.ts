import { Token } from "@uniswap/sdk-core";
import { TickMath } from "@uniswap/v3-sdk";
import { encodeAbiParameters, parseUnits, zeroAddress } from "viem";
import { createClients } from "../clients";
import { loadConfig } from "../config";
import { erc20Abi } from "../abi/ERC20";
import { permit2Abi } from "../abi/Permit2";
import { poolSwapTestAbi } from "../abi/PoolSwapTest";
import { buildPoolKey, getPoolKeyFromPosition } from "../uniswap/pool";
import { formatQuotePrice, quoteExactInputSingle } from "../uniswap/quoter";
import { readErc20Allowance, readPermit2Allowance } from "../uniswap/permit2";
import { logger } from "../logger";
import { formatError, invariant, KeeperError } from "../utils/errors";
import { createRunId, hashCalldata, outputReport, RunReport } from "../report";
import { deadlineFromNow, nowSeconds } from "../utils/time";
import { fetchVaultState } from "../vault/state";

type SwapOptions = {
  send?: boolean;
  amount0?: string;
  amount1?: string;
  json?: boolean;
  out?: string;
  verbose?: boolean;
};

const toBigInt = (value: { toString(): string } | bigint): bigint =>
  typeof value === "bigint" ? value : BigInt(value.toString());

const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = Number((1n << 48n) - 1n);
const DEFAULT_PERMIT2_EXPIRATION_SECONDS = 60 * 60 * 24;

const minSqrtPriceX96 = (): bigint => toBigInt(TickMath.MIN_SQRT_RATIO) + 1n;
const maxSqrtPriceX96 = (): bigint => toBigInt(TickMath.MAX_SQRT_RATIO) - 1n;

const ACTIONS = {
  SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  TAKE: 0x0e
} as const;

const COMMANDS = {
  V4_SWAP: 0x10
} as const;

export const swapCommand = async (options: SwapOptions = {}) => {
  try {
    const config = await loadConfig();
    const { publicClient, walletClient, account } = createClients(config);

    if (!config.swapRouterAddress) {
      throw new KeeperError("SWAP_ROUTER_ADDRESS is required for swap");
    }
    if (!config.poolManagerAddress) {
      throw new KeeperError("POOL_MANAGER_ADDRESS is required for swap");
    }
    const routerCode = await publicClient.getBytecode({ address: config.swapRouterAddress });
    if (!routerCode || routerCode === "0x") {
      throw new KeeperError("SWAP_ROUTER_ADDRESS has no code; deploy PoolSwapTest and update .env");
    }
    let routerKind: "poolSwapTest" | "universalRouter";
    let routerPoolManager: string;
    let managerError: unknown;
    try {
      const manager = (await publicClient.readContract({
        address: config.swapRouterAddress,
        abi: [{ type: "function", name: "manager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
        functionName: "manager"
      })) as string;
      routerKind = "poolSwapTest";
      routerPoolManager = manager;
    } catch (err) {
      managerError = err;
      try {
        const poolManager = (await publicClient.readContract({
          address: config.swapRouterAddress,
          abi: [{ type: "function", name: "poolManager", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
          functionName: "poolManager"
        })) as string;
        routerKind = "universalRouter";
        routerPoolManager = poolManager;
      } catch (innerErr) {
        throw new KeeperError("SWAP_ROUTER_ADDRESS is not PoolSwapTest or UniversalRouter", {
          managerError: formatError(managerError),
          poolManagerError: formatError(innerErr)
        });
      }
    }
    if (routerPoolManager.toLowerCase() !== config.poolManagerAddress.toLowerCase()) {
      throw new KeeperError("SWAP_ROUTER_ADDRESS uses a different PoolManager", {
        routerManager: routerPoolManager,
        expected: config.poolManagerAddress
      });
    }

    const chainId = await publicClient.getChainId();
    invariant(chainId === config.chainId, `Chain ID mismatch: RPC=${chainId}, expected=${config.chainId}`);

    if (!options.amount0 && !options.amount1) {
      throw new KeeperError("Provide --amount0 or --amount1 to swap");
    }
    if (options.amount0 && options.amount1) {
      throw new KeeperError("Provide only one of --amount0 or --amount1");
    }

    const { state: stateBefore, context } = await fetchVaultState(config, publicClient);

    const fee = config.poolFee;
    const tickSpacing = config.poolTickSpacing;
    const hooks = config.poolHooks ?? zeroAddress;
    const token0Currency = new Token(config.chainId, context.token0, Number(context.token0Decimals));
    const token1Currency = new Token(config.chainId, context.token1, Number(context.token1Decimals));
    const poolKey = context.position?.initialized
      ? await getPoolKeyFromPosition(publicClient, context.positionManager, context.position.positionId)
      : (() => {
          if (fee === undefined || tickSpacing === undefined) {
            throw new KeeperError("POOL_FEE and POOL_TICK_SPACING are required for swap");
          }
          return buildPoolKey(token0Currency, token1Currency, fee, tickSpacing, hooks);
        })();

    const runId = createRunId();
    const useAmount0 = options.amount0 !== undefined;
    const amountIn = parseUnits(
      useAmount0 ? options.amount0 ?? "0" : options.amount1 ?? "0",
      Number(useAmount0 ? context.token0Decimals : context.token1Decimals)
    );
    if (amountIn <= 0n) {
      throw new KeeperError("Swap amount must be positive");
    }
    if (routerKind === "universalRouter" && amountIn > MAX_UINT128) {
      throw new KeeperError("Swap amount exceeds uint128 required by UniversalRouter");
    }

    const zeroForOne = useAmount0
      ? context.token0.toLowerCase() === poolKey.currency0.toLowerCase()
      : context.token1.toLowerCase() === poolKey.currency0.toLowerCase();
    const tokenIn = useAmount0 ? context.token0 : context.token1;
    const tokenOut = zeroForOne ? poolKey.currency1 : poolKey.currency0;
    const balanceIn = (await publicClient.readContract({
      address: tokenIn,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address]
    })) as bigint;
    if (amountIn > balanceIn) {
      throw new KeeperError("Insufficient balance for swap", {
        tokenIn,
        balance: balanceIn.toString(),
        amountIn: amountIn.toString()
      });
    }
    let approvalTxHash: `0x${string}` | undefined;
    let permit2ApprovalTxHash: `0x${string}` | undefined;
    if (routerKind === "poolSwapTest") {
      const allowanceIn = (await publicClient.readContract({
        address: tokenIn,
        abi: erc20Abi,
        functionName: "allowance",
        args: [account.address, config.poolManagerAddress]
      })) as bigint;
      if (allowanceIn < amountIn) {
        if (!options.send) {
          throw new KeeperError("ERC20 allowance to PoolManager is insufficient; re-run with --send to auto-approve", {
            tokenIn,
            allowance: allowanceIn.toString(),
            amountIn: amountIn.toString()
          });
        }
        logger.warn("Approving PoolManager for swap", {
          tokenIn,
          spender: config.poolManagerAddress,
          amount: amountIn.toString()
        });
        approvalTxHash = await walletClient.writeContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [config.poolManagerAddress, amountIn],
          account
        });
        await publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
      }
    } else {
      if (!config.permit2Address) {
        throw new KeeperError("PERMIT2 is required for UniversalRouter swap");
      }
      if (amountIn > MAX_UINT160) {
        throw new KeeperError("Swap amount exceeds uint160 required by Permit2");
      }
      const permit2 = config.permit2Address;
      const [erc20Allowance, permit2Allowance] = await Promise.all([
        readErc20Allowance(publicClient, tokenIn, account.address, permit2),
        readPermit2Allowance(publicClient, permit2, account.address, tokenIn, config.swapRouterAddress)
      ]);
      if (erc20Allowance < amountIn) {
        if (!options.send) {
          throw new KeeperError("ERC20 allowance to Permit2 is insufficient; re-run with --send to auto-approve", {
            tokenIn,
            allowance: erc20Allowance.toString(),
            amountIn: amountIn.toString()
          });
        }
        logger.warn("Approving Permit2 for swap", {
          tokenIn,
          spender: permit2,
          amount: amountIn.toString()
        });
        approvalTxHash = await walletClient.writeContract({
          address: tokenIn,
          abi: erc20Abi,
          functionName: "approve",
          args: [permit2, amountIn],
          account
        });
        await publicClient.waitForTransactionReceipt({ hash: approvalTxHash });
      }
      const permit2NeedsApproval = permit2Allowance.expired || permit2Allowance.amount < amountIn;
      if (permit2NeedsApproval) {
        if (!options.send) {
          throw new KeeperError("Permit2 allowance to UniversalRouter is insufficient; re-run with --send to auto-approve", {
            tokenIn,
            allowance: permit2Allowance.amount.toString(),
            expiration: permit2Allowance.expiration,
            amountIn: amountIn.toString()
          });
        }
        const expiration = Math.min(nowSeconds() + DEFAULT_PERMIT2_EXPIRATION_SECONDS, MAX_UINT48);
        logger.warn("Approving Permit2 allowance for UniversalRouter", {
          tokenIn,
          spender: config.swapRouterAddress,
          amount: amountIn.toString(),
          expiration
        });
        permit2ApprovalTxHash = await walletClient.writeContract({
          address: permit2,
          abi: permit2Abi,
          functionName: "approve",
          args: [tokenIn, config.swapRouterAddress, amountIn, expiration],
          account
        });
        await publicClient.waitForTransactionReceipt({ hash: permit2ApprovalTxHash });
      }
    }
    const sqrtPriceLimitX96 = zeroForOne ? minSqrtPriceX96() : maxSqrtPriceX96();

    let amountOutQuoted: bigint | null = null;
    let quotePrice: string | null = null;
    const warnings: string[] = [];
    if (config.quoterAddress) {
      try {
        amountOutQuoted = await quoteExactInputSingle(publicClient, {
          quoter: config.quoterAddress,
          poolKey,
          zeroForOne,
          exactAmount: amountIn,
          hookData: config.policy.hookDataHex
        });
        quotePrice = formatQuotePrice(
          amountIn,
          amountOutQuoted,
          Number(useAmount0 ? context.token0Decimals : context.token1Decimals),
          Number(useAmount0 ? context.token1Decimals : context.token0Decimals)
        );
      } catch (err) {
        warnings.push(`Quote failed; proceeding without quote (${formatError(err)})`);
        amountOutQuoted = null;
        quotePrice = null;
      }
    }

    let simulation;
    if (routerKind === "poolSwapTest") {
      const swapParams = {
        zeroForOne,
        amountSpecified: -amountIn,
        sqrtPriceLimitX96
      };
      simulation = await publicClient.simulateContract({
        address: config.swapRouterAddress,
        abi: poolSwapTestAbi,
        functionName: "swap",
        args: [
          poolKey,
          swapParams,
          { takeClaims: false, settleUsingBurn: false },
          config.policy.hookDataHex
        ],
        account: account.address
      });
    } else {
      const actions = `0x${[
        ACTIONS.SWAP_EXACT_IN_SINGLE,
        ACTIONS.SETTLE,
        ACTIONS.TAKE
      ]
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("")}`;
      const swapParamsEncoded = encodeAbiParameters(
        [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" }
            ]
          },
          { name: "zeroForOne", type: "bool" },
          { name: "amountIn", type: "uint128" },
          { name: "amountOutMinimum", type: "uint128" },
          { name: "hookData", type: "bytes" }
        ],
        [poolKey, zeroForOne, amountIn, 0n, config.policy.hookDataHex]
      );
      const settleParamsEncoded = encodeAbiParameters(
        [
          { name: "currency", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "payerIsUser", type: "bool" }
        ],
        [tokenIn, 0n, true]
      );
      const takeParamsEncoded = encodeAbiParameters(
        [
          { name: "currency", type: "address" },
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        [tokenOut, account.address, 0n]
      );
      const unlockData = encodeAbiParameters(
        [
          { name: "actions", type: "bytes" },
          { name: "params", type: "bytes[]" }
        ],
        [actions, [swapParamsEncoded, settleParamsEncoded, takeParamsEncoded]]
      );
      const commands = `0x${COMMANDS.V4_SWAP.toString(16).padStart(2, "0")}`;
      const deadline = deadlineFromNow(config.defaultDeadlineSeconds);
      simulation = await publicClient.simulateContract({
        address: config.swapRouterAddress,
        abi: [
          {
            type: "function",
            name: "execute",
            stateMutability: "payable",
            inputs: [
              { name: "commands", type: "bytes" },
              { name: "inputs", type: "bytes[]" },
              { name: "deadline", type: "uint256" }
            ],
            outputs: []
          }
        ],
        functionName: "execute",
        args: [commands, [unlockData], deadline],
        account: account.address
      });
    }

    let gasEstimate: bigint | undefined;
    if (options.verbose) {
      try {
        gasEstimate = await publicClient.estimateContractGas(simulation.request);
      } catch {
        gasEstimate = undefined;
      }
    }

    const dryRun = !options.send;
    const report: RunReport = {
      runId,
      command: "swap",
      createdAt: new Date().toISOString(),
      chainId,
      addresses: {
        vault: config.vaultAddress,
        positionManager: config.positionManagerAddress ?? context.positionManager,
        poolId: stateBefore.pool.poolId ?? undefined,
        token0: context.token0,
        token1: context.token1,
        quoter: config.quoterAddress
      },
      tokens: {
        token0: { address: context.token0, decimals: context.token0Decimals },
        token1: { address: context.token1, decimals: context.token1Decimals }
      },
      policy: config.policy,
      decision: { action: "execute", reason: dryRun ? "dry-run" : "send" },
      stateBefore,
      warnings: warnings.length > 0 ? warnings : undefined,
      plan: {
        direction: useAmount0 ? "token0->token1" : "token1->token0",
        router: routerKind,
        amountIn: amountIn.toString(),
        amountOut: amountOutQuoted ? amountOutQuoted.toString() : "n/a",
        price: quotePrice ?? "n/a",
        zeroForOne,
        sqrtPriceLimitX96: sqrtPriceLimitX96.toString()
      }
    };

    if (options.verbose || approvalTxHash || permit2ApprovalTxHash) {
      const calldata = (simulation.request as { data?: `0x${string}` }).data;
      report.debug = {
        calldataHash: hashCalldata(calldata),
        gasEstimate: gasEstimate?.toString(),
        approvalTxHash,
        permit2ApprovalTxHash
      };
    }

    if (dryRun) {
      report.tx = { dryRun: true };
      report.stateAfter = stateBefore;
      await outputReport(report, options);
      return;
    }

    const hash = await walletClient.writeContract({ ...simulation.request, account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    report.tx = {
      dryRun: false,
      hash,
      blockNumber: receipt.blockNumber?.toString()
    };
    report.stateAfter = stateBefore;

    if (options.verbose) {
      report.debug = {
        ...(report.debug ?? {}),
        receiptLogsCount: receipt.logs.length
      };
    }

    await outputReport(report, options);
  } catch (err) {
    logger.error("Swap failed", { error: formatError(err) });
    throw err;
  }
};
