// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";
import {PqcSigned} from "../src/pqc/PqcSigned.sol";
import {PqcGoverned} from "../src/pqc/PqcGoverned.sol";

/// @notice The ML-DSA authorisation every privileged action rides on, exercised through agUSD's `setExempt` (an
///         admin action with parameters) and the registry. Each forgery has to fail on its own reason.
contract PqcAuthTest is Fixture {
    function _exemptSig(address account) internal view returns (uint256 d, bytes memory s) {
        return _signed(address(vault), admin, "setExempt", abi.encode(account, true));
    }

    function test_aValidSignatureAuthorisesAndAdvancesTheNonce() public {
        uint256 n = vault.pqcNonce(admin);
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.expectEmit(address(vault));
        emit PqcSigned.PqcAuthorized(admin, "setExempt", n, address(this));
        vault.setExempt(carol, true, d, s);
        assertTrue(vault.exempt(carol));
        assertEq(vault.pqcNonce(admin), n + 1);
    }

    function test_theMessageIsDomainSeparated() public view {
        bytes memory m = vault.pqcMessage(admin, "setExempt", abi.encode(carol, true), 7, 99);
        assertEq(
            m,
            abi.encodePacked(
                "Agama:pqc:v1",
                block.chainid,
                address(vault),
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes32("setExempt"),
                admin,
                uint256(7),
                uint256(99),
                keccak256(abi.encode(carol, true))
            )
        );
    }

    function test_theWrongSignerIsRefused() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(reporter, address(vault), admin, "setExempt", abi.encode(carol, true), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_garbageIsRefused() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, "");
    }

    function test_anUnprovenKeyIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        pqc.setKey(admin, pubkeyOf[admin], false);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.PqcKeyNotProven.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_anUnregisteredKeyIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        _removePqKey(admin);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.PqcKeyNotRegistered.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_aRotatedKeyVoidsOutstandingSignatures() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        _setPqKey(admin, true);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
        // The new key works at once.
        _setExempt(carol, true);
        assertTrue(vault.exempt(carol));
    }

    function test_aReplayedSignatureIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vault.setExempt(carol, true, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_aSignatureForAFutureNonceIsRefused() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _sign(
            admin, vault.pqcMessage(admin, "setExempt", abi.encode(carol, true), vault.pqcNonce(admin) + 1, d)
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_anExpiredDeadlineIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.warp(d + 1);
        vm.expectRevert(abi.encodeWithSelector(PqcSigned.Expired.selector, d));
        vault.setExempt(carol, true, d, s);
    }

    function test_theDeadlineItselfIsStillValid() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.warp(d);
        vault.setExempt(carol, true, d, s);
    }

    function test_aSignatureForOtherParametersIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(bob, true, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, false, d, s);
    }

    function test_aSignatureForAnotherActionIsRefused() public {
        // Same signer, same nonce, same deadline, signed for `unpause`.
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "unpause", "");
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_aSignatureForAnotherContractIsRefused() public {
        // The registry and the vault share an admin; the data room too. A signature for one is nothing to another.
        (uint256 d, bytes memory s) = _signed(address(dataRoom), admin, "setAdmin", abi.encode(carol));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setAdmin(carol, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        registry.setAdmin(carol, d, s);
        dataRoom.setAdmin(carol, d, s);
        assertEq(dataRoom.admin(), carol);
        assertEq(vault.admin(), admin);
    }

    function test_aSignatureForAnotherChainIsRefused() public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, s);
    }

    function test_nonceSequencesArePerSigner() public {
        _deposit(alice, 1_000e6);
        uint256 adminNonce = vault.pqcNonce(admin);
        _reportNav(0);
        assertEq(vault.pqcNonce(reporter), 1);
        assertEq(vault.pqcNonce(admin), adminNonce, "the reporter's report does not burn the admin's nonce");
    }

    function test_setAdminHandsOverTheRole() public {
        _setPqKey(carol, true);
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "setAdmin", abi.encode(carol));
        vm.expectEmit(address(vault));
        emit PqcGoverned.AdminChanged(admin, carol);
        vault.setAdmin(carol, d, s);
        assertEq(vault.admin(), carol);

        // The old admin's key no longer governs.
        (d, s) = _signed(address(vault), admin, "setExempt", abi.encode(bob, true));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, carol));
        vault.setExempt(bob, true, d, s);
        // The new one does.
        (d, s) = _signed(address(vault), carol, "setExempt", abi.encode(bob, true));
        vault.setExempt(bob, true, d, s);
        assertTrue(vault.exempt(bob));
    }

    function test_setAdminRefusesZero() public {
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "setAdmin", abi.encode(address(0)));
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        vault.setAdmin(address(0), d, s);
    }

    function test_quantumSafetyNeedsAProvenNonEmptyKey() public {
        assertTrue(registry.isEligible(alice));
        pqc.setKey(alice, pubkeyOf[alice], false);
        assertFalse(registry.isEligible(alice));
        pqc.setKey(alice, pubkeyOf[alice], true);
        assertTrue(registry.isEligible(alice));
    }

    function testFuzz_anyOtherSignatureIsRefused(bytes calldata forged) public {
        (uint256 d, bytes memory s) = _exemptSig(carol);
        vm.assume(keccak256(forged) != keccak256(s));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.setExempt(carol, true, d, forged);
    }
}
