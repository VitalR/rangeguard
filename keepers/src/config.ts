import dotenv from "dotenv";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { KeeperConfig, PolicyConfig } from "./types";
import { logger } from "./logger";
import { KeeperError, invariant } from "./utils/errors";
import { fetchPolicyFromEns } from "./policy/ens";

dotenv.config();

const addressRegex = /^0x[0-9a-fA-F]{40}$/;

const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.toLowerCase().trim();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }
  return defaultValue;
};

const parseNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new KeeperError(`Invalid numeric value: ${value}`);
  }
  return parsed;
};

const optionalAddress = z.union([z.string().regex(addressRegex), z.literal("")]).optional();
const optionalBytes32 = z.union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), z.literal("")]).optional();

const envSchema = z.object({
  RPC_URL: z.string().min(1, "RPC_URL is required"),
  KEEPER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "KEEPER_PRIVATE_KEY must be 0x + 64 hex chars"),
  VAULT_ADDRESS: z.string().regex(addressRegex, "VAULT_ADDRESS must be a 20-byte hex address"),
  STATE_VIEW_ADDRESS: z.string().regex(addressRegex, "STATE_VIEW_ADDRESS must be a 20-byte hex address"),
  POSITION_MANAGER_ADDRESS: optionalAddress,
  CHAIN_ID: z.string().optional(),
  DRY_RUN: z.string().optional(),
  DEFAULT_DEADLINE_SECONDS: z.string().optional(),
  POLICY_JSON: z.string().optional(),
  POLICY_PATH: z.string().optional(),
  POOL_ID: optionalBytes32,
  POOL_FEE: z.string().optional(),
  POOL_TICK_SPACING: z.string().optional(),
  POOL_HOOKS: optionalAddress,
  ENS_NAME: z.string().optional(),
  ENS_TEXT_KEY: z.string().optional()
});

const policySchema = z.object({
  widthTicks: z.number().int().positive(),
  edgeBps: z.number().int().min(0).max(10_000),
  cooldownSeconds: z.number().int().min(0),
  maxSlippageBps: z.number().int().min(0).max(10_000),
  rebalanceIfOutOfRange: z.boolean().default(true),
  rebalanceIfNearEdge: z.boolean().default(false),
  useFullBalances: z.boolean().default(true),
  hookDataHex: z.string().regex(/^0x[0-9a-fA-F]*$/, "hookDataHex must be hex").default("0x")
});

const loadPolicyFromFile = async (policyPath: string): Promise<PolicyConfig> => {
  const raw = await fs.readFile(policyPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const policy = policySchema.parse(parsed);
  return { ...policy, hookDataHex: policy.hookDataHex as PolicyConfig["hookDataHex"] };
};

const loadPolicyFromJson = (policyJson: string): PolicyConfig => {
  const parsed = JSON.parse(policyJson) as unknown;
  const policy = policySchema.parse(parsed);
  return { ...policy, hookDataHex: policy.hookDataHex as PolicyConfig["hookDataHex"] };
};

const resolvePolicy = async (env: z.infer<typeof envSchema>): Promise<PolicyConfig> => {
  if (env.POLICY_JSON) {
    return loadPolicyFromJson(env.POLICY_JSON);
  }
  if (env.POLICY_PATH) {
    const policyPath = path.isAbsolute(env.POLICY_PATH)
      ? env.POLICY_PATH
      : path.join(process.cwd(), env.POLICY_PATH);
    return loadPolicyFromFile(policyPath);
  }
  if (env.ENS_NAME) {
    const policy = await fetchPolicyFromEns(env.ENS_NAME, env.ENS_TEXT_KEY ?? "rangeguard.policy");
    if (policy) {
      const parsedPolicy = policySchema.parse(policy);
      return { ...parsedPolicy, hookDataHex: parsedPolicy.hookDataHex as PolicyConfig["hookDataHex"] };
    }
  }
  throw new KeeperError("Missing policy: set POLICY_JSON or POLICY_PATH (or ENS_NAME if configured).");
};

export const loadConfig = async (): Promise<KeeperConfig> => {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.format();
    throw new KeeperError("Invalid environment configuration", { issues: formatted });
  }

  const env = parsed.data;
  const policy = await resolvePolicy(env);

  invariant(policy.widthTicks > 0, "policy.widthTicks must be positive");
  invariant(policy.edgeBps <= 10_000, "policy.edgeBps out of range");
  invariant(policy.maxSlippageBps <= 10_000, "policy.maxSlippageBps out of range");

  if (env.DRY_RUN && env.DRY_RUN.toLowerCase().trim() === "false") {
    logger.warn("DRY_RUN=false is set; use --send to broadcast transactions.");
  }

  const positionManagerAddress =
    env.POSITION_MANAGER_ADDRESS && env.POSITION_MANAGER_ADDRESS !== "" ? env.POSITION_MANAGER_ADDRESS : undefined;
  const poolId = env.POOL_ID && env.POOL_ID !== "" ? env.POOL_ID : undefined;
  const poolHooks = env.POOL_HOOKS && env.POOL_HOOKS !== "" ? env.POOL_HOOKS : undefined;

  return {
    rpcUrl: env.RPC_URL,
    keeperPrivateKey: env.KEEPER_PRIVATE_KEY as KeeperConfig["keeperPrivateKey"],
    vaultAddress: env.VAULT_ADDRESS as KeeperConfig["vaultAddress"],
    stateViewAddress: env.STATE_VIEW_ADDRESS as KeeperConfig["stateViewAddress"],
    positionManagerAddress: positionManagerAddress as KeeperConfig["positionManagerAddress"],
    chainId: parseNumber(env.CHAIN_ID, 11155111),
    dryRun: parseBoolean(env.DRY_RUN, true),
    defaultDeadlineSeconds: parseNumber(env.DEFAULT_DEADLINE_SECONDS, 180),
    poolId: poolId as KeeperConfig["poolId"],
    poolFee: env.POOL_FEE ? parseNumber(env.POOL_FEE, 0) : undefined,
    poolTickSpacing: env.POOL_TICK_SPACING ? parseNumber(env.POOL_TICK_SPACING, 0) : undefined,
    poolHooks: poolHooks as KeeperConfig["poolHooks"],
    policy,
    ensName: env.ENS_NAME,
    ensTextKey: env.ENS_TEXT_KEY ?? "rangeguard.policy"
  };
};
