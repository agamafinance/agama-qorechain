// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AttestedMessenger} from "../src/cctp/AttestedMessenger.sol";
import {CrossChainAllocator} from "../src/qore/CrossChainAllocator.sol";
import {AgamaL1Receiver} from "../src/l1/AgamaL1Receiver.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";

/// @notice The whole route, in the order it runs on the two testnets: an approved lender deposits on QoreChain,
///         capital crosses to Ethereum, subscribes, off-ramps, earns off chain, is marked, on-ramps, is redeemed,
///         crosses back under an ML-DSA attestation, and the lender leaves richer.
contract RoundTripTest is Fixture {
    function _allocate(uint256 amount) internal returns (bytes memory message) {
        vm.recordLogs();
        vm.prank(operator);
        allocator.allocate(amount);
        message = _lastMessage();
    }

    function _nav() internal view returns (uint256) {
        // What the keeper reports: the L1 position plus whatever is still crossing in either direction.
        uint256 outbound = allocator.totalSent() - receiver.totalReceived();
        uint256 inbound = receiver.totalSentHome() - allocator.totalReturned();
        return receiver.positionValue() + outbound + inbound;
    }

    function test_theWholeRoute() public {
        _deposit(alice, 1_000_000e6);
        uint256 priceBefore = vault.sharePrice();

        // 1. Out: 800k of the 1M crosses, the 10% reserve floor stays behind with room to spare.
        bytes memory out = _allocate(800_000e6);
        assertEq(vault.deployedAssets(), 800_000e6);
        assertEq(qUsdc.balanceOf(address(vault)), 200_000e6);
        assertEq(vault.totalAssets(), 1_000_000e6, "a crossing is not a loss");

        // 2. In on Ethereum, subscribed by the hook in the same call.
        receiver.relay(out, _attestEth(out));
        assertEq(issuer.balanceOf(address(receiver)), 800_000e6);
        assertEq(_nav(), 800_000e6);

        // 3. The issuer wires 90% to custody and the book earns 10% a year for a quarter.
        vm.startPrank(ethAdmin);
        issuer.offRamp(720_000e6, "wire-0001");
        assertEq(eUsdc.balanceOf(custody), 720_000e6);
        skip(91 days);
        uint256 interest = uint256(720_000e6) * 1_000 * 91 / (10_000 * 365);
        issuer.reportNav(720_000e6 + interest, keccak256("loan-tape-Q1"));
        vm.stopPrank();
        assertApproxEqAbs(_nav(), 800_000e6 + interest, 1);

        // 4. QoreChain marks it under the reporter's ML-DSA signature. The gain unlocks over a day.
        _reportNav(_nav());
        assertApproxEqAbs(vault.sharePrice(), priceBefore, 1, "nothing unlocked in the report's own block");
        skip(1 days);
        assertGt(vault.sharePrice(), priceBefore);

        // 5. Collections come home: custody on-ramps principal and interest, the receiver redeems and burns back.
        _fundEth(custody, interest);
        vm.startPrank(ethAdmin);
        issuer.onRamp(720_000e6 + interest, "collections-Q1");
        vm.recordLogs();
        receiver.redeemAndSendHome(issuer.balanceOf(address(receiver)));
        vm.stopPrank();
        bytes memory back = _lastMessage();
        assertApproxEqAbs(_nav(), 800_000e6 + interest, 1, "in flight home still counts");

        // 6. Anyone relays it on QoreChain under the attester's ML-DSA signature. The vault is whole and then some.
        bytes memory att = _attestQore(back);
        vm.prank(bob);
        allocator.settleReturn(back, att);
        assertEq(vault.deployedAssets(), 0);
        assertApproxEqAbs(qUsdc.balanceOf(address(vault)), 1_000_000e6 + interest, 1);

        // 7. Alice leaves with her principal and the yield, net of the 10% performance fee.
        skip(1 days);
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 paid = vault.redeem(shares, alice, alice);
        uint256 expected = 1_000_000e6 + interest * 9 / 10;
        assertApproxEqRel(paid, expected, 1e14);
        assertGt(vault.balanceOf(treasury), 0, "the fee was taken in shares");
    }

    function test_aQueuedExitIsPaidByTheReturn() public {
        _deposit(alice, 1_000e6);
        bytes memory out = _allocate(900e6);
        receiver.relay(out, _attestEth(out));
        vm.prank(alice);
        vault.requestRedeem(500e6, alice, alice);
        assertEq(qUsdc.balanceOf(alice), 0);

        vm.recordLogs();
        vm.prank(ethAdmin);
        receiver.redeemAndSendHome(400e6);
        bytes memory back = _lastMessage();
        allocator.settleReturn(back, _attestQore(back));
        assertEq(qUsdc.balanceOf(alice), 500e6);
    }

    function test_aMessageCanOnlyBeExecutedByTheContractItWasMeantFor() public {
        _deposit(alice, 100e6);
        bytes memory out = _allocate(50e6);
        bytes memory att = _attestEth(out);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.WrongCaller.selector, _b32(address(receiver))));
        eMessenger.receiveMessage(out, att);

        receiver.relay(out, att);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.NonceUsed.selector, _nonce(out)));
        receiver.relay(out, att);
    }

    function test_theReturnCanOnlyBeExecutedByTheAllocator() public {
        _deposit(alice, 100e6);
        bytes memory out = _allocate(50e6);
        receiver.relay(out, _attestEth(out));
        vm.recordLogs();
        vm.prank(ethAdmin);
        receiver.redeemAndSendHome(50e6);
        bytes memory back = _lastMessage();
        bytes memory att = _attestQore(back);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.WrongCaller.selector, _b32(address(allocator))));
        qMessenger.receiveMessage(back, att);
        allocator.settleReturn(back, att);
        vm.expectRevert(abi.encodeWithSelector(AttestedMessenger.NonceUsed.selector, _nonce(back)));
        allocator.settleReturn(back, att);
    }

    function test_aForgedAttestationIsRefusedOnEitherLeg() public {
        _deposit(alice, 100e6);
        bytes memory out = _allocate(50e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, keccak256(out));
        vm.expectRevert(AttestedMessenger.InvalidAttestation.selector);
        receiver.relay(out, abi.encodePacked(r, s, v));

        receiver.relay(out, _attestEth(out));
        vm.recordLogs();
        vm.prank(ethAdmin);
        receiver.redeemAndSendHome(50e6);
        bytes memory back = _lastMessage();
        // The attester's secp256k1 key, even if a quantum computer recovered it, mints nothing on QoreChain.
        bytes memory classical = _attestEth(back);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        allocator.settleReturn(back, classical);
        bytes memory wrongKey = _sign(admin, qMessenger.attestationMessage(back));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, pqAttester));
        allocator.settleReturn(back, wrongKey);
    }

    function test_aTamperedMessageNoLongerMatchesItsAttestation() public {
        _deposit(alice, 100e6);
        bytes memory out = _allocate(50e6);
        bytes memory att = _attestEth(out);
        out[148 + 68 + 31] = bytes1(uint8(out[148 + 68 + 31]) + 1); // nudge the amount by one unit
        vm.expectRevert(AttestedMessenger.InvalidAttestation.selector);
        receiver.relay(out, att);
    }

    function test_theReceiverOnlyAcceptsTheAllocator() public {
        // A burn by somebody else towards the receiver is valid CCTP, and still not ours to subscribe.
        _fund(bob, 10e6);
        vm.startPrank(bob);
        qUsdc.approve(address(qMessenger), 10e6);
        vm.recordLogs();
        qMessenger.depositForBurn(10e6, ETHEREUM, _b32(address(receiver)), address(qUsdc), bytes32(0), 0, 2000);
        vm.stopPrank();
        bytes memory m = _lastMessage();
        bytes memory att = _attestEth(m);
        vm.expectRevert(abi.encodeWithSelector(AgamaL1Receiver.WrongSender.selector, _b32(bob)));
        receiver.relay(m, att);
    }

    function test_theAllocatorOnlyAcceptsTheReceiver() public {
        // Somebody burns on Ethereum towards the allocator: real USDC, but not a return of the vault's capital.
        _fundEth(bob, 10e6);
        vm.startPrank(bob);
        eUsdc.approve(address(eMessenger), 10e6);
        vm.recordLogs();
        eMessenger.depositForBurn(10e6, QORECHAIN, _b32(address(allocator)), address(eUsdc), bytes32(0), 0, 2000);
        vm.stopPrank();
        bytes memory m = _lastMessage();
        bytes memory att = _attestQore(m);
        vm.expectRevert(abi.encodeWithSelector(CrossChainAllocator.WrongSender.selector, _b32(bob)));
        allocator.settleReturn(m, att);
    }

    function test_onlyTheOperatorAllocates() public {
        _deposit(alice, 100e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CrossChainAllocator.NotOperator.selector, bob));
        allocator.allocate(50e6);
        vm.prank(operator);
        vm.expectRevert(CrossChainAllocator.ZeroAmount.selector);
        allocator.allocate(0);
    }

    function test_theOperatorCannotBreachTheReserveFloor() public {
        _deposit(alice, 100e6);
        vm.prank(operator);
        vm.expectRevert();
        allocator.allocate(91e6);
    }

    function test_setOperatorNeedsTheAdminsSignature() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(operator, address(allocator), admin, "setOperator", abi.encode(bob), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        allocator.setOperator(bob, d, s);

        (d, s) = _signed(address(allocator), admin, "setOperator", abi.encode(bob));
        allocator.setOperator(bob, d, s);
        assertEq(allocator.operator(), bob);
        _deposit(alice, 100e6);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(CrossChainAllocator.NotOperator.selector, operator));
        allocator.allocate(10e6);
    }

    function test_theDestinationIsLockedWhileCapitalIsOut() public {
        _deposit(alice, 100e6);
        _allocate(50e6);
        (uint256 d, bytes memory s) = _signed(address(allocator), admin, "setRemoteReceiver", abi.encode(_b32(bob)));
        vm.expectRevert(abi.encodeWithSelector(CrossChainAllocator.ReceiverLocked.selector, 50e6));
        allocator.setRemoteReceiver(_b32(bob), d, s);
    }

    function test_setRemoteReceiverNeedsTheAdminAndANonZeroReceiver() public {
        (uint256 d, bytes memory s) =
            _signed(address(allocator), admin, "setRemoteReceiver", abi.encode(bytes32(0)));
        vm.expectRevert(CrossChainAllocator.ReceiverNotSet.selector);
        allocator.setRemoteReceiver(bytes32(0), d, s);

        d = vm.getBlockTimestamp() + 1 hours;
        s = _signedBy(operator, address(allocator), admin, "setRemoteReceiver", abi.encode(_b32(bob)), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        allocator.setRemoteReceiver(_b32(bob), d, s);

        _setRemoteReceiver(_b32(bob));
        assertEq(allocator.remoteReceiver(), _b32(bob));
    }

    function test_theAllowanceDoesNotOutliveTheBurn() public {
        _deposit(alice, 100e6);
        _allocate(50e6);
        assertEq(qUsdc.allowance(address(allocator), address(qMessenger)), 0);
    }

    function test_burnAndMintConservesSupplyAcrossBothLegs() public {
        _deposit(alice, 1_000e6);
        uint256 before = qUsdc.totalSupply() + eUsdc.totalSupply();
        bytes memory out = _allocate(600e6);
        assertEq(qUsdc.totalSupply() + eUsdc.totalSupply(), before - 600e6, "burned, not yet minted");
        receiver.relay(out, _attestEth(out));
        assertEq(qUsdc.totalSupply() + eUsdc.totalSupply(), before);
    }

    function _nonce(bytes memory m) private pure returns (bytes32 n) {
        assembly {
            n := mload(add(m, add(32, 12)))
        }
    }
}
