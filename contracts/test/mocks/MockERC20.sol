// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20
/// @notice Minimal ERC20 mock with configurable decimals and minting.
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    /// @notice Initializes the mock token.
    /// @param _name Token name.
    /// @param _symbol Token symbol.
    /// @param _decimals_ Token decimals.
    constructor(string memory _name, string memory _symbol, uint8 _decimals_) ERC20(_name, _symbol) {
        _decimals = _decimals_;
    }

    /// @notice Returns the configured decimals.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens to an address.
    /// @param _to Recipient address.
    /// @param _amount Amount to mint.
    function mint(address _to, uint256 _amount) external {
        _mint(_to, _amount);
    }
}
