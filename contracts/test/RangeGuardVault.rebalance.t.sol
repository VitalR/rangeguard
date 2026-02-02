// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { Test } from "forge-std/Test.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RangeGuardVault } from "../src/RangeGuardVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPositionManager } from "./mocks/MockPositionManager.sol";

/// @title RangeGuardVaultRebalanceTest
/// @notice Tests for RangeGuardVault rebalance flow.
contract RangeGuardVaultRebalanceTest is Test {
    MockERC20 private token0;
    MockERC20 private token1;
    MockPositionManager private positionManager;
    RangeGuardVault private vault;

    address private owner = address(0xA11CE);
    address private keeper = address(0xBEEF);
    address private user = address(0xCAFE);

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0", 6);
        token1 = new MockERC20("Token1", "TK1", 18);
        positionManager = new MockPositionManager(address(token0), address(token1));
        vault = new RangeGuardVault(address(token0), address(token1), owner, keeper, address(positionManager));

        vm.prank(owner);
        vault.setPositionState(1, -20, 20, 10);
    }

    function test_rebalance_only_keeper() public {
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        vm.expectRevert(RangeGuardVault.NotKeeper.selector);
        vm.prank(user);
        vault.rebalance(params);
    }

    function test_rebalance_paused() public {
        vm.prank(owner);
        vault.pause();

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_position_not_initialized() public {
        RangeGuardVault fresh =
            new RangeGuardVault(address(token0), address(token1), owner, keeper, address(positionManager));

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        vm.expectRevert(RangeGuardVault.PositionNotInitialized.selector);
        vm.prank(keeper);
        fresh.rebalance(params);
    }

    function test_rebalance_tick_validation() public {
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newTickLower = -15;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.TickNotAligned.selector, int24(-15), int24(10)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_deadline_expired() public {
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        uint256 nowTs = block.timestamp;
        params.deadline = nowTs - 1;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.DeadlineExpired.selector, nowTs, nowTs - 1));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_sets_approvals_calls_manager_and_updates_state() public {
        positionManager.setExpectedNewTokenId(42);
        positionManager.setRequiredAllowances(500, 700);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 42;
        params.newTickLower = -10;
        params.newTickUpper = 10;
        params.maxApprove0 = 500;
        params.maxApprove1 = 700;

        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.PositionRebalanced(1, 42, -20, 20, -10, 10, keccak256(params.unlockData));

        vm.prank(keeper);
        vault.rebalance(params);

        assertEq(positionManager.lastCaller(), address(vault));
        assertEq(positionManager.lastUnlockDataHash(), keccak256(params.unlockData));
        assertEq(positionManager.lastDeadline(), params.deadline);

        assertEq(IERC20(address(token0)).allowance(address(vault), address(positionManager)), 500);
        assertEq(IERC20(address(token1)).allowance(address(vault), address(positionManager)), 700);

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(positionId, 42);
        assertEq(lower, -10);
        assertEq(upper, 10);
        assertEq(spacing, 10);
    }

    function test_rebalance_resets_allowance_before_approve() public {
        positionManager.setExpectedNewTokenId(2);
        positionManager.setRequiredAllowances(10, 20);

        vm.prank(address(vault));
        IERC20(address(token0)).approve(address(positionManager), 1);
        vm.prank(address(vault));
        IERC20(address(token1)).approve(address(positionManager), 1);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.maxApprove0 = 10;
        params.maxApprove1 = 20;

        vm.prank(keeper);
        vault.rebalance(params);

        assertEq(IERC20(address(token0)).allowance(address(vault), address(positionManager)), 10);
        assertEq(IERC20(address(token1)).allowance(address(vault), address(positionManager)), 20);
    }

    function test_rebalance_reverts_when_new_position_not_owned() public {
        positionManager.setExpectedNewTokenId(999);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 42;
        params.newTickLower = -10;
        params.newTickUpper = 10;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, uint256(42)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_reverts_when_owner_of_reverts() public {
        positionManager.setExpectedNewTokenId(2);
        positionManager.setRevertOwnerOf(true);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 2;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, uint256(2)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_forwards_call_value() public {
        positionManager.setExpectedNewTokenId(2);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.callValue = 123;

        vm.deal(address(vault), 123);
        vm.prank(keeper);
        vault.rebalance(params);

        assertEq(positionManager.lastValue(), 123);
    }

    function test_rebalance_reverts_if_call_value_exceeds_balance() public {
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.callValue = 123;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InsufficientETH.selector, uint256(0), uint256(123)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function _defaultParams() private view returns (RangeGuardVault.RebalanceParams memory params) {
        params = RangeGuardVault.RebalanceParams({
            newPositionId: 2,
            newTickLower: -20,
            newTickUpper: 20,
            deadline: block.timestamp + 1 hours,
            unlockData: hex"1234",
            maxApprove0: 0,
            maxApprove1: 0,
            callValue: 0
        });
    }
}
