export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export interface PolicyConfig {
  widthTicks: number;
  edgeBps: number;
  cooldownSeconds: number;
  maxSlippageBps: number;
  rebalanceIfOutOfRange: boolean;
  rebalanceIfNearEdge: boolean;
  useFullBalances: boolean;
  hookDataHex: Hex;
}

export interface KeeperConfig {
  rpcUrl: string;
  keeperPrivateKey: Hex;
  vaultAddress: Address;
  stateViewAddress: Address;
  positionManagerAddress?: Address;
  chainId: number;
  dryRun: boolean;
  defaultDeadlineSeconds: number;
  poolId?: Hex;
  poolFee?: number;
  poolTickSpacing?: number;
  poolHooks?: Address;
  policy: PolicyConfig;
  ensName?: string;
  ensTextKey?: string;
}

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface VaultTicks {
  lower: number;
  upper: number;
  spacing: number;
  positionId: bigint;
}
