// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IQorePQC} from "./IQorePQC.sol";

/// @title PqcAuth
/// @notice "This account signed these bytes with its post-quantum key", checked on chain.
/// @dev The key is never stored by Agama. It is read from QoreChain's key registry on every check, so a key the
///      account rotates is picked up at once and a key registered without proof of possession is refused.
library PqcAuth {
    IQorePQC internal constant PQC_VERIFY = IQorePQC(0x0000000000000000000000000000000000000a01);
    IQorePQC internal constant PQC_KEYS = IQorePQC(0x0000000000000000000000000000000000000a02);

    error PqcKeyNotRegistered(address account);
    error PqcKeyNotProven(address account);
    error BadPqcSignature(address account);

    function requireSigned(address account, bytes memory message, bytes calldata signature) internal view {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(account);
        if (!registered || pubkey.length == 0) revert PqcKeyNotRegistered(account);
        if (!proven) revert PqcKeyNotProven(account);
        if (!PQC_VERIFY.pqcVerify(pubkey, signature, message)) revert BadPqcSignature(account);
    }

    /// @notice Whether `account` holds a registered ML-DSA-87 key with proof of possession: on QoreChain, an
    ///         account whose every transaction carries a post-quantum signature.
    function isQuantumSafe(address account) internal view returns (bool) {
        (bool registered,, bytes memory pubkey, bool proven) = PQC_KEYS.pqcKeyStatus(account);
        return registered && proven && pubkey.length != 0;
    }
}
