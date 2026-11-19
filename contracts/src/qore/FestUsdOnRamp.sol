// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IMintBurnUsdc is IERC20 {
    function mint(address to, uint256 amount) external;
    function burnFrom(address from, uint256 amount) external;
}

/// @title FestUsdOnRamp
/// @notice The fest's own dollar in, the route's dollar out: swaps QoreChain's fUSD test token one to one for the
///         mock USDC that agUSD holds and that crosses to Ethereum, and back. A lender who took fUSD from the
///         QoreChain faucet can lend it without touching Agama's faucet.
/// @dev Both tokens have six decimals. fUSD is held here 1:1 against every mock USDC this contract minted, so the
///      way back is always open for what came in this way.
contract FestUsdOnRamp is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable fusd;
    IMintBurnUsdc public immutable usdc;

    event OnRamped(address indexed account, uint256 amount);
    event OffRamped(address indexed account, uint256 amount);

    error ZeroAmount();

    constructor(IERC20 fusd_, IMintBurnUsdc usdc_) {
        fusd = fusd_;
        usdc = usdc_;
    }

    /// @notice fUSD in, the same amount of mock USDC out, to the caller.
    function onRamp(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        fusd.safeTransferFrom(msg.sender, address(this), amount);
        usdc.mint(msg.sender, amount);
        emit OnRamped(msg.sender, amount);
    }

    /// @notice Mock USDC back to fUSD, up to the fUSD this contract holds.
    function offRamp(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.burnFrom(msg.sender, amount);
        fusd.safeTransfer(msg.sender, amount);
        emit OffRamped(msg.sender, amount);
    }
}
