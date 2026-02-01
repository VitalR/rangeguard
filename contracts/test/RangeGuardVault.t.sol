// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { RangeGuardVault } from "../src/RangeGuardVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";

/// @title RangeGuardVaultTest
/// @notice Day-1 unit tests for RangeGuardVault.
contract RangeGuardVaultTest is Test {
    MockERC20 private token0;
    MockERC20 private token1;
    MockERC20 private tokenBad;
    RangeGuardVault private vault;

    address private owner = address(0xA11CE);
    address private keeper = address(0xBEEF);
    address private user = address(0xCAFE);
    address private recipient = address(0xD00D);

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0", 6);
        token1 = new MockERC20("Token1", "TK1", 18);
        tokenBad = new MockERC20("Bad", "BAD", 18);
        vault = new RangeGuardVault(address(token0), address(token1), owner, keeper);
    }

    function test_constructor_validations() public {
        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        new RangeGuardVault(address(0), address(token1), owner, keeper);

        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        new RangeGuardVault(address(token0), address(0), owner, keeper);

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.SameTokenInOut.selector, address(token0)));
        new RangeGuardVault(address(token0), address(token0), owner, keeper);

        MockERC20 tokenHighDecimals = new MockERC20("High", "HI", 19);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidDecimals.selector, uint8(19)));
        new RangeGuardVault(address(tokenHighDecimals), address(token1), owner, keeper);
    }

    function test_deposit_token0_and_token1() public {
        uint256 amount0 = 1000;
        uint256 amount1 = 2000;

        token0.mint(user, amount0);
        token1.mint(user, amount1);

        vm.startPrank(user);
        token0.approve(address(vault), amount0);
        token1.approve(address(vault), amount1);

        vm.expectEmit(true, true, false, true);
        emit RangeGuardVault.AssetFunded(user, address(token0), amount0);
        vault.deposit(address(token0), amount0);

        vm.expectEmit(true, true, false, true);
        emit RangeGuardVault.AssetFunded(user, address(token1), amount1);
        vault.deposit(address(token1), amount1);
        vm.stopPrank();

        assertEq(token0.balanceOf(address(vault)), amount0);
        assertEq(token1.balanceOf(address(vault)), amount1);
    }

    function test_deposit_reverts() public {
        vm.expectRevert(RangeGuardVault.ZeroAmount.selector);
        vault.deposit(address(token0), 0);

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.AssetNotAllowed.selector, address(tokenBad)));
        vault.deposit(address(tokenBad), 100);

        vm.prank(owner);
        vault.pause();

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(address(token0), 100);
    }

    function test_withdraw() public {
        uint256 amount = 5000;
        token0.mint(address(vault), amount);

        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit RangeGuardVault.AssetWithdrawn(address(token0), recipient, amount);
        vault.withdraw(address(token0), amount, recipient);

        assertEq(token0.balanceOf(recipient), amount);
    }

    function test_withdraw_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.withdraw(address(token0), 1, recipient);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.ZeroAmount.selector);
        vault.withdraw(address(token0), 0, recipient);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        vault.withdraw(address(token0), 1, address(0));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.AssetNotAllowed.selector, address(tokenBad)));
        vault.withdraw(address(tokenBad), 1, recipient);
    }

    function test_keeper_update() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.setKeeper(address(0x1234));

        bytes32 beforeHash = vault.hashPolicy();

        vm.prank(owner);
        vm.expectEmit(true, true, false, true);
        emit RangeGuardVault.KeeperUpdated(keeper, address(0x1234));
        vault.setKeeper(address(0x1234));

        assertEq(vault.keeper(), address(0x1234));
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_set_max_slippage_bps() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.setMaxSlippageBps(100);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidBps.selector, uint16(10_001)));
        vault.setMaxSlippageBps(10_001);

        bytes32 beforeHash = vault.hashPolicy();
        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit RangeGuardVault.MaxSlippageUpdated(200);
        vault.setMaxSlippageBps(200);

        assertEq(vault.maxSlippageBps(), 200);
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_set_position_state() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.setPositionState(1, -20, 20, 10);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidTickSpacing.selector, int24(0)));
        vault.setPositionState(1, -20, 20, 0);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidTickRange.selector, int24(20), int24(20)));
        vault.setPositionState(1, 20, 20, 10);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.TickNotAligned.selector, int24(-15), int24(10)));
        vault.setPositionState(1, -15, 20, 10);

        bytes32 beforeHash = vault.hashPolicy();
        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit RangeGuardVault.PositionStateUpdated(42, -20, 20, 10);
        vault.setPositionState(42, -20, 20, 10);

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(lower, -20);
        assertEq(upper, 20);
        assertEq(spacing, 10);
        assertEq(positionId, 42);
        assertTrue(vault.isPositionInitialized());
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_pause_unpause() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.pause();

        vm.prank(owner);
        vault.pause();

        token0.mint(user, 100);
        vm.prank(user);
        token0.approve(address(vault), 100);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(user);
        vault.deposit(address(token0), 100);

        token0.mint(address(vault), 50);
        vm.prank(owner);
        vault.withdraw(address(token0), 50, recipient);
        assertEq(token0.balanceOf(recipient), 50);

        vm.prank(owner);
        vault.unpause();
    }

    function test_withdraw_eth() public {
        uint256 amount = 1 ether;
        vm.deal(address(vault), amount);
        vm.deal(recipient, 0);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true);
        emit RangeGuardVault.EthWithdrawn(recipient, amount);
        vault.withdrawETH(amount, recipient);

        assertEq(address(vault).balance, 0);
        assertEq(recipient.balance, amount);
    }

    function test_clear_position_state() public {
        vm.prank(owner);
        vault.setPositionState(42, -20, 20, 10);
        assertTrue(vault.isPositionInitialized());

        vm.prank(owner);
        vm.expectEmit(false, false, false, true);
        emit RangeGuardVault.PositionStateCleared();
        vault.clearPositionState();

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(lower, 0);
        assertEq(upper, 0);
        assertEq(spacing, 0);
        assertEq(positionId, 0);
        assertFalse(vault.isPositionInitialized());
    }
}
