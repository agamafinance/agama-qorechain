// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ZKNOX_dilithium} from "ETHDILITHIUM/ZKNOX_dilithium.sol";
import {IPqAttestationVerifier} from "./IPqAttestationVerifier.sol";

/// @title MlDsa44AttestationVerifier
/// @notice ML-DSA-44 (FIPS 204, NIST level 2) verified in plain Solidity on Ethereum, about 8M gas.
/// @dev The lattice arithmetic is ZKNox's ETHDILITHIUM NIST verifier (MIT, passes the NIST ML-DSA KATs), which
///      reads an expanded public key (the matrix A and t1 already in the NTT domain) stored once with SSTORE2. The
///      attester signs the 32-byte digest with an empty context, exactly as the `mldsa44.sign` of QoreChain's PQC kit (npm `qorechain/pqc`) does,
///      so the keeper signs with QoreChain's own PQC kit.
///
///      Level 2 and not QoreChain's level 5 because the gas says so: ML-DSA-87 multiplies a matrix 3.5 times larger
///      and lands above the 16,777,216 gas per transaction that Ethereum allows since Fusaka (EIP-7825). See
///      docs/PQ_ETHEREUM.md.
contract MlDsa44AttestationVerifier is IPqAttestationVerifier {
    ZKNOX_dilithium public immutable lattice;
    /// @notice The SSTORE2 pointer to the attester's expanded ML-DSA-44 public key, as `setKey` returns it.
    bytes public publicKey;
    /// @notice keccak256 of the raw 1,312-byte FIPS 204 public key the expansion was made from.
    bytes32 public immutable rawKeyHash;

    constructor(ZKNOX_dilithium lattice_, bytes memory expandedKey, bytes32 rawKeyHash_) {
        lattice = lattice_;
        publicKey = lattice_.setKey(expandedKey);
        rawKeyHash = rawKeyHash_;
    }

    function verify(bytes32 digest, bytes calldata proof) external view returns (bool) {
        if (proof.length != 2420) return false;
        return lattice.verify(publicKey, abi.encodePacked(digest), proof, "");
    }

    function scheme() external pure returns (string memory) {
        return "ML-DSA-44 (FIPS 204), ZKNox Solidity verifier";
    }
}
