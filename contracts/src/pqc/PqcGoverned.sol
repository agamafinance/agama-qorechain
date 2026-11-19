// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqcSigned} from "./PqcSigned.sol";

/// @title PqcGoverned
/// @notice An admin that exists only as a post-quantum key. No function here checks `msg.sender` for admin
///         powers: every admin action carries the admin's ML-DSA-87 signature, checked by `pqcVerify`.
abstract contract PqcGoverned is PqcSigned {
    /// @notice The account whose registered ML-DSA-87 key authorises admin actions.
    address public admin;

    event AdminChanged(address indexed previous, address indexed next);

    error ZeroAddress();

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminChanged(address(0), admin_);
    }

    function _onlyAdmin(bytes32 action, bytes memory params, uint256 deadline, bytes calldata signature) internal {
        _pqcAuthorize(admin, action, params, deadline, signature);
    }

    /// @notice Hands the admin role to another account. Signed by the current admin.
    function setAdmin(address next, uint256 deadline, bytes calldata signature) external {
        if (next == address(0)) revert ZeroAddress();
        _onlyAdmin("setAdmin", abi.encode(next), deadline, signature);
        emit AdminChanged(admin, next);
        admin = next;
    }
}
