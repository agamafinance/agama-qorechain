// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqcAuth} from "../pqc/PqcAuth.sol";
import {PqcGoverned} from "../pqc/PqcGoverned.sol";
import {AttestedMessenger, IBurnMintToken} from "./AttestedMessenger.sol";

/// @title PqAttestedMessenger
/// @notice The QoreChain leg. Every dollar that arrives on QoreChain was attested with ML-DSA-87: the attestation
///         is the attester's FIPS 204 signature over the CCTP message, checked by `pqcVerify` against the key the
///         attester registered on chain. A quantum computer that recovers the attester's secp256k1 key from its
///         public key still cannot mint a cent here.
/// @dev The attester is a QoreChain account, not a raw key: rotating its ML-DSA-87 key on chain rotates the
///      bridge's trust root with it, and a key registered without proof of possession is refused.
contract PqAttestedMessenger is AttestedMessenger, PqcGoverned {
    /// @notice Signed so a bridge attestation can never be replayed as any other ML-DSA-87 authorisation.
    bytes public constant ATTESTATION_TAG = "Agama:cctp-attestation:v1";

    address public attester;

    event AttesterChanged(address indexed previous, address indexed next);

    constructor(uint32 localDomain_, IBurnMintToken token_, address attester_, address admin_)
        AttestedMessenger(localDomain_, token_)
        PqcGoverned(admin_)
    {
        if (attester_ == address(0)) revert ZeroAddress();
        attester = attester_;
        emit AttesterChanged(address(0), attester_);
    }

    /// @notice The bytes the attester signs for `message`.
    function attestationMessage(bytes calldata message) public view returns (bytes memory) {
        return abi.encodePacked(ATTESTATION_TAG, block.chainid, address(this), keccak256(message));
    }

    function setAttester(address next, uint256 deadline, bytes calldata signature) external {
        if (next == address(0)) revert ZeroAddress();
        _onlyAdmin("setAttester", abi.encode(next), deadline, signature);
        emit AttesterChanged(attester, next);
        attester = next;
    }

    function setRemote(uint32 domain, bytes32 messenger, bytes32 token_, uint256 deadline, bytes calldata signature)
        external
    {
        _onlyAdmin("setRemote", abi.encode(domain, messenger, token_), deadline, signature);
        _setRemote(domain, messenger, token_);
    }

    /// @dev Replay is stopped by the CCTP nonce, which the base marks used.
    function _checkAttestation(bytes calldata message, bytes calldata attestation) internal view override {
        PqcAuth.requireSigned(attester, attestationMessage(message), attestation);
    }
}
