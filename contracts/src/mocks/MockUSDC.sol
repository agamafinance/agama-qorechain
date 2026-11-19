// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MockUSDC
/// @notice A six decimal test dollar, deployed on both legs of the route. QoreChain has no USDC and no CCTP domain,
///         so this token stands in on both chains, and the burn-and-mint messenger holds MINTER_ROLE on each, which
///         is how CCTP itself treats USDC.
/// @dev `faucet` mints ten thousand to whoever asks, as often as they ask: it is a testnet dollar.
contract MockUSDC is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    uint256 public constant FAUCET_AMOUNT = 10_000e6;

    event Dripped(address indexed to, uint256 amount);

    constructor(address admin) ERC20("Mock USDC", "USDC") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function faucet() external {
        _mint(msg.sender, FAUCET_AMOUNT);
        emit Dripped(msg.sender, FAUCET_AMOUNT);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /// @notice Burns from `from` within the allowance it gave the caller, as the fUSD on-ramp does on the way back.
    function burnFrom(address from, uint256 amount) external {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }
}
