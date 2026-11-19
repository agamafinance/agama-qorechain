// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @title QoreChain post-quantum precompiles
/// @notice Live on the qorechain-diana testnet, not on mainnet yet.
///  - 0x...0a01 `pqcVerify`: ML-DSA-87 (FIPS 204) verification, 2,592-byte key, 4,627-byte signature.
///  - 0x...0a02 `pqcKeyStatus`: the ML-DSA-87 key an account registered on chain, and whether it proved possession.
interface IQorePQC {
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external
        view
        returns (bool valid);

    function pqcKeyStatus(address account)
        external
        view
        returns (bool registered, uint8 algorithmId, bytes memory pubkey, bool possessionProven);
}
