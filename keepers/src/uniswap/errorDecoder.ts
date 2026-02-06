import { BaseError, ContractFunctionRevertedError, decodeErrorResult } from "viem";
import { Hex } from "../types";

const uniswapErrorAbi = [
  // v4 periphery
  { type: "error", name: "NotApproved", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "DeadlinePassed", inputs: [{ name: "deadline", type: "uint256" }] },
  { type: "error", name: "PoolManagerMustBeLocked", inputs: [] },
  { type: "error", name: "InputLengthMismatch", inputs: [] },
  { type: "error", name: "UnsupportedAction", inputs: [{ name: "action", type: "uint256" }] },
  { type: "error", name: "MaximumAmountExceeded", inputs: [{ name: "maximumAmount", type: "uint128" }, { name: "amountRequested", type: "uint128" }] },
  { type: "error", name: "MinimumAmountInsufficient", inputs: [{ name: "minimumAmount", type: "uint128" }, { name: "amountReceived", type: "uint128" }] },
  { type: "error", name: "ContractLocked", inputs: [] },
  { type: "error", name: "InvalidEthSender", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
  { type: "error", name: "DeltaNotPositive", inputs: [{ name: "currency", type: "address" }] },
  { type: "error", name: "DeltaNotNegative", inputs: [{ name: "currency", type: "address" }] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "SliceOutOfBounds", inputs: [] },
  { type: "error", name: "InvalidBips", inputs: [] },
  { type: "error", name: "InvalidAddressLength", inputs: [{ name: "len", type: "uint256" }] },
  // v4 core
  { type: "error", name: "CurrencyNotSettled", inputs: [] },
  { type: "error", name: "PoolNotInitialized", inputs: [] },
  { type: "error", name: "AlreadyUnlocked", inputs: [] },
  { type: "error", name: "ManagerLocked", inputs: [] },
  { type: "error", name: "TickSpacingTooLarge", inputs: [{ name: "tickSpacing", type: "int24" }] },
  { type: "error", name: "TickSpacingTooSmall", inputs: [{ name: "tickSpacing", type: "int24" }] },
  { type: "error", name: "CurrenciesOutOfOrderOrEqual", inputs: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }] },
  { type: "error", name: "UnauthorizedDynamicLPFeeUpdate", inputs: [] },
  { type: "error", name: "SwapAmountCannotBeZero", inputs: [] },
  { type: "error", name: "NonzeroNativeValue", inputs: [] },
  { type: "error", name: "MustClearExactPositiveDelta", inputs: [] },
  { type: "error", name: "HookAddressNotValid", inputs: [{ name: "hooks", type: "address" }] },
  { type: "error", name: "InvalidHookResponse", inputs: [] },
  { type: "error", name: "HookCallFailed", inputs: [] },
  { type: "error", name: "HookDeltaExceedsSwapAmount", inputs: [] },
  { type: "error", name: "NativeTransferFailed", inputs: [] },
  { type: "error", name: "ERC20TransferFailed", inputs: [] },
  { type: "error", name: "InvalidTick", inputs: [{ name: "tick", type: "int24" }] },
  { type: "error", name: "InvalidSqrtPrice", inputs: [{ name: "sqrtPriceX96", type: "uint160" }] },
  { type: "error", name: "TickMisaligned", inputs: [{ name: "tick", type: "int24" }, { name: "tickSpacing", type: "int24" }] },
  { type: "error", name: "InvalidPriceOrLiquidity", inputs: [] },
  { type: "error", name: "InvalidPrice", inputs: [] },
  { type: "error", name: "NotEnoughLiquidity", inputs: [] },
  { type: "error", name: "PriceOverflow", inputs: [] },
  { type: "error", name: "SafeCastOverflow", inputs: [] },
  { type: "error", name: "CannotUpdateEmptyPosition", inputs: [] },
  { type: "error", name: "TicksMisordered", inputs: [{ name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }] },
  { type: "error", name: "TickLowerOutOfBounds", inputs: [{ name: "tickLower", type: "int24" }] },
  { type: "error", name: "TickUpperOutOfBounds", inputs: [{ name: "tickUpper", type: "int24" }] },
  { type: "error", name: "TickLiquidityOverflow", inputs: [{ name: "tick", type: "int24" }] },
  { type: "error", name: "PoolAlreadyInitialized", inputs: [] },
  { type: "error", name: "PriceLimitAlreadyExceeded", inputs: [{ name: "sqrtPriceCurrentX96", type: "uint160" }, { name: "sqrtPriceLimitX96", type: "uint160" }] },
  { type: "error", name: "PriceLimitOutOfBounds", inputs: [{ name: "sqrtPriceLimitX96", type: "uint160" }] },
  { type: "error", name: "NoLiquidityToReceiveFees", inputs: [] },
  { type: "error", name: "InvalidFeeForExactOut", inputs: [] },
  { type: "error", name: "LPFeeTooLarge", inputs: [{ name: "fee", type: "uint24" }] },
  { type: "error", name: "WrappedError", inputs: [{ name: "target", type: "address" }, { name: "selector", type: "bytes4" }, { name: "reason", type: "bytes" }, { name: "details", type: "bytes" }] },
  { type: "error", name: "ProtocolFeeTooLarge", inputs: [{ name: "fee", type: "uint24" }] },
  { type: "error", name: "InvalidCaller", inputs: [] },
  { type: "error", name: "ProtocolFeeCurrencySynced", inputs: [] },
  { type: "error", name: "DelegateCallNotAllowed", inputs: [] },
  // permit2
  { type: "error", name: "AllowanceExpired", inputs: [{ name: "deadline", type: "uint256" }] },
  { type: "error", name: "InsufficientAllowance", inputs: [{ name: "amount", type: "uint256" }] },
  { type: "error", name: "ExcessiveInvalidation", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [{ name: "signatureDeadline", type: "uint256" }] },
  { type: "error", name: "InvalidAmount", inputs: [{ name: "maxAmount", type: "uint256" }] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "InvalidSignatureLength", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidSigner", inputs: [] },
  { type: "error", name: "InvalidContractSignature", inputs: [] }
] as const;

const hints: Record<string, string> = {
  AllowanceExpired: "Permit2 allowance expired. Approve Permit2 for the vault or refresh allowance expiry.",
  InsufficientAllowance: "Permit2 allowance too low. Approve Permit2 for the vault with sufficient allowance.",
  PoolNotInitialized: "Pool is not initialized. Initialize the pool before bootstrapping.",
  TickMisaligned: "Ticks are not aligned to spacing. Check tickSpacing and alignment.",
  TicksMisordered: "tickLower must be less than tickUpper.",
  TickLowerOutOfBounds: "tickLower is outside the valid range.",
  TickUpperOutOfBounds: "tickUpper is outside the valid range.",
  TickSpacingTooSmall: "tickSpacing is below the minimum allowed by PoolManager.",
  TickSpacingTooLarge: "tickSpacing is above the maximum allowed by PoolManager."
};

const looksLikeHexData = (value: unknown): value is Hex =>
  typeof value === "string" && value.startsWith("0x") && value.length >= 10;

export const extractRevertData = (err: unknown): Hex | null => {
  if (err instanceof BaseError) {
    const revertError = err.walk((error) => error instanceof ContractFunctionRevertedError) as
      | ContractFunctionRevertedError
      | undefined;
    if (revertError?.raw && looksLikeHexData(revertError.raw)) {
      return revertError.raw;
    }
    if (revertError?.signature && looksLikeHexData(revertError.signature)) {
      return revertError.signature;
    }
  }

  const visited = new Set<unknown>();
  const stack: unknown[] = [err];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);

    if (looksLikeHexData(current)) {
      return current;
    }

    if (typeof current === "object") {
      const data = (current as { data?: unknown }).data;
      if (looksLikeHexData(data)) {
        return data;
      }
      const raw = (current as { raw?: unknown }).raw;
      if (looksLikeHexData(raw)) {
        return raw;
      }
      const signature = (current as { signature?: unknown }).signature;
      if (looksLikeHexData(signature)) {
        return signature;
      }
      const reason = (current as { reason?: unknown }).reason;
      if (looksLikeHexData(reason)) {
        return reason;
      }
      const cause = (current as { cause?: unknown }).cause;
      if (cause) {
        stack.push(cause);
      }
      const details = (current as { details?: unknown }).details;
      if (details) {
        stack.push(details);
      }
      const errors = (current as { errors?: unknown }).errors;
      if (Array.isArray(errors)) {
        stack.push(...errors);
      }
      const metaMessages = (current as { metaMessages?: unknown }).metaMessages;
      if (Array.isArray(metaMessages)) {
        stack.push(...metaMessages);
      }
    }
  }

  return null;
};

export const decodeUniswapError = (data: Hex): { selector: Hex; name: string; args?: unknown } | null => {
  try {
    const decoded = decodeErrorResult({ abi: uniswapErrorAbi, data });
    const selector = data.slice(0, 10) as Hex;
    return { selector, name: decoded.errorName, args: decoded.args };
  } catch {
    return null;
  }
};

export const getRevertHint = (errorName?: string): string | undefined => {
  if (!errorName) {
    return undefined;
  }
  return hints[errorName];
};
