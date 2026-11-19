// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AttestedMessenger} from "../src/cctp/AttestedMessenger.sol";
import {PqAttestedMessenger} from "../src/cctp/PqAttestedMessenger.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";
import {PqcGoverned} from "../src/pqc/PqcGoverned.sol";
import {CctpMessageV2Harness} from "./utils/CctpMessageV2Harness.sol";

/// @notice The transport on its own, held to Circle's layout. QoreChain → Ethereum is attested with secp256k1,
///         Ethereum → QoreChain with ML-DSA-87 checked by `pqcVerify`.
contract AttestedMessengerTest is Fixture {
    CctpMessageV2Harness internal h = new CctpMessageV2Harness();

    /// @dev Burns on QoreChain towards Ethereum.
    function _burnQ(address from, uint256 amount, bytes32 to, bytes32 caller, bytes memory hook)
        internal
        returns (bytes memory)
    {
        _fund(from, amount);
        vm.startPrank(from);
        qUsdc.approve(address(qMessenger), amount);
        vm.recordLogs();
        qMessenger.depositForBurnWithHook(amount, ETHEREUM, to, address(qUsdc), caller, 0, 2000, hook);
        vm.stopPrank();
        return _lastMessage();
    }

    /// @dev Burns on Ethereum towards QoreChain.
    function _burnE(address from, uint256 amount, bytes32 to) internal returns (bytes memory) {
        _fundEth(from, amount);
        vm.startPrank(from);
        eUsdc.approve(address(eMessenger), amount);
        vm.recordLogs();
        eMessenger.depositForBurn(amount, QORECHAIN, to, address(eUsdc), bytes32(0), 0, 2000);
        vm.stopPrank();
        return _lastMessage();
    }

    // ---- the wire format ----

    function test_theMessageIsLaidOutAtCirclesOffsets() public {
        bytes memory m = _burnQ(alice, 42e6, _b32(bob), bytes32(0), hex"c0ffee");
        assertEq(h.sourceDomain(m), QORECHAIN);
        assertEq(h.destinationDomain(m), ETHEREUM);
        assertEq(h.sender(m), _b32(address(qMessenger)));
        assertEq(h.recipient(m), _b32(address(eMessenger)));
        assertEq(h.destinationCaller(m), bytes32(0));
        assertEq(h.burnToken(m), address(qUsdc));
        assertEq(h.mintRecipient(m), _b32(bob));
        assertEq(h.amount(m), 42e6);
        assertEq(h.messageSender(m), _b32(alice));
        assertEq(h.hookData(m), hex"c0ffee");
        assertEq(m.length, 148 + 228 + 3, "envelope + burn body + hook");
    }

    // ---- QoreChain → Ethereum, secp256k1 ----

    function test_burnsOnQoreChainAndMintsOnEthereum() public {
        bytes memory m = _burnQ(alice, 42e6, _b32(bob), bytes32(0), "");
        assertEq(qUsdc.balanceOf(alice), 0);
        eMessenger.receiveMessage(m, _attestEth(m));
        assertEq(eUsdc.balanceOf(bob), 42e6);
    }

    function test_aReplayIsRefused() public {
        bytes memory m = _burnQ(alice, 1e6, _b32(bob), bytes32(0), "");
        bytes memory a = _attestEth(m);
        eMessenger.receiveMessage(m, a);
        vm.expectRevert();
        eMessenger.receiveMessage(m, a);
    }

    function test_aMessageForAnotherDomainIsRefused() public {
        bytes memory m = _burnQ(alice, 1e6, _b32(bob), bytes32(0), "");
        // Delivered back to QoreChain with a valid ML-DSA attestation: still for Ethereum.
        bytes memory a = _attestQore(m);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.WrongDestination.selector, ETHEREUM));
        qMessenger.receiveMessage(m, a);
    }

    function test_anUnknownDomainCannotBeBurnedTowards() public {
        _fund(alice, 1e6);
        vm.startPrank(alice);
        qUsdc.approve(address(qMessenger), 1e6);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.UnknownDomain.selector, uint32(6)));
        qMessenger.depositForBurn(1e6, 6, _b32(bob), address(qUsdc), bytes32(0), 0, 2000);
        vm.stopPrank();
    }

    function test_burnInputsAreChecked() public {
        _fund(alice, 10e6);
        vm.startPrank(alice);
        qUsdc.approve(address(qMessenger), 10e6);
        vm.expectRevert(AttestedMessenger.ZeroAmount.selector);
        qMessenger.depositForBurn(0, ETHEREUM, _b32(bob), address(qUsdc), bytes32(0), 0, 2000);
        vm.expectRevert(AttestedMessenger.ZeroRecipient.selector);
        qMessenger.depositForBurn(1e6, ETHEREUM, bytes32(0), address(qUsdc), bytes32(0), 0, 2000);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.UnsupportedToken.selector, address(eUsdc)));
        qMessenger.depositForBurn(1e6, ETHEREUM, _b32(bob), address(eUsdc), bytes32(0), 0, 2000);
        vm.expectRevert(AttestedMessenger.FeeAboveAmount.selector);
        qMessenger.depositForBurn(1e6, ETHEREUM, _b32(bob), address(qUsdc), bytes32(0), 1e6, 2000);
        vm.stopPrank();
    }

    function test_anAddressThatIsNotOneIsRefusedRatherThanTruncated() public {
        bytes32 dirty = bytes32(uint256(1) << 200 | uint256(uint160(bob)));
        bytes memory m = _burnQ(alice, 1e6, dirty, bytes32(0), "");
        bytes memory a = _attestEth(m);
        vm.expectRevert();
        eMessenger.receiveMessage(m, a);
    }

    function test_onlyTheOwnerRotatesTheEthereumAttester() public {
        vm.prank(bob);
        vm.expectRevert();
        eMessenger.setAttester(bob);
        vm.prank(ethAdmin);
        eMessenger.setAttester(bob);
        assertEq(eMessenger.attester(), bob);
    }

    // ---- Ethereum → QoreChain, ML-DSA-87 ----

    function test_aValidMlDsaAttestationMints() public {
        bytes memory m = _burnE(alice, 42e6, _b32(bob));
        assertEq(eUsdc.balanceOf(alice), 0);
        bytes memory a = _attestQore(m);
        vm.prank(carol); // anyone relays
        assertTrue(qMessenger.receiveMessage(m, a));
        assertEq(qUsdc.balanceOf(bob), 42e6);
    }

    function test_theAttestationMessageIsDomainSeparated() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        assertEq(
            qMessenger.attestationMessage(m),
            abi.encodePacked("Agama:cctp-attestation:v1", block.chainid, address(qMessenger), keccak256(m))
        );
    }

    function test_aBadAttestationIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, hex"0badc0de");
        // A secp256k1 attestation means nothing on the post-quantum leg.
        bytes memory ecdsa = _attestEth(m);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, ecdsa);
        // Nor does a raw signature over the message without the attestation tag.
        bytes memory raw = _sign(pqAttester, m);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, raw);
    }

    function test_theWrongAttesterIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        bytes memory a = _sign(admin, qMessenger.attestationMessage(m));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, a);
    }

    function test_aTamperedMessageIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        bytes memory a = _attestQore(m);
        m[148 + 68 + 31] = bytes1(uint8(m[148 + 68 + 31]) + 1); // one more unit
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, a);
    }

    function test_aReplayedNonceIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        bytes memory a = _attestQore(m);
        qMessenger.receiveMessage(m, a);
        bytes32 nonce;
        assembly {
            nonce := mload(add(m, add(32, 12)))
        }
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.NonceUsed.selector, nonce));
        qMessenger.receiveMessage(m, a);
        assertEq(qUsdc.balanceOf(bob), 1e6);
    }

    function test_anUnprovenAttesterKeyIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        bytes memory a = _attestQore(m);
        pqc.setKey(pqAttester, pubkeyOf[pqAttester], false);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.PqcKeyNotProven.selector, pqAttester));
        qMessenger.receiveMessage(m, a);
    }

    function test_anAttestationForAnotherMessengerIsRefused() public {
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        // Signed for a messenger at another address (say, a redeploy) on the same chain.
        bytes memory a = _sign(
            pqAttester,
            abi.encodePacked("Agama:cctp-attestation:v1", block.chainid, address(0xBEEF), keccak256(m))
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        qMessenger.receiveMessage(m, a);
    }

    function test_aMessageFromAnUnknownMessengerIsRefused() public {
        // Unwire Ethereum on QoreChain: the same signed message no longer has a sender we know.
        bytes memory m = _burnE(alice, 1e6, _b32(bob));
        bytes memory a = _attestQore(m);
        _setRemoteQore(ETHEREUM, bytes32(0), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.UnknownSender.selector, _b32(address(eMessenger))));
        qMessenger.receiveMessage(m, a);
    }

    function test_setAttesterNeedsTheAdminsSignature() public {
        _setPqKey(carol, true);
        (uint256 d, bytes memory s) = _signed(address(qMessenger), pqAttester, "setAttester", abi.encode(carol));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        qMessenger.setAttester(carol, d, s);

        (d, s) = _signed(address(qMessenger), admin, "setAttester", abi.encode(carol));
        vm.expectEmit(address(qMessenger));
        emit PqAttestedMessenger.AttesterChanged(pqAttester, carol);
        qMessenger.setAttester(carol, d, s);
        assertEq(qMessenger.attester(), carol);

        // The old attester's word is worth nothing now; the new one's mints.
        bytes memory m = _burnE(alice, 5e6, _b32(bob));
        bytes memory old = _attestQore(m);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, carol));
        qMessenger.receiveMessage(m, old);
        qMessenger.receiveMessage(m, _sign(carol, qMessenger.attestationMessage(m)));
        assertEq(qUsdc.balanceOf(bob), 5e6);
    }

    function test_setAttesterRefusesZero() public {
        (uint256 d, bytes memory s) = _signed(address(qMessenger), admin, "setAttester", abi.encode(address(0)));
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        qMessenger.setAttester(address(0), d, s);
    }

    function test_setRemoteNeedsTheAdminsSignature() public {
        bytes32 messenger = _b32(makeAddr("arbMessenger"));
        bytes32 token = _b32(makeAddr("arbUsdc"));
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(
            bob, address(qMessenger), admin, "setRemote", abi.encode(uint32(3), messenger, token), d
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        qMessenger.setRemote(3, messenger, token, d, s);

        _setRemoteQore(3, messenger, token);
        assertEq(qMessenger.remoteMessenger(3), messenger);
        assertEq(qMessenger.remoteToken(3), token);
    }

    // ---- fuzz ----

    function testFuzz_anyAmountCrossesWholeBothWays(uint96 amount) public {
        vm.assume(amount > 0);
        bytes memory out = _burnQ(alice, amount, _b32(bob), bytes32(0), "");
        eMessenger.receiveMessage(out, _attestEth(out));
        assertEq(eUsdc.balanceOf(bob), amount);

        vm.startPrank(bob);
        eUsdc.approve(address(eMessenger), amount);
        vm.recordLogs();
        eMessenger.depositForBurn(amount, QORECHAIN, _b32(alice), address(eUsdc), bytes32(0), 0, 2000);
        vm.stopPrank();
        bytes memory back = _lastMessage();
        qMessenger.receiveMessage(back, _attestQore(back));
        assertEq(qUsdc.balanceOf(alice), amount);
        assertEq(eUsdc.balanceOf(bob), 0);
    }
}
