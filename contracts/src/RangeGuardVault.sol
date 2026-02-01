// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title RangeGuardVault
/// @notice Vault that custodies token0/token1 and stores Uniswap v4 LP position metadata.
/// @dev Owner configures and withdraws; keeper will execute rebalances later. Deposits and future keeper actions are
///      pausable. Policy hashing binds configuration state.
contract RangeGuardVault is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Thrown when a non-keeper attempts to call a keeper-only action.
    error NotKeeper();
    /// @notice Thrown when a zero amount is provided where disallowed.
    error ZeroAmount();
    /// @notice Thrown when a required address is zero.
    error ZeroAddress();
    /// @notice Thrown when a token reports unsupported decimals.
    /// @param decimals Decimals reported by the token.
    error InvalidDecimals(uint8 decimals);
    /// @notice Thrown when an asset is not supported by the vault.
    /// @param asset Asset address that is not allowed.
    error AssetNotAllowed(address asset);
    /// @notice Thrown when the same token is provided for both token0 and token1.
    /// @param token Token used for both inputs.
    error SameTokenInOut(address token);
    /// @notice Thrown when the maximum slippage value is out of range.
    /// @param bps Basis points provided.
    error InvalidBps(uint16 bps);
    /// @notice Thrown when tick spacing is invalid.
    /// @param spacing Tick spacing value.
    error InvalidTickSpacing(int24 spacing);
    /// @notice Thrown when a tick range is invalid.
    /// @param lower Lower tick.
    /// @param upper Upper tick.
    error InvalidTickRange(int24 lower, int24 upper);
    /// @notice Thrown when a tick is not aligned to the spacing.
    /// @param tick Tick value.
    /// @param spacing Tick spacing.
    error TickNotAligned(int24 tick, int24 spacing);
    /// @notice Thrown when an ETH transfer fails.
    error EthTransferFailed();

    /// @notice Emitted after funds are transferred into the vault.
    /// @param sender Address that funded the vault.
    /// @param asset Asset transferred in.
    /// @param amount Amount transferred in.
    event AssetFunded(address indexed sender, address indexed asset, uint256 amount);
    /// @notice Emitted after an asset withdrawal by the owner.
    /// @param asset Asset withdrawn.
    /// @param to Recipient of the withdrawal.
    /// @param amount Amount withdrawn.
    event AssetWithdrawn(address indexed asset, address indexed to, uint256 amount);
    /// @notice Emitted when the keeper is updated.
    /// @param previousKeeper Prior keeper address.
    /// @param newKeeper New keeper address.
    event KeeperUpdated(address indexed previousKeeper, address indexed newKeeper);
    /// @notice Emitted when the position state is updated.
    /// @param positionId Position identifier (placeholder for v4 tokenId).
    /// @param tickLower Lower tick.
    /// @param tickUpper Upper tick.
    /// @param tickSpacing Tick spacing.
    event PositionStateUpdated(uint256 indexed positionId, int24 tickLower, int24 tickUpper, int24 tickSpacing);
    /// @notice Emitted when the position state is cleared.
    event PositionStateCleared();
    /// @notice Emitted when the max slippage value is updated.
    /// @param bps Maximum slippage in basis points.
    event MaxSlippageUpdated(uint16 bps);
    /// @notice Emitted after an ETH withdrawal by the owner.
    /// @param to Recipient of the ETH withdrawal.
    /// @param amount Amount of ETH withdrawn.
    event EthWithdrawn(address indexed to, uint256 amount);
    /// @notice Emitted when the vault is initialized.
    /// @param token0 Token0 address.
    /// @param token1 Token1 address.
    /// @param owner Owner address.
    /// @param keeper Keeper address.
    event RangeGuardVaultInitialized(address token0, address token1, address owner, address keeper);

    /// @notice Position metadata for the vault.
    struct PositionState {
        bool initialized;
        uint256 positionId;
        int24 tickLower;
        int24 tickUpper;
        int24 tickSpacing;
    }

    /// @notice Token0 held by the vault.
    IERC20Metadata public immutable token0;
    /// @notice Token1 held by the vault.
    IERC20Metadata public immutable token1;
    /// @notice Token0 decimals used for policy hashing and UI.
    uint8 public immutable token0Decimals;
    /// @notice Token1 decimals used for policy hashing and UI.
    uint8 public immutable token1Decimals;

    /// @notice Keeper address authorized for keeper-only actions.
    address public keeper;
    /// @notice Maximum slippage allowed (basis points).
    uint16 public maxSlippageBps;
    /// @notice Policy version for non-enumerable policy changes.
    uint256 public policyVersion;
    /// @notice Current position metadata.
    PositionState public position;

    /// @notice Restricts access to the current keeper.
    modifier onlyKeeper() {
        require(msg.sender == keeper, NotKeeper());
        _;
    }

    /// @notice Initializes the vault with two ERC-20 tokens.
    /// @param _token0 Token0 address.
    /// @param _token1 Token1 address.
    /// @param _owner Owner address for Ownable2Step administration.
    /// @param _keeper Initial keeper address (can be zero).
    constructor(address _token0, address _token1, address _owner, address _keeper) Ownable(_owner) {
        require(_token0 != address(0) && _token1 != address(0), ZeroAddress());
        require(_token0 != _token1, SameTokenInOut(_token0));

        token0 = IERC20Metadata(_token0);
        token1 = IERC20Metadata(_token1);
        token0Decimals = token0.decimals();
        token1Decimals = token1.decimals();

        if (token0Decimals > 18) revert InvalidDecimals(token0Decimals);
        if (token1Decimals > 18) revert InvalidDecimals(token1Decimals);

        keeper = _keeper;
        maxSlippageBps = 30;

        emit RangeGuardVaultInitialized(_token0, _token1, _owner, _keeper);
    }

    /// @notice Accept ETH transfers for future use.
    receive() external payable { }

    /// @notice Withdraw ETH from the vault to a recipient.
    /// @param _amount Amount of ETH to withdraw.
    /// @param _to Recipient of the withdrawal.
    function withdrawETH(uint256 _amount, address _to) external onlyOwner nonReentrant {
        require(_to != address(0), ZeroAddress());
        require(_amount > 0, ZeroAmount());
        (bool ok,) = _to.call{ value: _amount }("");
        if (!ok) revert EthTransferFailed();
        emit EthWithdrawn(_to, _amount);
    }

    /// @notice Transfer funds into the vault.
    /// @param _asset Asset to fund.
    /// @param _amount Amount to transfer.
    function deposit(address _asset, uint256 _amount) external nonReentrant whenNotPaused {
        require(_amount > 0, ZeroAmount());
        require(_asset != address(0), ZeroAddress());
        require(_isAllowedAsset(_asset), AssetNotAllowed(_asset));
        IERC20(_asset).safeTransferFrom(msg.sender, address(this), _amount);
        emit AssetFunded(msg.sender, _asset, _amount);
    }

    /// @notice Withdraw an asset from the vault to a recipient.
    /// @param _asset Asset to withdraw.
    /// @param _amount Amount to withdraw.
    /// @param _to Recipient of the withdrawal.
    function withdraw(address _asset, uint256 _amount, address _to) external onlyOwner nonReentrant {
        require(_asset != address(0), ZeroAddress());
        require(_isAllowedAsset(_asset), AssetNotAllowed(_asset));
        require(_to != address(0), ZeroAddress());
        require(_amount > 0, ZeroAmount());
        IERC20(_asset).safeTransfer(_to, _amount);
        emit AssetWithdrawn(_asset, _to, _amount);
    }

    /// @notice Read the vault balance of a supported asset.
    /// @param _asset Asset to query.
    /// @return balance Asset balance held by the vault.
    function balanceOf(address _asset) external view returns (uint256 balance) {
        require(_isAllowedAsset(_asset), AssetNotAllowed(_asset));
        balance = IERC20(_asset).balanceOf(address(this));
    }

    /// @notice Update the keeper address.
    /// @param _newKeeper New keeper address.
    function setKeeper(address _newKeeper) external onlyOwner {
        address previous = keeper;
        keeper = _newKeeper;
        emit KeeperUpdated(previous, _newKeeper);
        _bumpPolicyVersion();
    }

    /// @notice Keeper permission sanity check.
    /// @dev Placeholder for future keeper entrypoints like rebalance(...).
    function pingKeeper() external onlyKeeper { }

    /// @notice Update the maximum slippage cap in basis points.
    /// @param _bps Maximum slippage (0-10,000).
    function setMaxSlippageBps(uint16 _bps) external onlyOwner {
        if (_bps > 10_000) revert InvalidBps(_bps);
        maxSlippageBps = _bps;
        emit MaxSlippageUpdated(_bps);
        _bumpPolicyVersion();
    }

    /// @notice Pause deposits and future keeper actions.
    function pause() external onlyOwner {
        _pause();
        _bumpPolicyVersion();
    }

    /// @notice Unpause deposits and future keeper actions.
    function unpause() external onlyOwner {
        _unpause();
        _bumpPolicyVersion();
    }

    /// @notice Hash current policy parameters for receipt binding.
    /// @return Hash of policy parameters.
    function hashPolicy() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                address(token0),
                address(token1),
                token0Decimals,
                token1Decimals,
                maxSlippageBps,
                keeper,
                policyVersion,
                address(this)
            )
        );
    }

    /// @notice Set the stored position state (no Uniswap interactions yet).
    /// @param _positionId Position identifier placeholder.
    /// @param _tickLower Lower tick.
    /// @param _tickUpper Upper tick.
    /// @param _tickSpacing Tick spacing.
    function setPositionState(uint256 _positionId, int24 _tickLower, int24 _tickUpper, int24 _tickSpacing)
        external
        onlyOwner
    {
        _validateTicks(_tickLower, _tickUpper, _tickSpacing);
        position = PositionState({
            initialized: true,
            positionId: _positionId,
            tickLower: _tickLower,
            tickUpper: _tickUpper,
            tickSpacing: _tickSpacing
        });
        emit PositionStateUpdated(_positionId, _tickLower, _tickUpper, _tickSpacing);
        _bumpPolicyVersion();
    }

    /// @notice Clear the stored position state.
    function clearPositionState() external onlyOwner {
        delete position;
        emit PositionStateCleared();
        _bumpPolicyVersion();
    }

    /// @notice Returns true if a position has been initialized.
    function isPositionInitialized() external view returns (bool) {
        return position.initialized;
    }

    /// @notice Returns current tick configuration and position id.
    function ticks() external view returns (int24 lower, int24 upper, int24 spacing, uint256 positionId) {
        PositionState memory current = position;
        return (current.tickLower, current.tickUpper, current.tickSpacing, current.positionId);
    }

    /// @notice Validate tick range and spacing alignment.
    /// @param _lower Lower tick.
    /// @param _upper Upper tick.
    /// @param _spacing Tick spacing.
    function _validateTicks(int24 _lower, int24 _upper, int24 _spacing) internal pure {
        require(_spacing > 0, InvalidTickSpacing(_spacing));
        require(_lower < _upper, InvalidTickRange(_lower, _upper));
        require(_isAligned(_lower, _spacing), TickNotAligned(_lower, _spacing));
        require(_isAligned(_upper, _spacing), TickNotAligned(_upper, _spacing));
    }

    /// @notice Check if a tick is aligned to a spacing (supports negatives).
    /// @param _tick Tick value.
    /// @param _spacing Tick spacing.
    function _isAligned(int24 _tick, int24 _spacing) internal pure returns (bool) {
        return _tick % _spacing == 0;
    }

    /// @notice Increment policy version for policy-affecting updates.
    function _bumpPolicyVersion() internal {
        unchecked {
            policyVersion++;
        }
    }

    /// @notice Returns true if the asset is token0 or token1.
    /// @param _asset Asset address.
    function _isAllowedAsset(address _asset) internal view returns (bool) {
        return _asset == address(token0) || _asset == address(token1);
    }
}
