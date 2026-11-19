// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AgUSD} from "../src/qore/AgUSD.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/// @notice The permission gate: shares only land on accounts the AccessRegistry approved (or the exempt fee
///         recipient), and burning is never gated, so nobody's money is trapped by a lapsed approval.
contract AgUSDPermissionTest is Fixture {
    address internal strategist = makeAddr("strategist");

    function setUp() public override {
        super.setUp();
        _setRoles(reporter, guardian, strategist);
        vm.prank(strategist);
        qUsdc.approve(address(vault), type(uint256).max);
    }

    function _push(uint256 amount) internal {
        vm.prank(strategist);
        vault.pushToStrategy(amount);
    }

    function test_canHoldFollowsTheRegistry() public view {
        assertTrue(vault.canHold(alice));
        assertTrue(vault.canHold(bob));
        assertTrue(vault.canHold(treasury), "exempt");
        assertFalse(vault.canHold(carol));
    }

    function test_aDepositToANonEligibleReceiverReverts() public {
        assertEq(vault.maxDeposit(carol), 0);
        assertEq(vault.maxMint(carol), 0);
        _fund(carol, 100e6);
        vm.startPrank(carol);
        qUsdc.approve(address(vault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, carol, 100e6, 0));
        vault.deposit(100e6, carol);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxMint.selector, carol, 100e6, 0));
        vault.mint(100e6, carol);
        vm.stopPrank();
    }

    function test_anEligibleLenderCannotDepositForSomebodyNotEligible() public {
        _fund(alice, 100e6);
        vm.startPrank(alice);
        qUsdc.approve(address(vault), 100e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, carol, 100e6, 0));
        vault.deposit(100e6, carol);
        vm.stopPrank();
    }

    function test_anyoneMayPayForAnEligibleReceiver() public {
        // The gate is on who holds, not on whose USDC it was.
        _fund(carol, 100e6);
        vm.startPrank(carol);
        qUsdc.approve(address(vault), 100e6);
        vault.deposit(100e6, alice);
        vm.stopPrank();
        assertEq(vault.balanceOf(alice), 100e6);
    }

    function test_aTransferToANonEligibleAccountReverts() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, carol));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(carol, 1e6);

        vm.prank(alice);
        vault.approve(bob, 10e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, carol));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transferFrom(alice, carol, 1e6);
    }

    function test_eligibleHoldersTransferFreely() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, 40e6);
        assertEq(vault.balanceOf(bob), 40e6);
    }

    function test_aRevokedHolderCanStillLeaveButCannotPassSharesOn() public {
        _deposit(alice, 1_000e6);
        _revoke(alice);
        assertFalse(vault.canHold(alice));
        assertEq(vault.maxDeposit(alice), 0);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, alice));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, 1e6);

        // Instant exit through the buffer.
        vm.prank(alice);
        vault.redeem(100e6, alice, alice);
        assertEq(qUsdc.balanceOf(alice), 100e6);

        // And the queue, for the rest.
        _push(800e6);
        vm.prank(alice);
        vault.requestRedeem(800e6, alice, alice);
        vm.prank(strategist);
        vault.returnFromStrategy(800e6);
        assertEq(qUsdc.balanceOf(alice), 900e6);
        assertEq(vault.balanceOf(alice), 100e6);
        vm.prank(alice);
        vault.withdraw(100e6, alice, alice);
        assertEq(vault.balanceOf(alice), 0);
    }

    function test_aLapsedApprovalBehavesLikeARevocation() public {
        _deposit(alice, 100e6);
        vm.warp(vm.getBlockTimestamp() + APPROVAL_TERM + 1);
        assertFalse(vault.canHold(alice));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, alice));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(treasury, 1e6); // treasury is exempt, so only the sender can fail
        vm.prank(alice);
        vault.redeem(100e6, alice, alice);
        assertEq(qUsdc.balanceOf(alice), 100e6);
    }

    function test_aRemovedPqKeyClosesTheGate() public {
        _deposit(alice, 100e6);
        _removePqKey(alice);
        assertFalse(vault.canHold(alice));
        _fund(alice, 10e6);
        vm.startPrank(alice);
        qUsdc.approve(address(vault), 10e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, alice, 10e6, 0));
        vault.deposit(10e6, alice);
        vault.redeem(100e6, alice, alice);
        vm.stopPrank();
        assertEq(qUsdc.balanceOf(alice), 110e6);
    }

    function test_theExemptFeeRecipientReceivesFeeShares() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        skip(1 hours);
        _reportNav(840_000e6);
        assertGt(vault.balanceOf(treasury), 0);
        // And may pass them to an eligible holder.
        uint256 fee = vault.balanceOf(treasury);
        vm.prank(treasury);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(bob, fee);
        assertEq(vault.balanceOf(bob), fee);
    }

    function test_aFeeRecipientThatMayNotHoldBlocksGainReports() public {
        // A configuration error, surfaced loudly: the fee mint is gated like every other.
        _setExempt(treasury, false);
        assertFalse(vault.exempt(treasury));
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        skip(1 hours);
        (uint256 d, bytes memory s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(840_000e6)));
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, treasury));
        vault.reportNav(840_000e6, d, s);
        // A loss mints nothing and goes through.
        _reportNav(790_000e6);
    }

    function test_setExemptNeedsTheAdminsSignature() public {
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(carol, address(vault), admin, "setExempt", abi.encode(carol, true), d);
        vm.expectRevert();
        vault.setExempt(carol, true, d, s);
        _setExempt(carol, true);
        assertTrue(vault.canHold(carol));
        _deposit(carol, 1e6);
    }

    function testFuzz_noShareEverLandsOnANonEligibleAccount(address who, uint256 amount) public {
        vm.assume(who != alice && who != bob && who != treasury && who != address(0));
        amount = bound(amount, 1, 1_000e6);
        _deposit(alice, 1_000e6);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotEligible.selector, who));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(who, amount);
        assertEq(vault.maxDeposit(who), 0);
    }
}
