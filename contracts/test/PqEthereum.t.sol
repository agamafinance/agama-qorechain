// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, console} from "forge-std/Test.sol";
import {ZKNOX_dilithium} from "ETHDILITHIUM/ZKNOX_dilithium.sol";
import {MlDsa44AttestationVerifier} from "../src/cctp/pq/MlDsa44AttestationVerifier.sol";
import {MerkleWotsAttestationVerifier} from "../src/cctp/pq/MerkleWotsAttestationVerifier.sol";
import {IPqAttestationVerifier} from "../src/cctp/pq/IPqAttestationVerifier.sol";
import {HybridAttestedMessenger} from "../src/cctp/HybridAttestedMessenger.sol";
import {IBurnMintToken} from "../src/cctp/AttestedMessenger.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {CctpMessageV2} from "../src/libraries/CctpMessageV2.sol";

/// @notice The two post-quantum verifiers of the Ethereum leg against vectors signed by the keeper's own code
///         (keeper/src/vectors.ts): ML-DSA-44 from QoreChain's PQC kit, Merkle WOTS+ from keeper/src/pqeth.ts.
contract PqVerifiersTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("test/vectors/pq.json");
    }

    // ---- ML-DSA-44 (FIPS 204) ----

    function _mldsa() internal returns (MlDsa44AttestationVerifier v, bytes32 digest, bytes memory sig) {
        ZKNOX_dilithium lattice = new ZKNOX_dilithium();
        v = new MlDsa44AttestationVerifier(
            lattice, vm.parseJsonBytes(json, ".mldsa44.expandedKey"), vm.parseJsonBytes32(json, ".mldsa44.rawKeyHash")
        );
        digest = vm.parseJsonBytes32(json, ".mldsa44.digest");
        sig = vm.parseJsonBytes(json, ".mldsa44.signature");
    }

    function test_mldsa44_aQorechainPqcSignatureVerifies() public {
        (MlDsa44AttestationVerifier v, bytes32 digest, bytes memory sig) = _mldsa();
        uint256 g = gasleft();
        assertTrue(v.verify(digest, sig));
        console.log("ML-DSA-44 verify gas", g - gasleft());
    }

    function test_mldsa44_aFlippedBitFails() public {
        (MlDsa44AttestationVerifier v, bytes32 digest, bytes memory sig) = _mldsa();
        sig[777] ^= 0x01;
        assertFalse(v.verify(digest, sig));
    }

    function test_mldsa44_anotherDigestFails() public {
        (MlDsa44AttestationVerifier v,, bytes memory sig) = _mldsa();
        assertFalse(v.verify(keccak256("another message"), sig));
    }

    function test_mldsa44_aShortSignatureFails() public {
        (MlDsa44AttestationVerifier v, bytes32 digest,) = _mldsa();
        assertFalse(v.verify(digest, new bytes(2419)));
    }

    // ---- Merkle WOTS+ ----

    function _wots(address consumer) internal returns (MerkleWotsAttestationVerifier) {
        return new MerkleWotsAttestationVerifier(
            vm.parseJsonBytes32(json, ".wots.root"),
            vm.parseJsonBytes32(json, ".wots.pubSeed"),
            uint8(vm.parseJsonUint(json, ".wots.height")),
            consumer
        );
    }

    function _wotsCase(uint256 k) internal view returns (bytes32 digest, bytes memory sig) {
        digest = vm.parseJsonBytes32(json, string.concat(".wots.digests[", vm.toString(k), "]"));
        sig = vm.parseJsonBytes(json, string.concat(".wots.signatures[", vm.toString(k), "]"));
    }

    function test_wots_signaturesVerifyInLeafOrder() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        for (uint256 k; k < 4; ++k) {
            (bytes32 digest, bytes memory sig) = _wotsCase(k);
            uint256 g = gasleft();
            assertTrue(v.verify(digest, sig));
            if (k == 0) console.log("Merkle WOTS+ verify gas", g - gasleft());
        }
        assertEq(v.nextLeaf(), 16);
        assertEq(v.capacity(), 0);
    }

    function test_wots_aLeafIsSpentOnce() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        (bytes32 d0, bytes memory s0) = _wotsCase(0);
        assertTrue(v.verify(d0, s0));
        assertFalse(v.verify(d0, s0), "replay of a spent leaf");
    }

    function test_wots_anEarlierLeafCannotComeBack() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        (bytes32 d2, bytes memory s2) = _wotsCase(2); // leaf 5
        assertTrue(v.verify(d2, s2));
        (bytes32 d1, bytes memory s1) = _wotsCase(1); // leaf 1, never used, but below the mark
        assertFalse(v.verify(d1, s1));
    }

    function test_wots_aSignatureForAnotherDigestFails() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        (, bytes memory s0) = _wotsCase(0);
        assertFalse(v.verify(keccak256("forged"), s0));
    }

    function test_wots_aTamperedChainFails() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        (bytes32 d0, bytes memory s0) = _wotsCase(0);
        s0[100] ^= 0x01;
        assertFalse(v.verify(d0, s0));
    }

    function test_wots_onlyTheMessengerSpendsLeaves() public {
        MerkleWotsAttestationVerifier v = _wots(address(0xBEEF));
        (bytes32 d0, bytes memory s0) = _wotsCase(0);
        vm.expectRevert(MerkleWotsAttestationVerifier.OnlyConsumer.selector);
        v.verify(d0, s0);
    }

    function test_wots_checksumDigits() public {
        MerkleWotsAttestationVerifier v = _wots(address(this));
        uint8[67] memory d = v.digits(bytes32(0));
        // every digit 0: checksum = 64 * 15 = 960 = 0x3c0
        assertEq(d[64], 3);
        assertEq(d[65], 12);
        assertEq(d[66], 0);
        d = v.digits(bytes32(type(uint256).max));
        assertEq(d[0], 15);
        assertEq(d[64] + d[65] + d[66], 0);
    }
}

/// @notice Accepts a proof equal to keccak256(digest): enough to drive every path of the hybrid messenger.
contract MockPqVerifier is IPqAttestationVerifier {
    function verify(bytes32 digest, bytes calldata proof) external pure returns (bool) {
        return keccak256(proof) == keccak256(abi.encodePacked(keccak256(abi.encodePacked(digest))));
    }

    function scheme() external pure returns (string memory) {
        return "mock";
    }
}

contract HybridMessengerTest is Test {
    uint32 constant QORE = 9800;
    MockUSDC usdc;
    HybridAttestedMessenger messenger;
    MockPqVerifier pq;
    uint256 attesterKey = 0xA77E57;
    address attester;
    bytes32 remoteMessenger = bytes32(uint256(0xAAAA));
    bytes32 remoteToken = bytes32(uint256(0xBBBB));
    address recipient = makeAddr("recipient");

    function setUp() public {
        attester = vm.addr(attesterKey);
        usdc = new MockUSDC(address(this));
        messenger = new HybridAttestedMessenger(0, IBurnMintToken(address(usdc)), QORE, remoteMessenger, remoteToken, attester);
        usdc.grantRole(usdc.MINTER_ROLE(), address(messenger));
        pq = new MockPqVerifier();
        messenger.initPqVerifier(pq);
    }

    function _message(uint256 nonce, uint256 amount) internal view returns (bytes memory) {
        bytes memory body = CctpMessageV2.formatBurnBody(
            address(uint160(uint256(remoteToken))), CctpMessageV2.toBytes32(recipient), amount, bytes32(0), 0, ""
        );
        return CctpMessageV2.formatMessage(
            QORE, 0, bytes32(nonce), remoteMessenger, CctpMessageV2.toBytes32(address(messenger)), bytes32(0), 2000, body
        );
    }

    function _attest(bytes32 digest, uint256 key) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encode(abi.encodePacked(r, s, v), abi.encodePacked(keccak256(abi.encodePacked(digest))));
    }

    function test_bothSignaturesMint() public {
        bytes memory m = _message(1, 5e6);
        messenger.receiveMessage(m, _attest(messenger.attestationDigest(m), attesterKey));
        assertEq(usdc.balanceOf(recipient), 5e6);
    }

    function test_theSecp256k1KeyAloneMintsNothing() public {
        bytes memory m = _message(2, 5e6);
        bytes32 digest = messenger.attestationDigest(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(attesterKey, digest);
        bytes memory att = abi.encode(abi.encodePacked(r, s, v), bytes("not a post-quantum proof"));
        vm.expectRevert(HybridAttestedMessenger.BadPqAttestation.selector);
        messenger.receiveMessage(m, att);
    }

    function test_thePqProofAloneMintsNothing() public {
        bytes memory m = _message(3, 5e6);
        bytes memory att = _attest(messenger.attestationDigest(m), 0xBAD);
        vm.expectRevert(HybridAttestedMessenger.BadEcdsaAttestation.selector);
        messenger.receiveMessage(m, att);
    }

    function test_noOneButTheDeployerInitialisesOnce() public {
        vm.expectRevert(bytes("init"));
        messenger.initPqVerifier(pq);
    }

    function test_rotationNeedsBothCurrentSignatures() public {
        MockPqVerifier next = new MockPqVerifier();
        address nextEcdsa = makeAddr("next attester");
        bytes32 digest = messenger.rotationDigest(nextEcdsa, address(next));
        vm.expectRevert(HybridAttestedMessenger.BadEcdsaAttestation.selector);
        messenger.rotate(nextEcdsa, next, _attest(digest, 0xBAD));
        messenger.rotate(nextEcdsa, next, _attest(digest, attesterKey));
        assertEq(messenger.ecdsaAttester(), nextEcdsa);
        assertEq(address(messenger.pqVerifier()), address(next));
        assertEq(messenger.rotations(), 1);
        // the old attestation cannot be replayed: the digest carries the rotation count
        vm.expectRevert(HybridAttestedMessenger.BadEcdsaAttestation.selector);
        messenger.rotate(nextEcdsa, next, _attest(digest, attesterKey));
    }

    function test_aReplayedMessageIsRefused() public {
        bytes memory m = _message(4, 1e6);
        bytes memory att = _attest(messenger.attestationDigest(m), attesterKey);
        messenger.receiveMessage(m, att);
        vm.expectRevert();
        messenger.receiveMessage(m, att);
    }
}
