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
npm run doctor
npm run quote -- --amount0 10
npm run quote -- --amount1 0.01
npm run bootstrap
npm run collect
npm run rebalance
```

### Common output controls

- `--json`: print the full RunReport JSON only (no pretty summary)
- `--out <path>`: write RunReport to a custom path
- `--verbose`: include low-level fields (calldata hash, unlockData hash, gas estimate, receipt logs count)

By default, each run writes an artifact to `keepers/runs/<ISO>_<cmd>_<runId>.json` and prints a demo-friendly summary.

### Status

```
npm run status
```

Shows current vault state and policy in a pretty summary + RunReport artifact.

### Doctor

```
npm run doctor
```

Validates config, chain id, vault wiring, and policy/tick consistency.

### Quote

```
npm run quote -- --amount0 10
npm run quote -- --amount1 0.01
```

Returns a Quoter-based estimate (optionally buffered via `--bufferBps`).

### Bootstrap

```
npm run bootstrap
npm run bootstrap -- --send
```

If `useFullBalances=false` in policy, you can provide one or both amounts:

```
npm run bootstrap -- --amount0 10
npm run bootstrap -- --amount1 0.01
npm run bootstrap -- --amount0 10 --amount1 0.01
```

Options:
- `--bufferBps <n>`: apply bps buffer to the derived side (default 200)
- `--maxSpendBps <n>`: clamp spend to % of vault balances (default 10000)

### Collect

```
npm run collect
npm run collect -- --send
```

Collect reports vault events (if any) plus before/after balances.

### Rebalance

```
npm run rebalance
npm run rebalance -- --send
npm run rebalance -- --dryPlan
npm run rebalance -- --force
```

Options:
- `--force`: ignore trigger conditions (for demo)
- `--dryPlan`: compute ticks/amounts and exit (no simulation)
- `--bufferBps <n>` / `--maxSpendBps <n>`: same as bootstrap

## Amount selection (demo-friendly)

When `useFullBalances=false`, you may provide only one side:
- `--amount0 <human>` OR `--amount1 <human>` OR both
- If only one is provided, the other side is derived via Quoter and buffered by `--bufferBps`
- If the derived side exceeds vault balance, the input is auto-scaled down (up to 5 retries) and a warning is logged
- `--maxSpendBps` clamps spend to a % of vault balances for safe demos

Run output includes a `runId` in the summary header, and the full plan is persisted in the report file.

## Unlock Data Approach

The keeper builds opaque `unlockData` with `V4PositionPlanner` and passes it to the vault. The vault forwards it to `PositionManager.modifyLiquidities`. This keeps action encoding offchain and avoids manual byte packing.

For rebalances, `newPositionId=0` is used as a sentinel. The vault derives the expected tokenId from `PositionManager.nextTokenId()` and enforces ownership after the call.

## Troubleshooting

- **Invalid poolId**: Ensure `POOL_ID` matches the pool derived from `POOL_FEE`, `POOL_TICK_SPACING`, and `POOL_HOOKS`. If unsure, omit `POOL_ID` and let the SDK compute it.
- **StateView errors**: Verify `STATE_VIEW_ADDRESS` is deployed on the target chain and points to the correct PoolManager.
- **Allowance issues**: The vault approves `maxApprove0/maxApprove1` per action. Ensure balances are sufficient and amounts are within policy slippage limits.
- **Cooldown skips**: Cooldown is stored at `~/.rangeguard/keeper-state.json` and can cause rebalance/collect to skip. Use `--force` to override (rebalance only).
- **Run artifacts**: Reports are saved under `keepers/runs/`. Use `--out` to direct to a specific path or `--json` for machine parsing.
