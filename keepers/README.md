# RangeGuard Keeper CLI

Keeper CLI for RangeGuard vaults. Builds Uniswap v4 `unlockData` offchain and executes vault actions with strict validation and dry-run defaults.

## Prerequisites

- Node.js 18+
- `forge build` (to ensure contracts compile)

## Setup

1) Install dependencies:

```
cd keepers
npm install
```

2) Copy env:

```
cp .env.example .env
```

3) Fill in required values in `.env`.

## Commands

All commands are dry-run by default. Use `--send` to broadcast after simulation.

```
npm run status
npm run bootstrap -- --send
npm run collect -- --send
npm run rebalance -- --send
```

If `useFullBalances=false` in policy:

```
npm run bootstrap -- --amount0 1000 --amount1 0.5
npm run rebalance -- --amount0 1000 --amount1 0.5
```

## Unlock Data Approach

The keeper builds opaque `unlockData` with `V4PositionPlanner` and passes it to the vault. The vault forwards it to `PositionManager.modifyLiquidities`. This keeps action encoding offchain and avoids manual byte packing.

For rebalances, `newPositionId=0` is used as a sentinel. The vault derives the expected tokenId from `PositionManager.nextTokenId()` and enforces ownership after the call.

## Troubleshooting

- **Invalid poolId**: Ensure `POOL_ID` matches the pool derived from `POOL_FEE`, `POOL_TICK_SPACING`, and `POOL_HOOKS`. If unsure, omit `POOL_ID` and let the SDK compute it.
- **StateView errors**: Verify `STATE_VIEW_ADDRESS` is deployed on the target chain and points to the correct PoolManager.
- **Allowance issues**: The vault approves `maxApprove0/maxApprove1` per action. Ensure balances are sufficient and amounts are within policy slippage limits.
