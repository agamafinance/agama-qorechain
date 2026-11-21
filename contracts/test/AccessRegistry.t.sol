// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IHolderEligibility} from "@qorechain/asset-kit/interfaces/IHolderEligibility.sol";
import {Fixture} from "./utils/Fixture.sol";
import {AccessRegistry} from "../src/qore/AccessRegistry.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";
import {PqcGoverned} from "../src/pqc/PqcGoverned.sol";

/// @notice The lender flow: an ML-KEM key bound to a post-quantum account, a sealed dossier, and a compliance
///         decision that exists only as the officer's ML-DSA signature over the exact dossier it read.
contract AccessRegistryTest is Fixture {
    address internal dave = makeAddr("dave");

    function setUp() public override {
        super.setUp();
        _setPqKey(dave, true);
        vm.prank(dave);
        registry.publishEncryptionKey(_mlkemKey());
    }

    function _status(address account) internal view returns (AccessRegistry.Status s) {
        (s,,,,,,) = registry.members(account);
    }

    function _rejectSig(address account, bytes32 h, bytes memory letter)
        internal
        view
        returns (uint256 d, bytes memory s)
    {
        return _signed(address(registry), officer, "reject", abi.encode(account, h, keccak256(letter)));
    }

    // ---- publishing an encryption key ----

    // ---- the Asset Kit's guard decides "quantum safe" ----

    function test_theRegistryIsAnAssetKitEligibilityPolicy() public {
        address lender = makeAddr("asset-kit-lender");
        _onboard(lender);
        IHolderEligibility policy = registry;
        assertTrue(policy.isEligible(lender));
        assertEq(address(registry.hybridGuard()), address(hybridGuard));
    }

    function test_eligibilityFailsClosedWithoutThePrecompile() public {
        address lender = makeAddr("closed-lender");
        _onboard(lender);
        assertTrue(registry.isEligible(lender));
        // A network where pqcKeyStatus does not answer: the guard reads nothing and refuses everyone.
        vm.etch(address(0x0000000000000000000000000000000000000a02), "");
        assertFalse(registry.isEligible(lender));
    }

    function test_publishEncryptionKeyNeedsAQuantumSafeAccount() public {
        bytes memory k = _mlkemKey();
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NotQuantumSafe.selector, carol));
        registry.publishEncryptionKey(k);

        _setPqKey(carol, false); // registered, possession not proven
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NotQuantumSafe.selector, carol));
        registry.publishEncryptionKey(k);

        _setPqKey(carol, true);
        vm.expectEmit(address(registry));
        emit AccessRegistry.EncryptionKeyPublished(carol, keccak256(k));
        vm.prank(carol);
        registry.publishEncryptionKey(k);
        assertEq(registry.encryptionKey(carol), k);
    }

    function test_publishEncryptionKeyNeedsAnMlKem1024Key() public {
        _setPqKey(carol, true);
        bytes memory shortKey = new bytes(1567);
        bytes memory longKey = new bytes(1569);
        vm.startPrank(carol);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.BadEncryptionKey.selector, 1567));
        registry.publishEncryptionKey(shortKey);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.BadEncryptionKey.selector, 1569));
        registry.publishEncryptionKey(longKey);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.BadEncryptionKey.selector, 0));
        registry.publishEncryptionKey("");
        vm.stopPrank();
    }

    // ---- filing a dossier ----

    function test_fileDossierNeedsAnEncryptionKey() public {
        _setPqKey(carol, true);
        bytes memory env = _envelope(256, 1);
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NoEncryptionKey.selector, carol));
        registry.fileDossier(env);
    }

    function test_fileDossierNeedsAQuantumSafeAccount() public {
        bytes memory env = _envelope(256, 1);
        _removePqKey(dave);
        vm.prank(dave);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NotQuantumSafe.selector, dave));
        registry.fileDossier(env);
    }

    function test_fileDossierNeedsTheQselMagic() public {
        bytes memory env = _envelope(256, 1);
        env[3] = 0x00;
        vm.prank(dave);
        vm.expectRevert(AccessRegistry.BadEnvelope.selector);
        registry.fileDossier(env);
    }

    function test_fileDossierSizeBounds() public {
        bytes memory tooSmall = _envelope(63, 1);
        bytes memory tooBig = _envelope(16_385, 1);
        vm.startPrank(dave);
        vm.expectRevert(AccessRegistry.BadEnvelope.selector);
        registry.fileDossier(tooSmall);
        vm.expectRevert(AccessRegistry.BadEnvelope.selector);
        registry.fileDossier(tooBig);
        vm.expectRevert(AccessRegistry.BadEnvelope.selector);
        registry.fileDossier("QSE");
        registry.fileDossier(_envelope(64, 1));
        registry.fileDossier(_envelope(16_384, 2));
        vm.stopPrank();
        assertEq(registry.dossier(dave).length, 16_384);
    }

    function test_fileDossierStoresTheCiphertextAndQueuesTheApplicant() public {
        uint256 before = registry.applicantCount();
        bytes memory env = _envelope(300, 7);
        vm.expectEmit(address(registry));
        emit AccessRegistry.DossierFiled(dave, keccak256(env), 300);
        vm.prank(dave);
        registry.fileDossier(env);
        assertEq(registry.dossier(dave), env);
        assertEq(registry.applicantCount(), before + 1);
        assertEq(registry.applicants(before), dave);
        (AccessRegistry.Status s,, uint64 filedAt,,,, bytes32 h) = registry.members(dave);
        assertEq(uint8(s), uint8(AccessRegistry.Status.Pending));
        assertEq(filedAt, vm.getBlockTimestamp());
        assertEq(h, keccak256(env));

        // Refiling replaces the dossier but does not queue the applicant twice.
        _file(dave, 8);
        assertEq(registry.applicantCount(), before + 1);
    }

    // ---- approving ----

    function test_approveMakesTheAccountEligible() public {
        bytes32 h = _file(dave, 1);
        assertFalse(registry.isEligible(dave));
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        (uint256 d, bytes memory s) = _approveSig(dave, 2, exp, h, "sealed letter");
        vm.expectEmit(address(registry));
        emit AccessRegistry.Approved(dave, 2, exp, h, "sealed letter");
        vm.prank(carol); // anyone relays
        registry.approve(dave, 2, exp, h, "sealed letter", d, s);

        assertTrue(registry.isEligible(dave));
        (AccessRegistry.Status st, uint8 tier,, uint64 decidedAt, uint64 expiresAt, uint64 decidedBlock,) =
            registry.members(dave);
        assertEq(uint8(st), uint8(AccessRegistry.Status.Approved));
        assertEq(tier, 2);
        assertEq(decidedAt, vm.getBlockTimestamp());
        assertEq(expiresAt, exp);
        assertEq(decidedBlock, block.number);
    }

    function test_approveBindsTheDossierHash() public {
        bytes32 h1 = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        (uint256 d, bytes memory s) = _approveSig(dave, 1, exp, h1, "letter");

        // The lender swaps the dossier after the officer read it.
        bytes32 h2 = _file(dave, 2);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.StaleDossier.selector, h1, h2));
        registry.approve(dave, 1, exp, h1, "letter", d, s);

        // Nor can the stale signature be passed off against the new hash.
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, exp, h2, "letter", d, s);
    }

    function test_approveBindsTierExpiryAndLetter() public {
        bytes32 h = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        (uint256 d, bytes memory s) = _approveSig(dave, 1, exp, h, "letter");
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 3, exp, h, "letter", d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, exp + 1, h, "letter", d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, exp, h, "another letter", d, s);
        registry.approve(dave, 1, exp, h, "letter", d, s);
    }

    function test_onlyTheOfficersKeyApproves() public {
        bytes32 h = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(
            admin, address(registry), officer, "approve", abi.encode(dave, uint8(1), exp, h, keccak256("letter")), d
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, exp, h, "letter", d, s);
    }

    function test_approveRefusesAnExpiryInThePast() public {
        bytes32 h = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp());
        (uint256 d, bytes memory s) = _approveSig(dave, 1, exp, h, "letter");
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.AlreadyExpired.selector, exp));
        registry.approve(dave, 1, exp, h, "letter", d, s);
    }

    function test_approveNeedsAPendingDossier() public {
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        (uint256 d, bytes memory s) = _approveSig(dave, 1, exp, bytes32(0), "letter");
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NotPending.selector, dave, AccessRegistry.Status.None));
        registry.approve(dave, 1, exp, bytes32(0), "letter", d, s);

        // Already approved: a second approval of the same dossier is refused.
        (,,,,,, bytes32 h) = registry.members(alice);
        (d, s) = _approveSig(alice, 1, exp, h, "letter");
        vm.expectRevert(
            abi.encodeWithSelector(AccessRegistry.NotPending.selector, alice, AccessRegistry.Status.Approved)
        );
        registry.approve(alice, 1, exp, h, "letter", d, s);
    }

    function test_refilingWhileApprovedPutsTheAccountBackInReview() public {
        assertTrue(registry.isEligible(alice));
        bytes32 h = _file(alice, 99);
        assertFalse(registry.isEligible(alice));
        assertEq(uint8(_status(alice)), uint8(AccessRegistry.Status.Pending));
        _approve(alice, h);
        assertTrue(registry.isEligible(alice));
    }

    // ---- rejecting and revoking ----

    function test_reject() public {
        bytes32 h = _file(dave, 1);
        (uint256 d, bytes memory s) = _rejectSig(dave, h, "no");
        vm.expectEmit(address(registry));
        emit AccessRegistry.Rejected(dave, h, "no");
        registry.reject(dave, h, "no", d, s);
        assertEq(uint8(_status(dave)), uint8(AccessRegistry.Status.Rejected));
        assertFalse(registry.isEligible(dave));

        // A rejected lender may file again.
        bytes32 h2 = _file(dave, 2);
        assertEq(uint8(_status(dave)), uint8(AccessRegistry.Status.Pending));
        _approve(dave, h2);
        assertTrue(registry.isEligible(dave));
    }

    function test_rejectBindsTheDossierAndTheSigner() public {
        bytes32 h1 = _file(dave, 1);
        (uint256 d, bytes memory s) = _rejectSig(dave, h1, "no");
        bytes32 h2 = _file(dave, 2);
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.StaleDossier.selector, h1, h2));
        registry.reject(dave, h1, "no", d, s);

        d = vm.getBlockTimestamp() + 1 hours;
        s = _signedBy(dave, address(registry), officer, "reject", abi.encode(dave, h2, keccak256("no")), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.reject(dave, h2, "no", d, s);
    }

    function test_revoke() public {
        assertTrue(registry.isEligible(alice));
        vm.expectEmit(address(registry));
        emit AccessRegistry.Revoked(alice);
        _revoke(alice);
        assertEq(uint8(_status(alice)), uint8(AccessRegistry.Status.Revoked));
        assertFalse(registry.isEligible(alice));

        (uint256 d, bytes memory s) = _signed(address(registry), officer, "revoke", abi.encode(alice));
        vm.expectRevert(abi.encodeWithSelector(AccessRegistry.NotApproved.selector, alice));
        registry.revoke(alice, d, s);
    }

    function test_revokeNeedsTheOfficersSignature() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(admin, address(registry), officer, "revoke", abi.encode(alice), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.revoke(alice, d, s);
        assertTrue(registry.isEligible(alice));
    }

    // ---- eligibility ----

    function test_isEligibleLapsesAtExpiry() public {
        (,,,, uint64 exp,,) = registry.members(alice);
        vm.warp(exp - 1);
        assertTrue(registry.isEligible(alice));
        vm.warp(exp);
        assertFalse(registry.isEligible(alice));
    }

    function test_isEligibleFollowsTheAccountsPqKey() public {
        _removePqKey(alice);
        assertFalse(registry.isEligible(alice));
        _setPqKey(alice, true); // a rotated key keeps the approval
        assertTrue(registry.isEligible(alice));
    }

    // ---- views ----

    function test_pendingListsOnlyTheDossiersAwaitingADecision() public {
        address erin = makeAddr("erin");
        _setPqKey(erin, true);
        vm.prank(erin);
        registry.publishEncryptionKey(_mlkemKey());
        bytes32 hd = _file(dave, 1);
        _file(erin, 2);

        // alice, bob (approved), dave, erin (pending)
        (address[] memory out, uint256 next) = registry.pending(0, 10);
        assertEq(out.length, 2);
        assertEq(out[0], dave);
        assertEq(out[1], erin);
        assertEq(next, 4);

        // Paged: one at a time.
        (out, next) = registry.pending(0, 1);
        assertEq(out.length, 1);
        assertEq(out[0], dave);
        (out, next) = registry.pending(next, 1);
        assertEq(out.length, 1);
        assertEq(out[0], erin);
        (out, next) = registry.pending(next, 1);
        assertEq(out.length, 0);

        _approve(dave, hd);
        (out,) = registry.pending(0, 10);
        assertEq(out.length, 1);
        assertEq(out[0], erin);
    }

    function test_approvedListsTheEligibleAccounts() public {
        address[] memory a = registry.approved();
        assertEq(a.length, 2);
        assertEq(a[0], alice);
        assertEq(a[1], bob);

        _revoke(alice);
        a = registry.approved();
        assertEq(a.length, 1);
        assertEq(a[0], bob);

        _approve(dave, _file(dave, 1));
        a = registry.approved();
        assertEq(a.length, 2);
        assertEq(a[1], dave);
    }

    // ---- governance ----

    function test_setComplianceOfficerNeedsTheAdmin() public {
        _setPqKey(carol, true);
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(officer, address(registry), admin, "setComplianceOfficer", abi.encode(carol), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        registry.setComplianceOfficer(carol, d, s);

        (d, s) = _signed(address(registry), admin, "setComplianceOfficer", abi.encode(carol));
        registry.setComplianceOfficer(carol, d, s);
        assertEq(registry.complianceOfficer(), carol);

        // The old officer's decisions no longer count.
        (d, s) = _signed(address(registry), officer, "revoke", abi.encode(alice));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, carol));
        registry.revoke(alice, d, s);
        (d, s) = _signed(address(registry), carol, "revoke", abi.encode(alice));
        registry.revoke(alice, d, s);
    }

    function test_setComplianceOfficerRefusesZero() public {
        (uint256 d, bytes memory s) = _signed(address(registry), admin, "setComplianceOfficer", abi.encode(address(0)));
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        registry.setComplianceOfficer(address(0), d, s);
    }

    function test_constructorRefusesZeroRoles() public {
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        new AccessRegistry(address(0), officer, hybridGuard);
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        new AccessRegistry(admin, address(0), hybridGuard);
    }

    // ---- fuzzing: the officer's key, and only what it signed ----

    function testFuzz_noOtherKeyApproves(address forger) public {
        vm.assume(forger != officer);
        _setPqKey(forger, true);
        bytes32 h = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(
            forger, address(registry), officer, "approve", abi.encode(dave, uint8(1), exp, h, keccak256("letter")), d
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, exp, h, "letter", d, s);
        assertFalse(registry.isEligible(dave));
    }

    function testFuzz_anyChangedFieldVoidsTheApproval(uint8 tier, uint64 extra, bytes calldata letter) public {
        bytes32 h = _file(dave, 1);
        uint64 exp = uint64(vm.getBlockTimestamp() + 365 days);
        (uint256 d, bytes memory s) = _approveSig(dave, 1, exp, h, "letter");
        if (tier != 1) {
            vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
            registry.approve(dave, tier, exp, h, "letter", d, s);
        }
        uint64 later = exp + uint64(bound(extra, 1, 3650 days));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        registry.approve(dave, 1, later, h, "letter", d, s);
        if (keccak256(letter) != keccak256("letter")) {
            vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
            registry.approve(dave, 1, exp, h, letter, d, s);
        }
        assertFalse(registry.isEligible(dave));
        registry.approve(dave, 1, exp, h, "letter", d, s);
        assertTrue(registry.isEligible(dave));
    }

    function testFuzz_onlyAQoreSealEnvelopeOfTheRightSizeIsFiled(bytes calldata env) public {
        bool ok = env.length >= 64 && env.length <= 16_384 && bytes4(env[:4]) == bytes4("QSEL");
        vm.prank(dave);
        if (!ok) vm.expectRevert(AccessRegistry.BadEnvelope.selector);
        registry.fileDossier(env);
        if (ok) assertEq(registry.dossier(dave), env);
    }

    function testFuzz_onlyAnMlKem1024KeyIsPublished(uint16 length) public {
        uint256 n = bound(length, 0, 4_000);
        bytes memory k = new bytes(n);
        vm.prank(dave);
        if (n != 1568) vm.expectRevert(abi.encodeWithSelector(AccessRegistry.BadEncryptionKey.selector, n));
        registry.publishEncryptionKey(k);
    }
}
