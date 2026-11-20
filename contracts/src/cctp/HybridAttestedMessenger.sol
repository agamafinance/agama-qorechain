// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AttestedMessenger, IBurnMintToken} from "./AttestedMessenger.sol";
import {IPqAttestationVerifier} from "./pq/IPqAttestationVerifier.sol";

/// @title HybridAttestedMessenger
/// @notice The Ethereum leg, quantum resilient: a message from QoreChain is executed only with BOTH the attester's
///         secp256k1 signature and a post-quantum proof over the same digest, the way QoreChain itself signs every
///         transaction twice. A quantum computer that recovers the attester's secp256k1 key still mints nothing.
/// @dev The post-quantum check is a pluggable `IPqAttestationVerifier`: ML-DSA-44 verified in Solidity (FIPS 204),
///      or a hash-based Merkle WOTS+ scheme (XMSS construction on keccak256). There is no owner. The remote side is
///      fixed at construction, and the only way to change the attesters is a rotation attested by the current ones,
///      both signatures, so no classical key alone can ever change who attests.
contract HybridAttestedMessenger is AttestedMessenger {
    bytes public constant ATTESTATION_TAG = "Agama:eth-attestation:v1";
    bytes public constant ROTATION_TAG = "Agama:eth-rotation:v1";

    address public ecdsaAttester;
    IPqAttestationVerifier public pqVerifier;
    uint256 public rotations;
    /// @notice May set the first post-quantum verifier, once, then has no power at all.
    address private initializer;

    event AttestersRotated(address ecdsaAttester, address pqVerifier, uint256 rotation);

    error BadEcdsaAttestation();
    error BadPqAttestation();

    constructor(
        uint32 localDomain_,
        IBurnMintToken token_,
        uint32 remoteDomain,
        bytes32 remoteMessenger,
        bytes32 remoteToken_,
        address ecdsaAttester_
    ) AttestedMessenger(localDomain_, token_) {
        _setRemote(remoteDomain, remoteMessenger, remoteToken_);
        ecdsaAttester = ecdsaAttester_;
        initializer = msg.sender;
    }

    /// @notice Sets the first post-quantum verifier. Once: a verifier is built for this messenger's address, so it
    ///         cannot exist before it.
    function initPqVerifier(IPqAttestationVerifier verifier) external {
        require(msg.sender == initializer && address(pqVerifier) == address(0), "init");
        initializer = address(0);
        pqVerifier = verifier;
        emit AttestersRotated(ecdsaAttester, address(verifier), 0);
    }

    /// @notice The digest both signatures cover for `message`.
    function attestationDigest(bytes calldata message) public view returns (bytes32) {
        return keccak256(abi.encodePacked(ATTESTATION_TAG, block.chainid, address(this), keccak256(message)));
    }

    function rotationDigest(address nextEcdsa, address nextPq) public view returns (bytes32) {
        return keccak256(abi.encodePacked(ROTATION_TAG, block.chainid, address(this), nextEcdsa, nextPq, rotations));
    }

    /// @notice Replaces both attester keys, authorised by the current ones (both signatures over the rotation digest).
    function rotate(address nextEcdsa, IPqAttestationVerifier nextPq, bytes calldata attestation) external {
        _checkBoth(rotationDigest(nextEcdsa, address(nextPq)), attestation);
        ecdsaAttester = nextEcdsa;
        pqVerifier = nextPq;
        emit AttestersRotated(nextEcdsa, address(nextPq), ++rotations);
    }

    function _checkAttestation(bytes calldata message, bytes calldata attestation) internal override {
        _checkBoth(attestationDigest(message), attestation);
    }

    /// @dev attestation = abi.encode(bytes secp256k1Signature, bytes pqProof)
    function _checkBoth(bytes32 digest, bytes calldata attestation) private {
        (bytes memory ecdsaSig, bytes memory pqProof) = abi.decode(attestation, (bytes, bytes));
        if (ECDSA.recover(digest, ecdsaSig) != ecdsaAttester) revert BadEcdsaAttestation();
        if (address(pqVerifier) == address(0) || !pqVerifier.verify(digest, pqProof)) revert BadPqAttestation();
    }
}
