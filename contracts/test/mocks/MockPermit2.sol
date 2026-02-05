// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

/// @title MockPermit2
/// @notice Minimal Permit2 mock for allowance tracking.
contract MockPermit2 {
    struct Allowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => Allowance))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        Allowance storage current = allowance[msg.sender][token][spender];
        current.amount = amount;
        current.expiration = expiration;
    }
}
