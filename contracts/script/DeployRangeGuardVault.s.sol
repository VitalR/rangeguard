// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import "forge-std/Script.sol";
import "forge-std/console2.sol";

import { RangeGuardVault } from "../src/RangeGuardVault.sol";

/// @notice Deploy RangeGuardVault to Sepolia (or any chain via --rpc-url)
/// @dev Expects env vars (see .env section below).
contract DeployRangeGuardVault is Script {
    function run() external returns (RangeGuardVault vault) {
        // Deployer key used for broadcasting txs
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        // Constructor params (keep these in .env)
        address token0 = vm.envAddress("TOKEN0");
        address token1 = vm.envAddress("TOKEN1");
        address owner = vm.envAddress("VAULT_OWNER_PUBLIC_KEY");
        address keeper = vm.envAddress("VAULT_KEEPER_PUBLIC_KEY"); // can be 0x000..000 to disable keeper actions
        address positionManager = vm.envAddress("POSITION_MANAGER");

        vm.startBroadcast(deployerPk);
        vault = new RangeGuardVault(token0, token1, owner, keeper, positionManager);
        vm.stopBroadcast();

        console2.log("RangeGuardVault deployed:");
        console2.log("  address         =", address(vault));
        console2.log("  token0          =", token0);
        console2.log("  token1          =", token1);
        console2.log("  owner           =", owner);
        console2.log("  keeper          =", keeper);
        console2.log("  positionManager =", positionManager);
    }
}

/*
Deploy the RangeGuardVault to Sepolia
cd contracts

# Ensure env vars are exported (Foundry reads process env)
```bash
set -a && source .env && set +a

forge script script/DeployRangeGuardVault.s.sol:DeployRangeGuardVault \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast \
  --verify \
  --etherscan-api-key "$ETHERSCAN_API_KEY" \
  -vvvv
```
*/

// RangeGuardVault 0x911e21de620D788D45242D843aEaBC00ccEAD372
