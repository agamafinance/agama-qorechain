// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AgUSD} from "../src/qore/AgUSD.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @notice agUSD's accounting on its own. The allocator is a plain account here, so every number is the vault's
///         arithmetic and nobody else's; NAV reports and governance go through ML-DSA signatures.
contract AgUSDTest is Fixture {
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

    function _return(uint256 amount) internal {
        vm.prank(strategist);
        vault.returnFromStrategy(amount);
    }

    function _report(uint256 nav) internal {
        skip(1 hours);
        _reportNav(nav);
    }

    // ---- the basics ----

    function test_metadata() public view {
        assertEq(vault.name(), "Agama USD");
        assertEq(vault.symbol(), "agUSD");
        assertEq(vault.decimals(), 6);
        assertEq(vault.asset(), address(qUsdc));
        assertEq(address(vault.access()), address(registry));
        assertEq(vault.admin(), admin);
        assertEq(vault.reporter(), reporter);
        assertEq(vault.guardian(), guardian);
        assertEq(vault.allocator(), strategist);
    }

    function test_firstDepositIsOneForOne() public {
        assertEq(_deposit(alice, 1_000e6), 1_000e6);
        assertEq(vault.sharePrice(), 1e6);
    }

    function test_depositCapIsReportedAndEnforced() public {
        _deposit(alice, 9_999_000e6);
        assertEq(vault.maxDeposit(bob), 1_000e6);
        _fund(bob, 1_001e6);
        vm.startPrank(bob);
        qUsdc.approve(address(vault), 1_001e6);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxDeposit.selector, bob, 1_001e6, 1_000e6));
        vault.deposit(1_001e6, bob);
        vault.deposit(1_000e6, bob);
        vm.stopPrank();
        assertEq(vault.maxDeposit(bob), 0);
        assertEq(vault.maxMint(bob), 0);
    }

    function test_snapshotReadsEverythingInOneCall() public {
        _deposit(alice, 1_000e6);
        _push(800e6);
        AgUSD.Snapshot memory s = vault.snapshot();
        assertEq(s.totalAssets, 1_000e6);
        assertEq(s.totalSupply, 1_000e6);
        assertEq(s.sharePrice, 1e6);
        assertEq(s.idle, 200e6);
        assertEq(s.deployed, 800e6);
        assertEq(s.pending, 0);
        assertEq(s.liquid, 200e6);
        assertEq(s.depositCap, 10_000_000e6);
        assertEq(s.reserveBps, 1_000);
        assertEq(s.queueLength, 0);
        assertFalse(s.paused);
    }

    // ---- the buffer ----

    function test_maxWithdrawIsTheBufferNotTheBalance() public {
        _deposit(alice, 1_000e6);
        _push(800e6);
        assertEq(vault.maxWithdraw(alice), 200e6);
        assertEq(vault.maxRedeem(alice), 200e6);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, alice, 201e6, 200e6));
        vault.withdraw(201e6, alice, alice);

        vm.prank(alice);
        vault.withdraw(200e6, alice, alice);
        assertEq(qUsdc.balanceOf(alice), 200e6);
    }

    function test_theAllocatorCannotSpendThroughTheReserveFloor() public {
        _deposit(alice, 1_000e6);
        vm.prank(strategist);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.ReserveFloor.selector, 99e6, 100e6));
        vault.pushToStrategy(901e6);
        _push(900e6);
        assertEq(vault.deployedAssets(), 900e6);
        assertEq(qUsdc.balanceOf(strategist), 900e6);
    }

    function test_theAllocatorCannotTakeMoreThanIsLiquid() public {
        _deposit(alice, 1_000e6);
        vm.prank(strategist);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.InsufficientLiquidity.selector, 1_001e6, 1_000e6));
        vault.pushToStrategy(1_001e6);
        vm.prank(strategist);
        vm.expectRevert(AgUSD.ZeroAmount.selector);
        vault.pushToStrategy(0);
    }

    function test_onlyTheAllocatorMovesCapital() public {
        _deposit(alice, 1_000e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotAllocator.selector, bob));
        vault.pushToStrategy(1e6);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotAllocator.selector, bob));
        vault.returnFromStrategy(1e6);
    }

    // ---- the queue ----

    function test_aLargeExitQueuesAtTodaysPriceAndIsPaidWhenCashComesHome() public {
        _deposit(alice, 1_000e6);
        _push(900e6);

        vm.prank(alice);
        uint256 id = vault.requestRedeem(500e6, alice, alice);
        assertEq(vault.balanceOf(alice), 500e6, "shares burned at request");
        assertEq(vault.pendingRedemptions(), 500e6);
        assertEq(qUsdc.balanceOf(alice), 0, "not enough cash to pay yet");
        assertEq(vault.totalAssets(), 500e6);
        assertEq(vault.sharePrice(), 1e6, "leaving does not move the price for those who stay");
        (address owner_, address receiver_, uint64 at, uint128 assets_) = vault.redemptions(id);
        assertEq(owner_, alice);
        assertEq(receiver_, alice);
        assertEq(at, vm.getBlockTimestamp());
        assertEq(assets_, 500e6);
        assertEq(vault.requestsOf(alice).length, 1);
        assertEq(vault.requestsOf(alice)[0], id);

        // Instant exits can no longer reach the cash the queue is owed.
        assertEq(vault.maxWithdraw(alice), 0);

        _return(400e6);
        assertEq(qUsdc.balanceOf(alice), 500e6, "settled by the return itself");
        assertEq(vault.pendingRedemptions(), 0);
        (, address cleared,,) = vault.redemptions(id);
        assertEq(cleared, address(0), "cleared");
    }

    function test_theQueueIsFirstInFirstOut() public {
        _deposit(alice, 1_000e6);
        _deposit(bob, 1_000e6);
        _push(1_800e6);
        vm.prank(alice);
        vault.requestRedeem(300e6, alice, alice);
        vm.prank(bob);
        vault.requestRedeem(300e6, bob, bob);
        assertEq(qUsdc.balanceOf(alice), 0);
        assertEq(vault.snapshot().queueLength, 2);

        _return(150e6); // 350 idle: alice's 300 fits, bob's does not
        assertEq(qUsdc.balanceOf(alice), 300e6);
        assertEq(qUsdc.balanceOf(bob), 0);
        assertEq(vault.nextToSettle(), 1);

        _return(300e6);
        assertEq(qUsdc.balanceOf(bob), 300e6);
        assertEq(vault.nextToSettle(), 2);
    }

    function test_theHeadOfTheQueueBlocksSmallerLaterRequests() public {
        // Fairness: a later, smaller request is never paid ahead of an earlier, larger one.
        _deposit(alice, 1_000e6);
        _deposit(bob, 1_000e6);
        _push(1_800e6);
        vm.prank(alice);
        vault.requestRedeem(500e6, alice, alice);
        vm.prank(bob);
        vault.requestRedeem(50e6, bob, bob);
        _return(100e6); // 300 idle: bob's 50 would fit, alice's 500 does not
        assertEq(qUsdc.balanceOf(bob), 0, "no skipping the line");
        assertEq(vault.nextToSettle(), 0);
    }

    function test_anyoneCanSettleTheQueueAndItIsBounded() public {
        _deposit(alice, 1_000e6);
        _push(900e6);
        for (uint256 i; i < 3; ++i) {
            vm.prank(alice);
            vault.requestRedeem(200e6, alice, alice);
        }
        vm.prank(strategist);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        qUsdc.transfer(address(vault), 600e6); // cash arrives without a return call
        vm.prank(carol);
        assertEq(vault.settleRedemptions(2), 2);
        assertEq(qUsdc.balanceOf(alice), 400e6);
        vm.prank(carol);
        assertEq(vault.settleRedemptions(10), 1);
        assertEq(vault.pendingRedemptions(), 0);
        assertEq(vault.requestsOf(alice).length, 3);
    }

    function test_requestRedeemOnBehalfSpendsTheAllowance() public {
        _deposit(alice, 100e6);
        vm.prank(bob);
        vm.expectRevert();
        vault.requestRedeem(10e6, bob, alice);

        vm.prank(alice);
        vault.approve(bob, 10e6);
        vm.prank(bob);
        vault.requestRedeem(10e6, bob, alice);
        assertEq(qUsdc.balanceOf(bob), 10e6);
        assertEq(vault.allowance(alice, bob), 0);
    }

    function test_requestRedeemRefusesZero() public {
        _deposit(alice, 100e6);
        vm.prank(alice);
        vm.expectRevert(AgUSD.ZeroAmount.selector);
        vault.requestRedeem(0, alice, alice);
    }

    // ---- NAV ----

    function test_aGainUnlocksLinearlyAndIsNotSandwichable() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        uint256 p0 = vault.sharePrice();

        _report(840_000e6); // +40k, 5% of deployed
        assertApproxEqAbs(vault.sharePrice(), p0, 1, "the report's own block sees nothing");

        skip(12 hours);
        uint256 mid = vault.sharePrice();
        assertGt(mid, p0);
        skip(12 hours);
        uint256 full = vault.sharePrice();
        assertApproxEqAbs(full - p0, (mid - p0) * 2, 2, "linear");
        // 40k gain, 4k fee to treasury in shares, 36k to holders: alice's 1M shares are worth 1.036M.
        assertApproxEqRel(vault.convertToAssets(vault.balanceOf(alice)), 1_036_000e6, 1e12);
        assertApproxEqRel(
            vault.convertToAssets(vault.balanceOf(treasury)), 4_000e6, 1e12, "exactly the fee, once vested"
        );
        assertEq(vault.unvestedProfit(), 0);
    }

    function test_aLossEatsUnvestedProfitFirst() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(840_000e6);
        skip(1 hours);
        uint256 pBefore = vault.sharePrice();
        _reportNav(820_000e6); // -20k, absorbed by the ~34.5k still locked
        assertApproxEqAbs(vault.sharePrice(), pBefore, 1, "the holders' price does not move");
        assertGt(vault.unvestedProfit(), 14_000e6);
    }

    function test_aLossBeyondTheLockReachesThePrice() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(760_000e6); // -40k, nothing locked to absorb it
        assertEq(vault.totalAssets(), 960_000e6);
        assertEq(vault.sharePrice(), 960_000);
        assertEq(vault.balanceOf(treasury), 0, "no fee on a loss");
    }

    /// @dev Regression: a loss that leaves the queue owed more than the vault holds used to brick every later gain
    ///      (`vested - fee` underflowed in `_recognizeGain`), so the book's recovery could never be recognized.
    function test_aGainAfterTheQueueWentUnderwaterIsRecognized() public {
        _deposit(alice, 1_000e6);
        _push(900e6);
        vm.prank(alice);
        vault.requestRedeem(999e6, alice, alice); // 100 idle: queued, owed 999
        _report(855e6); // -5%: 955 left against 999 owed, the holders' claim is zero
        assertEq(vault.totalAssets(), 0);

        _report(880e6); // +25, all of it refills the queue's shortfall: no profit, no fee
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.unvestedProfit(), 0);

        _report(920e6); // +40: 19 refill the shortfall, 21 reach the holders
        uint256 gross = qUsdc.balanceOf(address(vault)) + vault.deployedAssets();
        uint256 pending = vault.pendingRedemptions();
        assertEq(gross - pending, 21e6);
        assertLe(vault.unvestedProfit(), gross - pending, "the lock never reaches into the queue's money");
        assertGt(vault.balanceOf(treasury), 0, "the fee is charged on the 21 only");
        skip(1 days);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(treasury)), 2.1e6, 10, "1 share outstanding: a few units of rounding");

        // Cash above the book while the queue is short goes the same way, and pays the queue.
        _fund(strategist, 200e6);
        _return(1_100e6);
        assertEq(qUsdc.balanceOf(alice), 999e6);
        assertEq(vault.pendingRedemptions(), 0);
    }

    function test_reportGuards() public {
        _deposit(alice, 1_000_000e6);

        (uint256 d, bytes memory s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(1)));
        vm.expectRevert(AgUSD.NothingDeployed.selector);
        vault.reportNav(1, d, s);

        _push(800_000e6);
        skip(1 hours);
        // 501 bps on 800k. The guard reads whole basis points, so a move has to clear the bound by one to trip it.
        (d, s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(840_080e6)));
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NavChangeTooLarge.selector, 800_000e6, 840_080e6));
        vault.reportNav(840_080e6, d, s);

        _reportNav(810_000e6);
        (d, s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(811_000e6)));
        vm.expectRevert(abi.encodeWithSelector(AgUSD.ReportTooSoon.selector, vm.getBlockTimestamp() + 1 hours));
        vault.reportNav(811_000e6, d, s);
    }

    function test_aZeroReportWithNothingDeployedIsAccepted() public {
        _deposit(alice, 1_000e6);
        _reportNav(0);
        assertEq(vault.lastReport(), vm.getBlockTimestamp());
        assertEq(vault.sharePrice(), 1e6);
    }

    function test_onlyTheReportersKeyReports() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        skip(1 hours);
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        // The admin's key, over the reporter's message: not the reporter.
        bytes memory s = _signedBy(admin, address(vault), reporter, "reportNav", abi.encode(uint256(810_000e6)), d);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, reporter));
        vault.reportNav(810_000e6, d, s);
    }

    function test_aReportCanBeRelayedByAnyone() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        skip(1 hours);
        (uint256 d, bytes memory s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(810_000e6)));
        vm.prank(carol);
        vault.reportNav(810_000e6, d, s);
        assertEq(vault.deployedAssets(), 810_000e6);
        assertEq(vault.pqcNonce(reporter), 1);
    }

    function test_cashBeyondTheBookIsRecognizedNotDumpedInThePrice() public {
        _deposit(alice, 1_000e6);
        _push(800e6);
        _fund(strategist, 100e6);
        uint256 p0 = vault.sharePrice();
        _return(900e6);
        assertEq(vault.deployedAssets(), 0);
        assertApproxEqAbs(vault.sharePrice(), p0, 1, "unreported profit vests like reported profit");
        assertGt(vault.balanceOf(treasury), 0, "and pays the fee like reported profit");
        skip(1 days);
        assertGt(vault.sharePrice(), p0);
    }

    function test_noFeeWhenTheFeeIsZero() public {
        AgUSD.Config memory c = defaultConfig();
        c.performanceFeeBps = 0;
        _setConfig(c);
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(840_000e6);
        assertEq(vault.balanceOf(treasury), 0);
        assertEq(vault.unvestedProfit(), 40_000e6);
        skip(1 days);
        assertApproxEqAbs(vault.totalAssets(), 1_040_000e6, 1);
    }

    function test_noVestingPeriodRecognizesAtOnce() public {
        AgUSD.Config memory c = defaultConfig();
        c.profitVestingPeriod = 0;
        _setConfig(c);
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(840_000e6);
        assertEq(vault.unvestedProfit(), 0);
        assertApproxEqRel(vault.convertToAssets(vault.balanceOf(alice)), 1_036_000e6, 1e12);
    }

    function test_changingTheVestingPeriodDoesNotMoveThePriceInItsBlock() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(840_000e6);
        skip(6 hours);
        uint256 p = vault.sharePrice();
        uint256 locked = vault.unvestedProfit();
        AgUSD.Config memory c = defaultConfig();
        c.profitVestingPeriod = 2 days;
        _setConfig(c);
        assertEq(vault.sharePrice(), p);
        assertEq(vault.unvestedProfit(), locked);
        assertEq(vault.lockedAt(), vm.getBlockTimestamp());
    }

    // ---- governance ----

    function test_pauseClosesEveryDoorAndTheLimitsSayZero() public {
        _deposit(alice, 100e6);
        vm.prank(guardian);
        vault.pause();
        assertEq(vault.maxDeposit(alice), 0);
        assertEq(vault.maxMint(alice), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        assertTrue(vault.snapshot().paused);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.requestRedeem(1e6, alice, alice);
        vm.prank(strategist);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.pushToStrategy(1e6);

        _unpause();
        vm.prank(alice);
        vault.redeem(100e6, alice, alice);
    }

    function test_onlyTheGuardianPausesAndOnlyTheAdminUnpauses() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(AgUSD.NotGuardian.selector, admin));
        vault.pause();

        vm.prank(guardian);
        vault.pause();
        // The guardian can sign only with what it has, and it has no say over the admin's message.
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        bytes memory s = _signedBy(guardian, address(vault), admin, "unpause", "", d);
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.unpause(d, s);
        assertTrue(vault.paused());
    }

    function test_theGuardiansGarbageSignatureCannotUnpause() public {
        vm.prank(guardian);
        vault.pause();
        uint256 d = vm.getBlockTimestamp() + 1 hours;
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, admin));
        vault.unpause(d, hex"deadbeef");
        assertTrue(vault.paused());
    }

    function test_configBounds() public {
        AgUSD.Config memory c = defaultConfig();
        c.performanceFeeBps = 3_001;
        _expectInvalidConfig(c);

        c = defaultConfig();
        c.feeRecipient = address(0);
        _expectInvalidConfig(c);

        c = defaultConfig();
        c.profitVestingPeriod = 31 days;
        _expectInvalidConfig(c);

        c = defaultConfig();
        c.reserveBps = 10_001;
        _expectInvalidConfig(c);

        c = defaultConfig();
        c.maxNavChangeBps = 0;
        _expectInvalidConfig(c);

        c = defaultConfig();
        c.depositCap = 5e6;
        _setConfig(c);
        (uint256 cap,,,,,,) = vault.config();
        assertEq(cap, 5e6);
    }

    function _expectInvalidConfig(AgUSD.Config memory c) private {
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "setConfig", abi.encode(c));
        vm.expectRevert(AgUSD.InvalidConfig.selector);
        vault.setConfig(c, d, s);
    }

    function test_anUncappedVaultSaysSo() public {
        AgUSD.Config memory c = defaultConfig();
        c.depositCap = type(uint256).max;
        _setConfig(c);
        assertEq(vault.maxDeposit(alice), type(uint256).max);
        assertEq(vault.maxMint(alice), type(uint256).max);
    }

    function test_setRolesRefusesAZeroReporter() public {
        (uint256 d, bytes memory s) =
            _signed(address(vault), admin, "setRoles", abi.encode(address(0), guardian, strategist));
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("ZeroAddress()"))));
        vault.setRoles(address(0), guardian, strategist, d, s);
    }

    function test_aNewReporterTakesOverTheNav() public {
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _setRoles(officer, guardian, strategist);
        skip(1 hours);
        (uint256 d, bytes memory s) = _signed(address(vault), reporter, "reportNav", abi.encode(uint256(810_000e6)));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, officer));
        vault.reportNav(810_000e6, d, s);
        (d, s) = _signed(address(vault), officer, "reportNav", abi.encode(uint256(810_000e6)));
        vault.reportNav(810_000e6, d, s);
        assertEq(vault.deployedAssets(), 810_000e6);
    }

    // ---- fuzz ----

    function testFuzz_depositThenRedeemNeverPaysMoreThanItTook(uint256 a, uint256 b) public {
        a = bound(a, 1, 1_000_000e6);
        b = bound(b, 1, 1_000_000e6);
        _deposit(alice, a);
        uint256 shares = _deposit(bob, b);
        vm.prank(bob);
        uint256 out = vault.redeem(shares, bob, bob);
        assertLe(out, b);
    }

    function testFuzz_previewsMatchTheirActions(uint256 amount, uint256 gainBps) public {
        amount = bound(amount, 1e6, 1_000_000e6);
        gainBps = bound(gainBps, 0, 500);
        _deposit(alice, 1_000_000e6);
        _push(800_000e6);
        _report(800_000e6 + 800_000e6 * gainBps / 10_000);
        skip(6 hours);

        _fund(bob, amount);
        vm.startPrank(bob);
        qUsdc.approve(address(vault), amount);
        uint256 preview = vault.previewDeposit(amount);
        uint256 got = vault.deposit(amount, bob);
        assertEq(got, preview);
        uint256 previewOut = vault.previewRedeem(got);
        uint256 out = vault.redeem(got, bob, bob);
        vm.stopPrank();
        assertEq(out, previewOut);
        assertLe(out, amount, "no round trip profit inside one block");
    }

    function testFuzz_feeSharesAreWorthTheFeeOnceVested(uint256 deposit, uint256 gainBps) public {
        deposit = bound(deposit, 10e6, 5_000_000e6);
        gainBps = bound(gainBps, 1, 500);
        _deposit(alice, deposit);
        uint256 deployed = deposit * 8 / 10;
        _push(deployed);
        uint256 gain = deployed * gainBps / 10_000;
        _report(deployed + gain);
        skip(1 days);
        uint256 fee = gain / 10;
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(treasury)), fee, 2);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), deposit + gain - fee, 2);
    }
}
