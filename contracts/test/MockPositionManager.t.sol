// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockPermit2 } from "./mocks/MockPermit2.sol";
import { MockPositionManager } from "./mocks/MockPositionManager.sol";

contract MockPositionManagerTest is Test {
    MockERC20 private token0;
    MockERC20 private token1;
    MockPermit2 private permit2;
    MockPositionManager private positionManager;

    address private caller = address(0xBEEF);

    function setUp() public {
        token0 = new MockERC20("Token0", "TK0", 6);
        token1 = new MockERC20("Token1", "TK1", 18);
        permit2 = new MockPermit2();
        positionManager = new MockPositionManager(address(token0), address(token1), address(permit2));

        token0.mint(caller, 1_000_000);
        token1.mint(caller, 1_000_000 ether);
    }

    function test_modify_liquidities_reverts_on_allowance0() public {
        positionManager.setRequiredAllowances(10, 0);
        vm.expectRevert(bytes("ALLOW0"));
        vm.prank(caller);
        positionManager.modifyLiquidities(hex"1234", block.timestamp + 1 hours);
    }

    function test_modify_liquidities_reverts_on_permit2_expired() public {
        positionManager.setRequiredAllowances(10, 0);
        vm.prank(caller);
        IERC20(address(token0)).approve(address(positionManager), 10);
        vm.prank(caller);
        permit2.approve(address(token0), address(positionManager), 10, uint48(block.timestamp - 1));

        vm.expectRevert();
        vm.prank(caller);
        positionManager.modifyLiquidities(hex"1234", block.timestamp + 1 hours);
    }

    function test_modify_liquidities_reverts_on_allowance1() public {
        positionManager.setRequiredAllowances(0, 20);
        vm.expectRevert(bytes("ALLOW1"));
        vm.prank(caller);
        positionManager.modifyLiquidities(hex"1234", block.timestamp + 1 hours);
    }

    function test_modify_liquidities_reverts_on_permit2_expired_token1() public {
        positionManager.setRequiredAllowances(0, 20);
        vm.prank(caller);
        IERC20(address(token1)).approve(address(positionManager), 20);
        vm.prank(caller);
        permit2.approve(address(token1), address(positionManager), 20, uint48(block.timestamp - 1));

        vm.expectRevert();
        vm.prank(caller);
        positionManager.modifyLiquidities(hex"1234", block.timestamp + 1 hours);
    }

    function test_modify_liquidities_payouts_and_mint() public {
        positionManager.setRequiredAllowances(10, 20);

        vm.startPrank(caller);
        IERC20(address(token0)).approve(address(positionManager), 10);
        IERC20(address(token1)).approve(address(positionManager), 20);
        permit2.approve(address(token0), address(positionManager), 10, uint48(block.timestamp + 1 hours));
        permit2.approve(address(token1), address(positionManager), 20, uint48(block.timestamp + 1 hours));
        vm.stopPrank();

        positionManager.setPayout(100, 200 ether);
        token0.mint(address(positionManager), 100);
        token1.mint(address(positionManager), 200 ether);
        uint256 before0 = token0.balanceOf(caller);
        uint256 before1 = token1.balanceOf(caller);

        vm.prank(caller);
        positionManager.modifyLiquidities(hex"1234", block.timestamp + 1 hours);

        assertEq(token0.balanceOf(caller), before0 + 100);
        assertEq(token1.balanceOf(caller), before1 + 200 ether);
        assertEq(positionManager.lastMintedTokenId(), 1);
        assertEq(positionManager.ownerOf(1), caller);
    }

    function test_owner_of_reverts_when_configured() public {
        positionManager.setRevertOwnerOf(true);
        vm.expectRevert(bytes("OWNER_OF_REVERT"));
        positionManager.ownerOf(1);
    }
}
