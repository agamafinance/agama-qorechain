// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqcAuth} from "./PqcAuth.sol";

/// @title PqcSigned
/// @notice Domain-separated, single-use ML-DSA-87 authorisations for the roles of one contract.
/// @dev Every signed action is bound to the chain, this contract, the action name, the signer, a nonce and a
///      deadline, plus the hash of its parameters. The contract exposes the exact bytes to sign (`pqcMessage`), so
///      off-chain signers never re-encode anything. Anyone may relay a signed action: the signature is the
///      authority, not the caller, and a stolen secp256k1 key alone authorises nothing.
abstract contract PqcSigned {
    /// @notice Next nonce per signer.
    mapping(address signer => uint256) public pqcNonce;

    event PqcAuthorized(address indexed signer, bytes32 indexed action, uint256 nonce, address relayer);

    error Expired(uint256 deadline);

    /// @notice The bytes `signer` signs to authorise `action` with `params`.
    function pqcMessage(address signer, bytes32 action, bytes memory params, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            "Agama:pqc:v1", block.chainid, address(this), action, signer, nonce, deadline, keccak256(params)
        );
    }

    function _pqcAuthorize(
        address signer,
        bytes32 action,
        bytes memory params,
        uint256 deadline,
        bytes calldata signature
    ) internal {
        if (block.timestamp > deadline) revert Expired(deadline);
        uint256 n = pqcNonce[signer];
        PqcAuth.requireSigned(signer, pqcMessage(signer, action, params, n, deadline), signature);
        pqcNonce[signer] = n + 1;
        emit PqcAuthorized(signer, action, n, msg.sender);
    }
}
