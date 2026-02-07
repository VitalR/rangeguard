import { PublicClient } from "viem";
import { Address } from "../types";
import { permit2Abi } from "../abi/Permit2";
import { erc20Abi } from "../abi/ERC20";
import { positionManagerAbi } from "../abi/PositionManager";
import { nowSeconds } from "../utils/time";
import { KeeperError } from "../utils/errors";
import { logger } from "../logger";

type Permit2Allowance = {
  amount: bigint;
  expiration: number;
  nonce: number;
  expired: boolean;
};

export const getPermit2Address = async (
  publicClient: PublicClient,
  positionManager: Address
): Promise<Address> => {
  return (await publicClient.readContract({
    address: positionManager,
    abi: positionManagerAbi,
    functionName: "permit2"
  })) as Address;
};

export const readPermit2Allowance = async (
  publicClient: PublicClient,
  permit2: Address,
  owner: Address,
  token: Address,
  spender: Address
): Promise<Permit2Allowance> => {
  const [amount, expiration, nonce] = (await publicClient.readContract({
    address: permit2,
    abi: permit2Abi,
    functionName: "allowance",
    args: [owner, token, spender]
  })) as readonly [bigint, number, number];

  const expirationNumber = Number(expiration);
  const expired = expirationNumber === 0 || expirationNumber <= nowSeconds();

  return {
    amount,
    expiration: expirationNumber,
    nonce: Number(nonce),
    expired
  };
};

export const readErc20Allowance = async (
  publicClient: PublicClient,
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> => {
  return (await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [owner, spender]
  })) as bigint;
};

type Permit2CheckParams = {
  publicClient: PublicClient;
  vault: Address;
  positionManager: Address;
  token0: Address;
  token1: Address;
  required0: bigint;
  required1: bigint;
  throwOnMissing: boolean;
  willSetPermit2?: boolean;
  maxApprove0?: bigint;
  maxApprove1?: bigint;
  deadline?: bigint | number;
};

export const checkPermit2Allowances = async ({
  publicClient,
  vault,
  positionManager,
  token0,
  token1,
  required0,
  required1,
  throwOnMissing,
  willSetPermit2,
  maxApprove0,
  maxApprove1,
  deadline
}: Permit2CheckParams) => {
  const permit2 = await getPermit2Address(publicClient, positionManager);
  const [permit2Allowance0, permit2Allowance1, erc20Allowance0, erc20Allowance1] = await Promise.all([
    readPermit2Allowance(publicClient, permit2, vault, token0, positionManager),
    readPermit2Allowance(publicClient, permit2, vault, token1, positionManager),
    readErc20Allowance(publicClient, token0, vault, permit2),
    readErc20Allowance(publicClient, token1, vault, permit2)
  ]);

  logger.info("Permit2 allowances", {
    permit2,
    positionManager,
    token0: { amount: permit2Allowance0.amount, expiration: permit2Allowance0.expiration, nonce: permit2Allowance0.nonce },
    token1: { amount: permit2Allowance1.amount, expiration: permit2Allowance1.expiration, nonce: permit2Allowance1.nonce },
    erc20Allowance0,
    erc20Allowance1
  });

  if (willSetPermit2 && ((maxApprove0 ?? 0n) > 0n || (maxApprove1 ?? 0n) > 0n)) {
    logger.info("Permit2 allowances will be set by vault (bounded by maxApprove and deadline)", {
      maxApprove0: (maxApprove0 ?? 0n).toString(),
      maxApprove1: (maxApprove1 ?? 0n).toString(),
      deadline: deadline?.toString()
    });
    return;
  }

  const missing: string[] = [];
  if (required0 > 0n && (maxApprove0 ?? required0) === 0n) {
    missing.push("maxApprove0 is zero; vault will not set Permit2 allowance for token0");
  }
  if (required1 > 0n && (maxApprove1 ?? required1) === 0n) {
    missing.push("maxApprove1 is zero; vault will not set Permit2 allowance for token1");
  }
  if (required0 > 0n) {
    if (permit2Allowance0.expired) {
      missing.push("Permit2 allowance for token0 is expired");
    }
    if (permit2Allowance0.amount < required0) {
      missing.push("Permit2 allowance for token0 is insufficient");
    }
    if (erc20Allowance0 < required0) {
      missing.push("ERC20 allowance to Permit2 for token0 is insufficient");
    }
  }
  if (required1 > 0n) {
    if (permit2Allowance1.expired) {
      missing.push("Permit2 allowance for token1 is expired");
    }
    if (permit2Allowance1.amount < required1) {
      missing.push("Permit2 allowance for token1 is insufficient");
    }
    if (erc20Allowance1 < required1) {
      missing.push("ERC20 allowance to Permit2 for token1 is insufficient");
    }
  }

  if (missing.length > 0) {
    const details = {
      missing,
      permit2,
      positionManager,
      required0: required0.toString(),
      required1: required1.toString()
    };
    if (throwOnMissing) {
      throw new KeeperError(
        "Permit2 allowances are missing or expired for vault. The vault must approve Permit2 and set Permit2 allowances to PositionManager.",
        details
      );
    }
    logger.warn("Permit2 allowances missing or expired", details);
  }
};
