// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title IPqAttestationVerifier
/// @notice A post-quantum check of a bridge attestation on a chain that has no post-quantum precompile. The messenger
///         that holds it is the only caller that may consume state (a stateful hash-based scheme spends a one-time
///         key per attestation).
interface IPqAttestationVerifier {
    /// @notice True when `proof` is a valid post-quantum signature over `digest` by the key this verifier holds.
    function verify(bytes32 digest, bytes calldata proof) external returns (bool);

    /// @notice What the proof is, for explorers and the app: e.g. "ML-DSA-44 (FIPS 204)".
    function scheme() external view returns (string memory);
}
