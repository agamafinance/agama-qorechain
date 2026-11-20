// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {DataRoom} from "../src/qore/DataRoom.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";
import {PqcGoverned} from "../src/pqc/PqcGoverned.sol";

/// @notice The encrypted loan tape: epochs whose members the registry approves, reports under an existing epoch,
///         every one signed by the manager's ML-DSA key.
contract DataRoomTest is Fixture {
    function _members2() internal view returns (address[] memory m) {
        m = new address[](2);
        m[0] = alice;
        m[1] = bob;
    }

    function _batch(uint256 size, uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(size);
        b[0] = 0x51; // Q
        b[1] = 0x53; // S
        b[2] = 0x42; // B
        b[3] = 0x54; // T
        b[size - 1] = bytes32(seed)[31];
    }

    function _one(bytes memory dist) internal pure returns (bytes32[] memory h) {
        h = new bytes32[](1);
        h[0] = keccak256(dist);
    }

    function _epochSigParts(uint256 epoch, address[] memory members, bytes32[] memory parts)
        internal
        view
        returns (uint256 d, bytes memory s)
    {
        return _signed(
            address(dataRoom),
            manager,
            "publishEpoch",
            abi.encode(epoch, keccak256(abi.encode(members)), keccak256(abi.encode(parts)))
        );
    }

    function _epochSig(uint256 epoch, address[] memory members, bytes memory dist)
        internal
        view
        returns (uint256 d, bytes memory s)
    {
        return _epochSigParts(epoch, members, _one(dist));
    }

    function _publishEpoch(uint256 epoch, address[] memory members) internal returns (bytes memory dist) {
        dist = _envelope(128, epoch);
        (uint256 d, bytes memory s) = _epochSig(epoch, members, dist);
        dataRoom.publishEpoch(epoch, members, _one(dist), d, s);
        dataRoom.publishEpochPart(epoch, 0, dist);
    }

    function _reportSig(uint256 epoch, bytes32 kind, bytes memory blob, bytes32 cc, bytes32 pc)
        internal
        view
        returns (uint256 d, bytes memory s)
    {
        return _signed(
            address(dataRoom), manager, "publishReport", abi.encode(epoch, kind, keccak256(blob), cc, pc)
        );
    }

    function _publishReport(uint256 epoch, bytes32 kind, uint256 seed) internal {
        bytes memory blob = _batch(120, seed);
        bytes32 cc = keccak256(blob);
        bytes32 pc = keccak256(abi.encode("plain", seed));
        (uint256 d, bytes memory s) = _reportSig(epoch, kind, blob, cc, pc);
        dataRoom.publishReport(epoch, kind, blob, cc, pc, d, s);
    }

    // ---- epochs ----

    function test_publishEpochRecordsTheMembers() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        (uint256 d, bytes memory s) = _epochSig(0, m, dist);
        vm.expectEmit(address(dataRoom));
        emit DataRoom.EpochPublished(0, m, _one(dist));
        vm.prank(carol); // anyone relays
        dataRoom.publishEpoch(0, m, _one(dist), d, s);

        assertEq(dataRoom.epochCount(), 1);
        assertTrue(dataRoom.isMember(0, alice));
        assertTrue(dataRoom.isMember(0, bob));
        assertFalse(dataRoom.isMember(0, carol));
        DataRoom.Epoch memory e = dataRoom.epochs(0);
        assertEq(e.publishedAt, vm.getBlockTimestamp());
        assertEq(e.blockNumber, block.number);
        assertEq(e.members, 2);
        assertEq(e.membersHash, keccak256(abi.encode(m)));
        assertEq(e.distributionHash, keccak256(abi.encode(_one(dist))));
        assertEq(e.parts, 1);
    }

    function test_epochsAreSequential() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 1);
        (uint256 d, bytes memory s) = _epochSig(1, m, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.WrongEpoch.selector, 0, 1));
        dataRoom.publishEpoch(1, m, _one(dist), d, s);

        _publishEpoch(0, m);
        (d, s) = _epochSig(0, m, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.WrongEpoch.selector, 1, 0));
        dataRoom.publishEpoch(0, m, _one(dist), d, s);

        _publishEpoch(1, m);
        assertEq(dataRoom.epochCount(), 2);
    }

    function test_aMemberLeavingIsNotInTheNextEpoch() public {
        _publishEpoch(0, _members2());
        _revoke(alice);
        address[] memory m = new address[](1);
        m[0] = bob;
        _publishEpoch(1, m);
        assertTrue(dataRoom.isMember(0, alice), "keeps what it could read");
        assertFalse(dataRoom.isMember(1, alice));
        assertTrue(dataRoom.isMember(1, bob));
    }

    function test_membersMustBeEligible() public {
        address[] memory m = new address[](3);
        m[0] = alice;
        m[1] = carol;
        m[2] = bob;
        bytes memory dist = _envelope(128, 0);
        (uint256 d, bytes memory s) = _epochSig(0, m, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.NotEligible.selector, carol));
        dataRoom.publishEpoch(0, m, _one(dist), d, s);

        _revoke(bob);
        m = _members2();
        (d, s) = _epochSig(0, m, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.NotEligible.selector, bob));
        dataRoom.publishEpoch(0, m, _one(dist), d, s);
    }

    function test_aDistributionPartMustBeAQoreSealEnvelope() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        dist[0] = 0x00;
        (uint256 d, bytes memory s) = _epochSig(0, m, dist);
        dataRoom.publishEpoch(0, m, _one(dist), d, s);
        vm.expectRevert(DataRoom.BadEnvelope.selector);
        dataRoom.publishEpochPart(0, 0, dist);
    }

    function test_aPartMustHashToWhatTheManagerSigned() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        (uint256 d, bytes memory s) = _epochSig(0, m, dist);
        dataRoom.publishEpoch(0, m, _one(dist), d, s);
        bytes memory forged = _envelope(128, 9);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.PartMismatch.selector, keccak256(dist), keccak256(forged)));
        vm.prank(carol);
        dataRoom.publishEpochPart(0, 0, forged);
        vm.prank(carol); // anyone posts the genuine one
        dataRoom.publishEpochPart(0, 0, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.PartPosted.selector, 0, 0));
        dataRoom.publishEpochPart(0, 0, dist);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.NoSuchPart.selector, 0, 1));
        dataRoom.publishEpochPart(0, 1, dist);
        assertEq(dataRoom.epochs(0).partsPosted, 1);
    }

    function test_partsSplitTheMembersInEights() public {
        address[] memory m = new address[](10);
        for (uint256 i; i < 10; ++i) {
            m[i] = makeAddr(string.concat("member", vm.toString(i)));
            _onboard(m[i]);
        }
        bytes32[] memory parts = new bytes32[](2);
        bytes memory p0 = _envelope(128, 100);
        bytes memory p1 = _envelope(128, 101);
        parts[0] = keccak256(p0);
        parts[1] = keccak256(p1);
        (uint256 d, bytes memory s) = _epochSigParts(0, m, parts);
        bytes32[] memory wrong = new bytes32[](1);
        wrong[0] = parts[0];
        vm.expectRevert(abi.encodeWithSelector(DataRoom.BadParts.selector, 10, 1));
        dataRoom.publishEpoch(0, m, wrong, d, s);
        dataRoom.publishEpoch(0, m, parts, d, s);
        dataRoom.publishEpochPart(0, 1, p1);
        (bool member, uint256 part, uint64 at) = dataRoom.partOf(0, m[9]);
        assertTrue(member);
        assertEq(part, 1);
        assertEq(at, block.number);
        (member, part, at) = dataRoom.partOf(0, m[3]);
        assertEq(part, 0);
        assertEq(at, 0, "part 0 not posted yet");
        (member,,) = dataRoom.partOf(0, carol);
        assertFalse(member);
    }

    function test_theEpochSignatureBindsMembersAndDistribution() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        (uint256 d, bytes memory s) = _epochSig(0, m, dist);

        address[] memory fewer = new address[](1);
        fewer[0] = alice;
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishEpoch(0, fewer, _one(dist), d, s);

        bytes memory other = _envelope(128, 1);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishEpoch(0, m, _one(other), d, s);
    }

    function test_onlyTheManagersKeyPublishes() public {
        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(
            admin,
            address(dataRoom),
            manager,
            "publishEpoch",
            abi.encode(uint256(0), keccak256(abi.encode(m)), keccak256(dist)),
            d
        );
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishEpoch(0, m, _one(dist), d, s);
    }

    // ---- reports ----

    function test_publishReport() public {
        _publishEpoch(0, _members2());
        bytes memory blob = _batch(83, 1);
        bytes32 cc = keccak256(blob);
        bytes32 pc = keccak256("plaintext");
        (uint256 d, bytes memory s) = _reportSig(0, "loan-tape", blob, cc, pc);
        vm.expectEmit(address(dataRoom));
        emit DataRoom.ReportPublished(0, 0, "loan-tape", blob, cc, pc);
        dataRoom.publishReport(0, "loan-tape", blob, cc, pc, d, s);

        assertEq(dataRoom.reportCount(), 1);
        DataRoom.Report memory r = dataRoom.reports(0);
        assertEq(r.epoch, 0);
        assertEq(r.publishedAt, vm.getBlockTimestamp());
        assertEq(r.blockNumber, block.number);
        assertEq(r.size, 83);
        assertEq(r.ciphertextCommitment, cc);
        assertEq(r.plaintextCommitment, pc);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(r.kind, bytes32("loan-tape"));
    }

    function test_aReportNeedsAnExistingEpoch() public {
        bytes memory blob = _batch(120, 1);
        (uint256 d, bytes memory s) = _reportSig(0, "nav", blob, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.NoSuchEpoch.selector, 0));
        dataRoom.publishReport(0, "nav", blob, 0, 0, d, s);

        _publishEpoch(0, _members2());
        (d, s) = _reportSig(1, "nav", blob, 0, 0);
        vm.expectRevert(abi.encodeWithSelector(DataRoom.NoSuchEpoch.selector, 1));
        dataRoom.publishReport(1, "nav", blob, 0, 0, d, s);
    }

    function test_aReportMustBeAQoreSealBatch() public {
        _publishEpoch(0, _members2());
        bytes memory blob = _envelope(120, 1); // QSEL, not QSBT
        (uint256 d, bytes memory s) = _reportSig(0, "nav", blob, 0, 0);
        vm.expectRevert(DataRoom.BadBatch.selector);
        dataRoom.publishReport(0, "nav", blob, 0, 0, d, s);

        blob = _batch(82, 1);
        (d, s) = _reportSig(0, "nav", blob, 0, 0);
        vm.expectRevert(DataRoom.BadBatch.selector);
        dataRoom.publishReport(0, "nav", blob, 0, 0, d, s);
    }

    function test_theReportSignatureBindsEveryField() public {
        _publishEpoch(0, _members2());
        _publishEpoch(1, _members2());
        bytes memory blob = _batch(120, 1);
        bytes32 cc = keccak256(blob);
        bytes32 pc = keccak256("p");
        (uint256 d, bytes memory s) = _reportSig(1, "nav", blob, cc, pc);

        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(0, "nav", blob, cc, pc, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(1, "tape", blob, cc, pc, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(1, "nav", _batch(120, 2), cc, pc, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(1, "nav", blob, bytes32(0), pc, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(1, "nav", blob, cc, bytes32(0), d, s);

        dataRoom.publishReport(1, "nav", blob, cc, pc, d, s);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, manager));
        dataRoom.publishReport(1, "nav", blob, cc, pc, d, s); // replay
    }

    function test_latestReportsIsNewestFirst() public {
        _publishEpoch(0, _members2());
        _publishReport(0, "r0", 0);
        _publishReport(0, "r1", 1);
        _publishReport(0, "r2", 2);

        DataRoom.Report[] memory r = dataRoom.latestReports(2);
        assertEq(r.length, 2);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(r[0].kind, bytes32("r2"));
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(r[1].kind, bytes32("r1"));

        r = dataRoom.latestReports(10);
        assertEq(r.length, 3);
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(r[2].kind, bytes32("r0"));

        assertEq(dataRoom.latestReports(0).length, 0);
    }

    function test_latestReportsOnAnEmptyRoom() public view {
        assertEq(dataRoom.latestReports(5).length, 0);
    }

    // ---- governance ----

    function test_setManagerNeedsTheAdmin() public {
        _setPqKey(carol, true);
        (uint256 d, bytes memory s) = _signed(address(dataRoom), manager, "setManager", abi.encode(carol));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        dataRoom.setManager(carol, d, s);

        (d, s) = _signed(address(dataRoom), admin, "setManager", abi.encode(carol));
        dataRoom.setManager(carol, d, s);
        assertEq(dataRoom.manager(), carol);

        address[] memory m = _members2();
        bytes memory dist = _envelope(128, 0);
        (d, s) = _epochSig(0, m, dist); // still signed by the old manager
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, carol));
        dataRoom.publishEpoch(0, m, _one(dist), d, s);
    }

    function test_setManagerRefusesZero() public {
        (uint256 d, bytes memory s) = _signed(address(dataRoom), admin, "setManager", abi.encode(address(0)));
        vm.expectRevert(PqcGoverned.ZeroAddress.selector);
        dataRoom.setManager(address(0), d, s);
    }
}
