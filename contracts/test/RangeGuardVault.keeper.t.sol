// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { Test } from "forge-std/Test.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { RangeGuardVault } from "../src/RangeGuardVault.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPermit2 } from "./mocks/MockPermit2.sol";
import { MockPositionManager } from "./mocks/MockPositionManager.sol";

/// @title RangeGuardVaultKeeperTest
/// @notice Tests for keeper-controlled flows.
contract RangeGuardVaultKeeperTest is Test {
    MockERC20 private token0;
    MockERC20 private token1;
    MockPermit2 private permit2;
    MockPositionManager private positionManager;
    RangeGuardVault private vault;

    address private owner = address(0xA11CE);
    address private keeper = address(0xBEEF);
    address private user = address(0xCAFE);
    address private constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0", 6);
        token1 = new MockERC20("Token1", "TK1", 18);
        MockPermit2 permit2Impl = new MockPermit2();
        vm.etch(PERMIT2, address(permit2Impl).code);
        permit2 = MockPermit2(PERMIT2);

        positionManager = new MockPositionManager(address(token0), address(token1), PERMIT2);
        vault = new RangeGuardVault(address(token0), address(token1), owner, keeper, address(positionManager));

        token0.mint(address(vault), 1_000_000);
        token1.mint(address(vault), 1_000_000 ether);
    }

    //--------------------------------Rebalance tests--------------------------------

    function test_rebalance_only_keeper() public {
        _initPosition();
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        vm.expectRevert(RangeGuardVault.NotKeeper.selector);
        vm.prank(user);
        vault.rebalance(params);
    }

    function test_rebalance_paused() public {
        _initPosition();
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
        _initPosition();
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newTickLower = -15;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.TickNotAligned.selector, int24(-15), int24(10)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_deadline_expired() public {
        _initPosition();
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        uint256 nowTs = block.timestamp;
        params.deadline = nowTs - 1;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.DeadlineExpired.selector, nowTs, nowTs - 1));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_sets_approvals_calls_manager_and_updates_state() public {
        _initPosition();
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

        (uint160 amount0, uint48 expiration0,) =
            permit2.allowance(address(vault), address(token0), address(positionManager));
        (uint160 amount1, uint48 expiration1,) =
            permit2.allowance(address(vault), address(token1), address(positionManager));
        assertEq(uint256(amount0), 500);
        assertEq(uint256(amount1), 700);
        assertGt(expiration0, block.timestamp);
        assertGt(expiration1, block.timestamp);

        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(positionId, 42);
        assertEq(lower, -10);
        assertEq(upper, 10);
        assertEq(spacing, 10);
    }

    function test_rebalance_resets_allowance_before_approve() public {
        _initPosition();
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

        (uint160 amount0, uint48 expiration0,) =
            permit2.allowance(address(vault), address(token0), address(positionManager));
        (uint160 amount1, uint48 expiration1,) =
            permit2.allowance(address(vault), address(token1), address(positionManager));
        assertEq(uint256(amount0), 10);
        assertEq(uint256(amount1), 20);
        assertGt(expiration0, block.timestamp);
        assertGt(expiration1, block.timestamp);
    }

    function test_rebalance_reverts_when_new_position_not_owned() public {
        _initPosition();
        positionManager.setExpectedNewTokenId(999);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 42;
        params.newTickLower = -10;
        params.newTickUpper = 10;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, uint256(42)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_new_position_id_zero_uses_next_token_id() public {
        _initPosition();
        uint256 expected = positionManager.nextTokenId();

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 0;
        params.newTickLower = -10;
        params.newTickUpper = 10;

        vm.expectEmit(true, true, false, true, address(vault));
        emit RangeGuardVault.PositionRebalanced(1, expected, -20, 20, -10, 10, keccak256(params.unlockData));

        vm.prank(keeper);
        vault.rebalance(params);

        (,,, uint256 positionId) = vault.ticks();
        assertEq(positionId, expected);
    }

    function test_rebalance_reverts_when_owner_of_reverts() public {
        _initPosition();
        positionManager.setExpectedNewTokenId(2);
        positionManager.setRevertOwnerOf(true);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.newPositionId = 2;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, uint256(2)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    function test_rebalance_forwards_call_value() public {
        _initPosition();
        positionManager.setExpectedNewTokenId(2);

        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.callValue = 123;

        vm.deal(address(vault), 123);
        vm.prank(keeper);
        vault.rebalance(params);

        assertEq(positionManager.lastValue(), 123);
    }

    function test_rebalance_reverts_if_call_value_exceeds_balance() public {
        _initPosition();
        RangeGuardVault.RebalanceParams memory params = _defaultParams();
        params.callValue = 123;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InsufficientETH.selector, uint256(0), uint256(123)));
        vm.prank(keeper);
        vault.rebalance(params);
    }

    //--------------------------------Bootstrap tests--------------------------------

    function test_bootstrap_only_keeper() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        vm.expectRevert(RangeGuardVault.NotKeeper.selector);
        vm.prank(user);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_deadline_expired() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        uint256 nowTs = block.timestamp;
        p.deadline = nowTs - 1;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.DeadlineExpired.selector, nowTs, nowTs - 1));
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_tick_validation() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.tickLower = -15;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.TickNotAligned.selector, int24(-15), int24(10)));
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_reverts_if_call_value_exceeds_balance() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.callValue = 123;

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InsufficientETH.selector, uint256(0), uint256(123)));
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_reverts_when_position_not_owned() public {
        positionManager.setMintOnModify(false);
        uint256 expectedId = positionManager.nextTokenId();

        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.NewPositionNotOwned.selector, expectedId));
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_resets_allowance_before_approve() public {
        positionManager.setRequiredAllowances(10, 20);

        vm.prank(address(vault));
        IERC20(address(token0)).approve(address(positionManager), 1);
        vm.prank(address(vault));
        IERC20(address(token1)).approve(address(positionManager), 1);

        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.maxApprove0 = 10;
        p.maxApprove1 = 20;

        vm.prank(keeper);
        vault.bootstrapPosition(p);

        assertEq(IERC20(address(token0)).allowance(address(vault), address(positionManager)), 10);
        assertEq(IERC20(address(token1)).allowance(address(vault), address(positionManager)), 20);

        (uint160 amount0, uint48 expiration0,) =
            permit2.allowance(address(vault), address(token0), address(positionManager));
        (uint160 amount1, uint48 expiration1,) =
            permit2.allowance(address(vault), address(token1), address(positionManager));
        assertEq(uint256(amount0), 10);
        assertEq(uint256(amount1), 20);
        assertGt(expiration0, block.timestamp);
        assertGt(expiration1, block.timestamp);
    }

    function test_bootstrap_resets_permit2_allowance_before_approve() public {
        positionManager.setRequiredAllowances(10, 20);

        vm.prank(address(vault));
        IERC20(address(token0)).approve(PERMIT2, 1);
        vm.prank(address(vault));
        IERC20(address(token1)).approve(PERMIT2, 1);

        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.maxApprove0 = 10;
        p.maxApprove1 = 20;

        vm.prank(keeper);
        vault.bootstrapPosition(p);

        assertEq(IERC20(address(token0)).allowance(address(vault), PERMIT2), 10);
        assertEq(IERC20(address(token1)).allowance(address(vault), PERMIT2), 20);
    }

    function test_bootstrap_initializes_position_and_emits() public {
        positionManager.setRequiredAllowances(500, 700);

        uint256 expectedId = positionManager.nextTokenId();
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.maxApprove0 = 500;
        p.maxApprove1 = 700;

        vm.expectEmit(true, false, false, true, address(vault));
        emit RangeGuardVault.PositionStateUpdated(expectedId, p.tickLower, p.tickUpper, p.tickSpacing);
        vm.expectEmit(true, false, false, true, address(vault));
        emit RangeGuardVault.PositionBootstrapped(
            expectedId, p.tickLower, p.tickUpper, p.tickSpacing, keccak256(p.unlockData)
        );

        vm.prank(keeper);
        vault.bootstrapPosition(p);

        assertTrue(vault.isPositionInitialized());
        (int24 lower, int24 upper, int24 spacing, uint256 positionId) = vault.ticks();
        assertEq(positionId, expectedId);
        assertEq(lower, p.tickLower);
        assertEq(upper, p.tickUpper);
        assertEq(spacing, p.tickSpacing);
    }

    function test_bootstrap_reverts_if_already_initialized() public {
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());

        vm.expectRevert(RangeGuardVault.PositionAlreadyInitialized.selector);
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());
    }

    function test_bootstrap_reverts_when_permit2_amount_too_large() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.maxApprove0 = uint256(type(uint160).max) + 1;

        vm.expectRevert(
            abi.encodeWithSelector(RangeGuardVault.Permit2AmountTooLarge.selector, uint256(type(uint160).max) + 1)
        );
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    function test_bootstrap_reverts_when_permit2_expiration_too_large() public {
        RangeGuardVault.BootstrapParams memory p = _bootstrapParams();
        p.maxApprove0 = 1;
        p.deadline = type(uint48).max;

        vm.expectRevert(
            abi.encodeWithSelector(RangeGuardVault.Permit2ExpirationTooLarge.selector, uint256(type(uint48).max) + 600)
        );
        vm.prank(keeper);
        vault.bootstrapPosition(p);
    }

    //--------------------------------Collect tests--------------------------------

    function test_collect_emits_balance_deltas() public {
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());

        token0.mint(address(positionManager), 123);
        token1.mint(address(positionManager), 456 ether);
        positionManager.setPayout(123, 456 ether);
        positionManager.setMintOnModify(false);

        RangeGuardVault.CollectParams memory p = RangeGuardVault.CollectParams({
            deadline: block.timestamp + 1 hours, unlockData: hex"c0ffee", callValue: 0, maxApprove0: 0, maxApprove1: 0
        });

        uint256 b0Before = token0.balanceOf(address(vault));
        uint256 b1Before = token1.balanceOf(address(vault));

        vm.prank(keeper);
        vault.collect(p);

        uint256 b0After = token0.balanceOf(address(vault));
        uint256 b1After = token1.balanceOf(address(vault));

        assertEq(b0After, b0Before + 123);
        assertEq(b1After, b1Before + 456 ether);
    }

    function test_collect_applies_approvals() public {
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());

        positionManager.setMintOnModify(false);
        positionManager.setRequiredAllowances(10, 20);

        RangeGuardVault.CollectParams memory p = RangeGuardVault.CollectParams({
            deadline: block.timestamp + 1 hours, unlockData: hex"c0ffee", callValue: 0, maxApprove0: 10, maxApprove1: 20
        });

        vm.prank(keeper);
        vault.collect(p);

        assertEq(IERC20(address(token0)).allowance(address(vault), address(positionManager)), 10);
        assertEq(IERC20(address(token1)).allowance(address(vault), address(positionManager)), 20);

        (uint160 amount0, uint48 expiration0,) =
            permit2.allowance(address(vault), address(token0), address(positionManager));
        (uint160 amount1, uint48 expiration1,) =
            permit2.allowance(address(vault), address(token1), address(positionManager));
        assertEq(uint256(amount0), 10);
        assertEq(uint256(amount1), 20);
        assertGt(expiration0, block.timestamp);
        assertGt(expiration1, block.timestamp);
    }

    function test_collect_reverts_when_not_initialized() public {
        RangeGuardVault.CollectParams memory p = RangeGuardVault.CollectParams({
            deadline: block.timestamp + 1 hours, unlockData: hex"c0ffee", callValue: 0, maxApprove0: 0, maxApprove1: 0
        });

        vm.expectRevert(RangeGuardVault.PositionNotInitialized.selector);
        vm.prank(keeper);
        vault.collect(p);
    }

    function test_collect_deadline_expired() public {
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());

        uint256 nowTs = block.timestamp;
        RangeGuardVault.CollectParams memory p = RangeGuardVault.CollectParams({
            deadline: nowTs - 1, unlockData: hex"c0ffee", callValue: 0, maxApprove0: 0, maxApprove1: 0
        });

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.DeadlineExpired.selector, nowTs, nowTs - 1));
        vm.prank(keeper);
        vault.collect(p);
    }

    function test_collect_reverts_if_call_value_exceeds_balance() public {
        vm.prank(keeper);
        vault.bootstrapPosition(_bootstrapParams());

        RangeGuardVault.CollectParams memory p = RangeGuardVault.CollectParams({
            deadline: block.timestamp + 1 hours, unlockData: hex"c0ffee", callValue: 123, maxApprove0: 0, maxApprove1: 0
        });

        vm.expectRevert(abi.encodeWithSelector(RangeGuardVault.InsufficientETH.selector, uint256(0), uint256(123)));
        vm.prank(keeper);
        vault.collect(p);
    }

    //--------------------------------Internal helpers--------------------------------

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

    function _bootstrapParams() private view returns (RangeGuardVault.BootstrapParams memory p) {
        p = RangeGuardVault.BootstrapParams({
            tickLower: -20,
            tickUpper: 20,
            tickSpacing: 10,
            deadline: block.timestamp + 1 hours,
            unlockData: hex"b00d",
            maxApprove0: 0,
            maxApprove1: 0,
            callValue: 0
        });
    }

    function _initPosition() private {
        positionManager.mintTo(address(vault), 1);
        vm.prank(owner);
        vault.setPositionState(1, -20, 20, 10);
    }
}
