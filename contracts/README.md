## RangeGuard Contracts

Keeper-driven vault for managing a Uniswap v4 LP position with strict onchain guardrails.

### Main contract

`src/RangeGuardVault.sol`

### Responsibilities

#### Custody & accounting
- Custody for `token0` / `token1` (ERC20)
- Accepts ETH (for potential `callValue` forwarding to PositionManager)
- `deposit(asset, amount)` for token0/token1 (pausable)
- Owner-only withdrawals:
  - `withdraw(asset, amount, to)` (ERC20)
  - `withdrawETH(amount, to)` (ETH rescue)

#### Position state
- Stores position metadata:
  - `{ initialized, positionId, tickLower, tickUpper, tickSpacing }`
- Read helpers:
  - `isPositionInitialized()`
  - `ticks()`
  - `balanceOf(asset)`

#### Owner-managed configuration & controls
- `setKeeper(newKeeper)` (bumps `policyVersion`)
- `setMaxSlippageBps(bps)` (bumps `policyVersion`)
- `setPositionState(positionId, tickLower, tickUpper, tickSpacing)`:
  - validates ticks + spacing alignment
  - verifies the vault *owns* `positionId` (ERC721 `ownerOf`)
  - sets `position` metadata (bumps `policyVersion`)
- `clearPositionState()` (bumps `policyVersion`)
- `pause()` / `unpause()` (bumps `policyVersion`)
- `hashPolicy()` binds current configuration for auditability:
  - token0/token1 + decimals
  - `maxSlippageBps`
  - `positionManager`
  - `keeper`
  - `policyVersion`
  - vault address

#### Keeper-managed execution (opaque `unlockData`)
All keeper actions call Uniswap v4 **PositionManager** via:

`IPositionManager.modifyLiquidities(bytes unlockData, uint256 deadline)`

The vault does **not** decode commands onchain. The keeper builds `unlockData` offchain
(monitor → decide → act) and the vault enforces guardrails:

- deadlines
- tick alignment / range validation
- bounded approvals (optional per call)
- ETH forwarding cap (`callValue` <= vault balance)
- post-call ownership verification of the expected position tokenId

Keeper entrypoints:

- `bootstrapPosition(BootstrapParams)`:
  - creates the initial position via PositionManager
  - uses `nextTokenId()` pre-call to derive the expected minted position id
  - verifies ownership post-call and initializes `position`

- `collect(CollectParams)`:
  - executes a keeper-supplied `unlockData` intended to collect fees/deltas
  - emits before/after token balances for demo/auditability (`FeesCollected`)

- `rebalance(RebalanceParams)`:
  - validates ticks against stored `position.tickSpacing`
  - applies bounded approvals (optional)
  - calls `modifyLiquidities(unlockData, deadline)`
  - verifies vault owns the new position tokenId and updates `position` state
  - supports `newPositionId == 0` sentinel:
    - vault derives expected id using `nextTokenId()` before the call

### Tests

`test/RangeGuardVault.t.sol`  
Non-keeper tests covering:
- constructor validations + init event
- deposits + asset allowlist
- owner-only withdrawals (ERC20 + ETH rescue)
- pause/unpause behavior
- `setKeeper`, `setMaxSlippageBps`, `hashPolicy()` changes
- `setPositionState` tick validation + ownership requirement
- `clearPositionState`
- `balanceOf` behavior

`test/RangeGuardVault.keeper.t.sol`  
Keeper action tests using `MockPositionManager`:
- keeper gating + pause gating + not-initialized reverts
- tick validation + deadline reverts
- bounded approvals and allowance reset pattern
- `callValue` forwarding + insufficient ETH guard
- rebalance ownership enforcement + `ownerOf` revert handling
- `newPositionId == 0` sentinel path (uses `nextTokenId()`)
- `bootstrapPosition` success + already-initialized revert
- `collect` balance delta behavior

### Mocks

- `test/mocks/MockERC20.sol`
  - mintable ERC20 with configurable decimals

- `test/mocks/MockPositionManager.sol`
  - boundary mock that records:
    - `lastCaller`
    - `lastUnlockDataHash`
    - `lastDeadline`
    - `lastValue`
  - supports:
    - `nextTokenId()` + `mintTo(to, tokenId)` to simulate ERC721 ownership
    - optional allowance requirements
    - optional `ownerOf` revert mode
    - optional simulated payouts during `modifyLiquidities` (used for `collect` tests)

### Commands

Run unit tests:

```sh
forge test -vv
```

Coverage:

```shell
forge coverage
```

Format:

```shell
forge fmt
```

### Notes on Uniswap v4 integration

The contract integrates at the periphery interface boundary via:

- `IPositionManager.modifyLiquidities(bytes unlockData, uint256 deadline)`

- `IPositionManager.nextTokenId()` (used to derive the expected minted position id for bootstrap and sentinel rebalance)

`unlockData` is produced offchain by the keeper. Onchain logic remains minimal and guardrail-focused.

### License

MIT License