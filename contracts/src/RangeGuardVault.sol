// SPDX-License-Identifier: MIT
pragma solidity 0.8.33;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IERC721 } from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IPositionManager } from "v4-periphery/src/interfaces/IPositionManager.sol";

/// @title RangeGuardVault
/// @notice Custody vault for token0/token1 that owns a Uniswap v4 LP position and supports keeper-triggered
///     bootstrap, collect, and rebalancing.
/// @dev The owner manages configuration and withdrawals. A keeper can execute constrained actions via
///     the Uniswap v4 PositionManager using opaque `unlockData` built offchain (monitor → decide → act).
///     Deposits and keeper actions are pausable, and `hashPolicy()` binds the current configuration for auditability.
contract RangeGuardVault is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // =============================================================
    //                     EVENTS & ERRORS
    // =============================================================

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

    /// @notice Emitted after a successful rebalance.
    /// @param oldPositionId Previous position id.
    /// @param newPositionId New position id.
    /// @param oldLower Previous lower tick.
    /// @param oldUpper Previous upper tick.
    /// @param newLower New lower tick.
    /// @param newUpper New upper tick.
    /// @param unlockDataHash Hash of the unlockData payload.
    event PositionRebalanced(
        uint256 indexed oldPositionId,
        uint256 indexed newPositionId,
        int24 oldLower,
        int24 oldUpper,
        int24 newLower,
        int24 newUpper,
        bytes32 unlockDataHash
    );

    /// @notice Emitted after the first position is bootstrapped.
    /// @param newPositionId New position id.
    /// @param tickLower Lower tick.
    /// @param tickUpper Upper tick.
    /// @param tickSpacing Tick spacing.
    /// @param unlockDataHash Hash of the unlockData payload.
    event PositionBootstrapped(
        uint256 indexed newPositionId, int24 tickLower, int24 tickUpper, int24 tickSpacing, bytes32 unlockDataHash
    );

    /// @notice Emitted after fees are collected via PositionManager.
    /// @param positionId Position id used for collection.
    /// @param balance0Before Token0 balance before the call.
    /// @param balance1Before Token1 balance before the call.
    /// @param balance0After Token0 balance after the call.
    /// @param balance1After Token1 balance after the call.
    /// @param unlockDataHash Hash of the unlockData payload.
    event FeesCollected(
        uint256 indexed positionId,
        uint256 balance0Before,
        uint256 balance1Before,
        uint256 balance0After,
        uint256 balance1After,
        bytes32 unlockDataHash
    );

    /// @notice Emitted when the vault is initialized.
    /// @param token0 Token0 address.
    /// @param token1 Token1 address.
    /// @param owner Owner address.
    /// @param keeper Keeper address.
    /// @param positionManager Uniswap v4 PositionManager address.
    event RangeGuardVaultInitialized(
        address token0, address token1, address owner, address keeper, address positionManager
    );

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

    /// @notice Thrown when a rebalance is attempted before position initialization.
    error PositionNotInitialized();

    /// @notice Thrown when trying to bootstrap an already initialized position.
    error PositionAlreadyInitialized();

    /// @notice Thrown when the rebalance deadline has passed.
    /// @param nowTs Current block timestamp.
    /// @param deadline Rebalance deadline.
    error DeadlineExpired(uint256 nowTs, uint256 deadline);

    /// @notice Thrown when a new position token id is not owned by the vault.
    /// @param tokenId New position token id.
    error NewPositionNotOwned(uint256 tokenId);
    /// @notice Thrown when the vault lacks ETH to forward.
    /// @param available ETH available in the vault.
    /// @param required ETH required for the call.
    error InsufficientETH(uint256 available, uint256 required);

    // =============================================================
    //                 DATA STRUCTS & STORAGE
    // =============================================================

    /// @notice Position metadata for the vault.
    struct PositionState {
        bool initialized;
        uint256 positionId;
        int24 tickLower;
        int24 tickUpper;
        int24 tickSpacing;
    }

    /// @notice Parameters for keeper-driven rebalances.
    struct RebalanceParams {
        uint256 newPositionId;
        int24 newTickLower;
        int24 newTickUpper;
        uint256 deadline;
        bytes unlockData;
        uint256 maxApprove0;
        uint256 maxApprove1;
        uint256 callValue;
    }

    /// @notice Parameters for keeper-driven initial position creation.
    struct BootstrapParams {
        int24 tickLower;
        int24 tickUpper;
        int24 tickSpacing;
        uint256 deadline;
        bytes unlockData;
        uint256 maxApprove0;
        uint256 maxApprove1;
        uint256 callValue;
    }

    /// @notice Parameters for keeper-driven fee collection.
    struct CollectParams {
        uint256 deadline;
        bytes unlockData;
        uint256 callValue;
        uint256 maxApprove0;
        uint256 maxApprove1;
    }

    /// @notice Token0 held by the vault.
    IERC20Metadata public immutable token0;
    /// @notice Token1 held by the vault.
    IERC20Metadata public immutable token1;
    /// @notice Token0 decimals used for policy hashing and UI.
    uint8 public immutable token0Decimals;
    /// @notice Token1 decimals used for policy hashing and UI.
    uint8 public immutable token1Decimals;
    /// @notice Uniswap v4 PositionManager address.
    address public immutable positionManager;

    /// @notice Keeper address authorized for keeper-only actions.
    address public keeper;
    /// @notice Maximum slippage allowed (basis points).
    uint16 public maxSlippageBps;
    /// @notice Policy version for non-enumerable policy changes.
    uint256 public policyVersion;
    /// @notice Current position metadata.
    PositionState public position;

    // =============================================================
    //        ACCESS CONTROL & CONSTRUCTOR & RECEIVE/FALLBACK
    // =============================================================

    /// @notice Restricts access to the current keeper.
    modifier onlyKeeper() {
        require(msg.sender == keeper, NotKeeper());
        _;
    }

    /// @notice Deploy a new RangeGuardVault instance.
    /// @dev The vault is configured for a specific token0/token1 pair and a specific Uniswap v4 PositionManager.
    ///      The owner controls configuration and withdrawals. The keeper is authorized to call `rebalance`.
    /// @param _token0 Token0 address.
    /// @param _token1 Token1 address.
    /// @param _owner Owner address for Ownable2Step administration.
    /// @param _keeper Initial keeper address (can be zero to disable keeper actions).
    /// @param _positionManager Uniswap v4 PositionManager address.
    constructor(address _token0, address _token1, address _owner, address _keeper, address _positionManager)
        Ownable(_owner)
    {
        require(_token0 != address(0) && _token1 != address(0) && _positionManager != address(0), ZeroAddress());
        require(_token0 != _token1, SameTokenInOut(_token0));

        token0 = IERC20Metadata(_token0);
        token1 = IERC20Metadata(_token1);
        token0Decimals = token0.decimals();
        token1Decimals = token1.decimals();

        if (token0Decimals > 18) revert InvalidDecimals(token0Decimals);
        if (token1Decimals > 18) revert InvalidDecimals(token1Decimals);

        keeper = _keeper;
        maxSlippageBps = 30;
        positionManager = _positionManager;

        emit RangeGuardVaultInitialized(_token0, _token1, _owner, _keeper, _positionManager);
    }

    /// @notice Accept ETH transfers for future use.
    receive() external payable { }

    // =============================================================
    //                   DEPOSIT & WITHDRAWAL LOGIC
    // =============================================================

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

    // =============================================================
    //                   KEEPER ACTIONS LOGIC
    // =============================================================

    /// @notice Bootstrap the initial position via Uniswap v4 PositionManager.
    /// @param _p Bootstrap parameters built by the keeper.
    function bootstrapPosition(BootstrapParams calldata _p) external onlyKeeper whenNotPaused nonReentrant {
        require(!position.initialized, PositionAlreadyInitialized());
        if (block.timestamp > _p.deadline) revert DeadlineExpired(block.timestamp, _p.deadline);

        _validateTicks(_p.tickLower, _p.tickUpper, _p.tickSpacing);

        uint256 available = address(this).balance;
        if (_p.callValue > available) revert InsufficientETH(available, _p.callValue);

        uint256 expectedId = _nextTokenId();
        _applyApprovals(_p.maxApprove0, _p.maxApprove1);

        IPositionManager(positionManager).modifyLiquidities{ value: _p.callValue }(_p.unlockData, _p.deadline);

        require(_ownsPosition(expectedId), NewPositionNotOwned(expectedId));

        position = PositionState({
            initialized: true,
            positionId: expectedId,
            tickLower: _p.tickLower,
            tickUpper: _p.tickUpper,
            tickSpacing: _p.tickSpacing
        });

        emit PositionStateUpdated(expectedId, _p.tickLower, _p.tickUpper, _p.tickSpacing);
        emit PositionBootstrapped(expectedId, _p.tickLower, _p.tickUpper, _p.tickSpacing, keccak256(_p.unlockData));
    }

    /// @notice Collect fees/deltas via Uniswap v4 PositionManager.
    /// @param _p Collect parameters built by the keeper.
    function collect(CollectParams calldata _p) external onlyKeeper whenNotPaused nonReentrant {
        require(position.initialized, PositionNotInitialized());
        if (block.timestamp > _p.deadline) revert DeadlineExpired(block.timestamp, _p.deadline);

        uint256 available = address(this).balance;
        if (_p.callValue > available) revert InsufficientETH(available, _p.callValue);

        uint256 balance0Before = IERC20(address(token0)).balanceOf(address(this));
        uint256 balance1Before = IERC20(address(token1)).balanceOf(address(this));

        _applyApprovals(_p.maxApprove0, _p.maxApprove1);
        IPositionManager(positionManager).modifyLiquidities{ value: _p.callValue }(_p.unlockData, _p.deadline);

        uint256 balance0After = IERC20(address(token0)).balanceOf(address(this));
        uint256 balance1After = IERC20(address(token1)).balanceOf(address(this));

        emit FeesCollected(
            position.positionId, balance0Before, balance1Before, balance0After, balance1After, keccak256(_p.unlockData)
        );
    }

    /// @notice Rebalance the vault's position via Uniswap v4 PositionManager.
    /// @param _p Rebalance parameters built by the keeper.
    function rebalance(RebalanceParams calldata _p) external onlyKeeper whenNotPaused nonReentrant {
        require(position.initialized, PositionNotInitialized());
        if (block.timestamp > _p.deadline) revert DeadlineExpired(block.timestamp, _p.deadline);

        int24 spacing = position.tickSpacing;
        _validateTicks(_p.newTickLower, _p.newTickUpper, spacing);

        uint256 expectedNewId = _p.newPositionId == 0 ? _nextTokenId() : _p.newPositionId;

        uint256 available = address(this).balance;
        if (_p.callValue > available) revert InsufficientETH(available, _p.callValue);

        _applyApprovals(_p.maxApprove0, _p.maxApprove1);
        IPositionManager(positionManager).modifyLiquidities{ value: _p.callValue }(_p.unlockData, _p.deadline);

        if (!_ownsPosition(expectedNewId)) revert NewPositionNotOwned(expectedNewId);

        uint256 oldPositionId = position.positionId;
        int24 oldLower = position.tickLower;
        int24 oldUpper = position.tickUpper;

        position.positionId = expectedNewId;
        position.tickLower = _p.newTickLower;
        position.tickUpper = _p.newTickUpper;

        emit PositionRebalanced(
            oldPositionId, expectedNewId, oldLower, oldUpper, _p.newTickLower, _p.newTickUpper, keccak256(_p.unlockData)
        );
    }

    // =============================================================
    //                CONFIGURATION & CONTROL LOGIC
    // =============================================================

    /// @notice Update the keeper address.
    /// @param _newKeeper New keeper address.
    function setKeeper(address _newKeeper) external onlyOwner {
        address previous = keeper;
        keeper = _newKeeper;
        emit KeeperUpdated(previous, _newKeeper);
        _bumpPolicyVersion();
    }

    /// @notice Update the maximum slippage cap in basis points.
    /// @param _bps Maximum slippage (0-10,000).
    function setMaxSlippageBps(uint16 _bps) external onlyOwner {
        if (_bps > 10_000) revert InvalidBps(_bps);
        maxSlippageBps = _bps;
        emit MaxSlippageUpdated(_bps);
        _bumpPolicyVersion();
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
        require(_ownsPosition(_positionId), NewPositionNotOwned(_positionId));
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

    // =============================================================
    //         PUBLIC/EXTERNAL & INTERNAL UTILITY FUNCTIONS
    // =============================================================

    /// @notice Read the vault balance of a supported asset.
    /// @param _asset Asset to query.
    /// @return balance Asset balance held by the vault.
    function balanceOf(address _asset) external view returns (uint256 balance) {
        require(_isAllowedAsset(_asset), AssetNotAllowed(_asset));
        balance = IERC20(_asset).balanceOf(address(this));
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
                positionManager,
                keeper,
                policyVersion,
                address(this)
            )
        );
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

    /// @notice Apply bounded approvals to the PositionManager.
    /// @param maxApprove0 Token0 approval amount (0 to skip).
    /// @param maxApprove1 Token1 approval amount (0 to skip).
    function _applyApprovals(uint256 maxApprove0, uint256 maxApprove1) internal {
        if (maxApprove0 > 0) {
            IERC20 token = IERC20(address(token0));
            if (token.allowance(address(this), positionManager) != 0) {
                token.forceApprove(positionManager, 0);
            }
            token.forceApprove(positionManager, maxApprove0);
        }

        if (maxApprove1 > 0) {
            IERC20 token = IERC20(address(token1));
            if (token.allowance(address(this), positionManager) != 0) {
                token.forceApprove(positionManager, 0);
            }
            token.forceApprove(positionManager, maxApprove1);
        }
    }

    /// @notice Return the next PositionManager token id.
    function _nextTokenId() internal view returns (uint256) {
        return IPositionManager(positionManager).nextTokenId();
    }

    /// @notice Returns true if the vault owns a position.
    /// @param _tokenId Position token id.
    /// @return True if the vault owns the position, false otherwise.
    function _ownsPosition(uint256 _tokenId) internal view returns (bool) {
        try IERC721(positionManager).ownerOf(_tokenId) returns (address owner) {
            return owner == address(this);
        } catch {
            return false;
        }
    }
}
