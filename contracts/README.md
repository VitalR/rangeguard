## RangeGuard Contracts

Keeper-driven vault for managing a Uniswap v4 LP position with strict onchain guardrails.

### Main contract

`src/RangeGuardVault.sol`

### Responsibilities

- Custody for token0 / token1
- Stores position metadata: `{ positionId, tickLower, tickUpper, tickSpacing }`
- Owner-managed configuration:
  - `setKeeper`
  - `setMaxSlippageBps`
  - `setPositionState`
  - `pause` / `unpause`
  - withdrawals (ERC20 + ETH rescue)
- Keeper-managed execution:
  - `rebalance(RebalanceParams)`:
    - validates new ticks align to stored spacing
    - sets bounded approvals for the Uniswap v4 PositionManager
    - calls `IPositionManager.modifyLiquidities(unlockData, deadline)`
    - verifies vault owns new position tokenId
    - updates position metadata and emits `PositionRebalanced`

### Tests

`test/RangeGuardVaultTest.t.sol`  
Covers constructor validations, deposit/withdraw, pause/unpause, config changes, policy hashing, tick validation, ETH rescue.

`test/RangeGuardVaultRebalanceTest.t.sol`  
Covers rebalance boundary behaviors using `MockPositionManager`:

- keeper gating
- pause gating
- not-initialized reverts
- tick validation and deadline reverts
- approvals + external call observation + state update
- new-position ownership enforcement
- callValue forwarding + insufficient ETH guard

### Mocks

- `test/mocks/MockERC20.sol`: mintable token with configurable decimals
- `test/mocks/MockPositionManager.sol`: minimal boundary mock that records:
  - `lastCaller`
  - `lastUnlockDataHash`
  - `lastDeadline`
  - `lastValue`
  and simulates “minting” a new position to the vault.

### Commands

Run unit tests:

```shell
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

`IPositionManager.modifyLiquidities(bytes unlockData, uint256 deadline)`

`unlockData` is produced offchain by the keeper (later milestone). Onchain logic remains minimal and guardrail-focused.

### License

MIT License