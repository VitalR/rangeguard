// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { Test } from "forge-std/Test.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

import { RangeGuardVault } from "../src/RangeGuardVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPermit2 } from "./mocks/MockPermit2.sol";
import { MockPositionManager } from "./mocks/MockPositionManager.sol";

/// @title RangeGuardVaultTest
/// @notice Unit tests for RangeGuardVault (owner-managed configuration & controls).
contract RangeGuardVaultTest is Test {
    MockERC20 private token0;
    MockERC20 private token1;
    MockERC20 private tokenBad;
    MockPermit2 private permit2;
    MockPositionManager private positionManager;
    RangeGuardVault private vault;

    address private owner = address(0xA11CE);
    address private keeper = address(0xBEEF);
    address private user = address(0xCAFE);
    address private recipient = address(0xD00D);
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0", 6);
        token1 = new MockERC20("Token1", "TK1", 18);
        tokenBad = new MockERC20("Bad", "BAD", 18);
        MockPermit2 permit2Impl = new MockPermit2();
        vm.etch(PERMIT2, address(permit2Impl).code);
        permit2 = MockPermit2(PERMIT2);

        positionManager = new MockPositionManager(address(token0), address(token1), PERMIT2);
        vault = new RangeGuardVault(address(token0), address(token1), owner, keeper, address(positionManager));
    }

    function test_constructor_validations() public {
        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        new RangeGuardVault(address(0), address(token1), owner, keeper, address(positionManager));

        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        new RangeGuardVault(address(token0), address(0), owner, keeper, address(positionManager));

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.SameTokenInOut.selector, address(token0)));
        new RangeGuardVault(address(token0), address(token0), owner, keeper, address(positionManager));

        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        new RangeGuardVault(address(token0), address(token1), owner, keeper, address(0));

        MockERC20 tokenHighDecimals = new MockERC20("High", "HI", 19);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidDecimals.selector, uint8(19)));
        new RangeGuardVault(address(tokenHighDecimals), address(token1), owner, keeper, address(positionManager));

        MockERC20 tokenHighDecimals1 = new MockERC20("High1", "HI1", 19);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidDecimals.selector, uint8(19)));
        new RangeGuardVault(address(token0), address(tokenHighDecimals1), owner, keeper, address(positionManager));
    }

    function test_constructor_emits_initialized_event() public {
        uint256 nonce = vm.getNonce(address(this));
        address expected = vm.computeCreateAddress(address(this), nonce);

        vm.expectEmit(true, true, true, true, expected);
        emit RangeGuardVault.RangeGuardVaultInitialized(
            address(token0), address(token1), owner, keeper, address(positionManager)
        );

        RangeGuardVault newVault =
            new RangeGuardVault(address(token0), address(token1), owner, keeper, address(positionManager));
        assertEq(address(newVault), expected);
    }

    function test_deposit_token0_and_token1() public {
        uint256 amount0 = 1000;
        uint256 amount1 = 2000;

        token0.mint(user, amount0);
        token1.mint(user, amount1);

        vm.startPrank(user);
        token0.approve(address(vault), amount0);
        token1.approve(address(vault), amount1);

        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.AssetFunded(user, address(token0), amount0);
        vault.deposit(address(token0), amount0);

        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.AssetFunded(user, address(token1), amount1);
        vault.deposit(address(token1), amount1);
        vm.stopPrank();

        assertEq(token0.balanceOf(address(vault)), amount0);
        assertEq(token1.balanceOf(address(vault)), amount1);
    }

    function test_deposit_reverts() public {
        vm.expectRevert(RangeGuardVault.ZeroAmount.selector);
        vault.deposit(address(token0), 0);

        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        vault.deposit(address(0), 1);

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
        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.AssetWithdrawn(address(token0), recipient, amount);
        vault.withdraw(address(token0), amount, recipient);

        assertEq(token0.balanceOf(recipient), amount);
    }

    function test_withdraw_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.withdraw(address(token0), 1, recipient);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        vault.withdraw(address(0), 1, recipient);

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

        uint256 beforePolicy = vault.policyVersion();
        bytes32 beforeHash = vault.hashPolicy();

        vm.prank(owner);
        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.KeeperUpdated(keeper, address(0x1234));
        vault.setKeeper(address(0x1234));

        assertEq(vault.keeper(), address(0x1234));
        assertEq(vault.policyVersion(), beforePolicy + 1);
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_set_max_slippage_bps() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.setMaxSlippageBps(100);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InvalidBps.selector, uint16(10_001)));
        vault.setMaxSlippageBps(10_001);

        uint256 beforePolicy = vault.policyVersion();
        bytes32 beforeHash = vault.hashPolicy();
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit RangeGuardVault.MaxSlippageUpdated(200);
        vault.setMaxSlippageBps(200);

        assertEq(vault.maxSlippageBps(), 200);
        assertEq(vault.policyVersion(), beforePolicy + 1);
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

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.TickNotAligned.selector, int24(25), int24(10)));
        vault.setPositionState(1, -20, 25, 10);

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, uint256(42)));
        vault.setPositionState(42, -20, 20, 10);

        positionManager.mintTo(address(vault), 42);

        uint256 beforePolicy = vault.policyVersion();
        bytes32 beforeHash = vault.hashPolicy();
        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit RangeGuardVault.PositionStateUpdated(42, -20, 20, 10);
        vault.setPositionState(42, -20, 20, 10);

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(lower, -20);
        assertEq(upper, 20);
        assertEq(spacing, 10);
        assertEq(positionId, 42);
        assertTrue(vault.isPositionInitialized());
        assertEq(vault.policyVersion(), beforePolicy + 1);
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_pause_unpause() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.pause();

        uint256 beforePausePolicy = vault.policyVersion();
        bytes32 beforePauseHash = vault.hashPolicy();
        vm.prank(owner);
        vault.pause();
        assertEq(vault.policyVersion(), beforePausePolicy + 1);
        assertTrue(beforePauseHash != vault.hashPolicy());

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

        uint256 beforeUnpausePolicy = vault.policyVersion();
        bytes32 beforeUnpauseHash = vault.hashPolicy();
        vm.prank(owner);
        vault.unpause();
        assertEq(vault.policyVersion(), beforeUnpausePolicy + 1);
        assertTrue(beforeUnpauseHash != vault.hashPolicy());
    }

    function test_withdraw_eth() public {
        uint256 amount = 1 ether;
        vm.deal(address(vault), amount);
        vm.deal(recipient, 0);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(vault));
        emit RangeGuardVault.EthWithdrawn(recipient, amount);
        vault.withdrawETH(amount, recipient);

        assertEq(address(vault).balance, 0);
        assertEq(recipient.balance, amount);
    }

    function test_withdraw_eth_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, user));
        vm.prank(user);
        vault.withdrawETH(1 ether, recipient);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.ZeroAmount.selector);
        vault.withdrawETH(0, recipient);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.ZeroAddress.selector);
        vault.withdrawETH(1 ether, address(0));
    }

    function test_withdraw_eth_reverts_on_transfer_failure() public {
        RejectETH rejector = new RejectETH();
        vm.deal(address(vault), 1 ether);

        vm.prank(owner);
        vm.expectRevert(RangeGuardVault.EthTransferFailed.selector);
        vault.withdrawETH(1 ether, address(rejector));
    }

    function test_clear_position_state() public {
        positionManager.mintTo(address(vault), 42);
        vm.prank(owner);
        vault.setPositionState(42, -20, 20, 10);
        assertTrue(vault.isPositionInitialized());

        uint256 beforePolicy = vault.policyVersion();
        bytes32 beforeHash = vault.hashPolicy();
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(vault));
        emit RangeGuardVault.PositionStateCleared();
        vault.clearPositionState();

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(lower, 0);
        assertEq(upper, 0);
        assertEq(spacing, 0);
        assertEq(positionId, 0);
        assertFalse(vault.isPositionInitialized());
        assertEq(vault.policyVersion(), beforePolicy + 1);
        assertTrue(beforeHash != vault.hashPolicy());
    }

    function test_deposit_after_unpause() public {
        vm.prank(owner);
        vault.pause();

        vm.prank(owner);
        vault.unpause();

        token0.mint(user, 100);
        vm.startPrank(user);
        token0.approve(address(vault), 100);
        vault.deposit(address(token0), 100);
        vm.stopPrank();

        assertEq(token0.balanceOf(address(vault)), 100);
    }

    function test_balance_of_reverts_for_unsupported_asset() public {
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.AssetNotAllowed.selector, address(tokenBad)));
        vault.balanceOf(address(tokenBad));
    }

    function test_balance_of_returns_balances() public {
        token0.mint(address(vault), 111);
        token1.mint(address(vault), 222);

        assertEq(vault.balanceOf(address(token0)), 111);
        assertEq(vault.balanceOf(address(token1)), 222);
    }
}

contract RejectETH {
    receive() external payable {
        revert("nope");
    }
}
