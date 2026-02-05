// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

/// @title IPermit2
/// @notice Minimal Permit2 interface for allowance approvals used by RangeGuardVault.
interface IPermit2 {
    /// @notice Set allowance for a spender on a token.
    /// @param token Token address.
    /// @param spender Spender address.
    /// @param amount Allowance amount (uint160).
    /// @param expiration Expiration timestamp (uint48).
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;

    /// @notice Read allowance details for an owner/token/spender.
    /// @param owner Owner address.
    /// @param token Token address.
    /// @param spender Spender address.
    /// @return amount Allowance amount.
    /// @return expiration Expiration timestamp.
    /// @return nonce Allowance nonce.
    function allowance(address owner, address token, address spender)
        external
        view
        returns (uint160 amount, uint48 expiration, uint48 nonce);
}
