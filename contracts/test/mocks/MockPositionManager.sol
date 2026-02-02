// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title MockPositionManager
/// @notice Minimal mock for Uniswap v4 PositionManager boundary tests.
contract MockPositionManager {
    bytes32 public lastUnlockDataHash;
    uint256 public lastDeadline;
    uint256 public lastValue;
    uint256 public expectedNewTokenId;
    address public lastCaller;

    address public token0;
    address public token1;
    uint256 public requireAllowance0;
    uint256 public requireAllowance1;
    bool public revertOwnerOf;

    mapping(uint256 => address) private _owners;

    /// @notice Initialize the mock with token addresses.
    /// @param _token0 Token0 address.
    /// @param _token1 Token1 address.
    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    /// @notice Set the token id to mint to the caller on modifyLiquidities.
    /// @param _tokenId Token id to assign to the caller.
    function setExpectedNewTokenId(uint256 _tokenId) external {
        expectedNewTokenId = _tokenId;
    }

    /// @notice Set required allowances for the caller.
    /// @param _allow0 Minimum token0 allowance.
    /// @param _allow1 Minimum token1 allowance.
    function setRequiredAllowances(uint256 _allow0, uint256 _allow1) external {
        requireAllowance0 = _allow0;
        requireAllowance1 = _allow1;
    }

    /// @notice Toggle ownerOf revert behavior for testing.
    /// @param _revertOwnerOf Whether ownerOf should revert.
    function setRevertOwnerOf(bool _revertOwnerOf) external {
        revertOwnerOf = _revertOwnerOf;
    }

    /// @notice Simulate modifyLiquidities.
    /// @param unlockData Opaque unlock data.
    /// @param deadline Deadline supplied by caller.
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        lastCaller = msg.sender;
        lastUnlockDataHash = keccak256(unlockData);
        lastDeadline = deadline;
        lastValue = msg.value;

        if (requireAllowance0 > 0) {
            require(IERC20(token0).allowance(msg.sender, address(this)) >= requireAllowance0, "ALLOW0");
        }
        if (requireAllowance1 > 0) {
            require(IERC20(token1).allowance(msg.sender, address(this)) >= requireAllowance1, "ALLOW1");
        }

        if (expectedNewTokenId != 0) {
            _owners[expectedNewTokenId] = msg.sender;
        }
    }

    /// @notice Return owner for a token id (zero if not minted).
    function ownerOf(uint256 tokenId) external view returns (address) {
        if (revertOwnerOf) {
            revert("OWNER_OF_REVERT");
        }
        return _owners[tokenId];
    }
}
