// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {AttestedMessenger, IBurnMintToken} from "./AttestedMessenger.sol";

/// @title EcdsaAttestedMessenger
/// @notice The Ethereum leg. Ethereum cannot verify ML-DSA-87 at a sane gas cost, so messages arriving here from
///         QoreChain carry the attester's secp256k1 signature, which is what Circle's own attesters use. The same
///         attester signs the other direction with ML-DSA-87 (see PqAttestedMessenger).
contract EcdsaAttestedMessenger is AttestedMessenger, Ownable2Step {
    address public attester;

    event AttesterChanged(address indexed previous, address indexed next);

    constructor(uint32 localDomain_, IBurnMintToken token_, address attester_, address owner_)
        AttestedMessenger(localDomain_, token_)
        Ownable(owner_)
    {
        attester = attester_;
        emit AttesterChanged(address(0), attester_);
    }

    function setAttester(address next) external onlyOwner {
        emit AttesterChanged(attester, next);
        attester = next;
    }

    function setRemote(uint32 domain, bytes32 messenger, bytes32 token_) external onlyOwner {
        _setRemote(domain, messenger, token_);
    }

    function _checkAttestation(bytes calldata message, bytes calldata attestation) internal view override {
        if (ECDSA.recover(keccak256(message), attestation) != attester) revert InvalidAttestation();
    }
}
