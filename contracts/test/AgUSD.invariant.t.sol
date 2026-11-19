// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Fixture} from "./utils/Fixture.sol";
import {AgUSD} from "../src/qore/AgUSD.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";

/// @dev Drives the vault through every door at random: deposits, instant exits, queued exits, transfers,
///      allocations, returns, ML-DSA signed NAV reports up and down, and time. The handler is the vault's allocator.
contract Handler is Test {
    AgUSD internal vault;
    MockUSDC internal usdc;
    address internal reporter;
    bytes internal reporterKey;
    address[3] internal actors;

    uint256 public queuedSum;
    uint256 public paidSum;

    constructor(AgUSD v, MockUSDC u, address reporter_, bytes memory reporterKey_, address[3] memory actors_) {
        vault = v;
        usdc = u;
        reporter = reporter_;
        reporterKey = reporterKey_;
        actors = actors_;
        usdc.approve(address(vault), type(uint256).max);
    }

    function deposit(uint256 who, uint256 amount) external {
        address a = actors[who % 3];
        amount = bound(amount, 1e6, 100_000e6);
        if (amount > vault.maxDeposit(a)) return;
        usdc.mint(a, amount);
        vm.startPrank(a);
        usdc.approve(address(vault), amount);
        vault.deposit(amount, a);
        vm.stopPrank();
    }

    function redeem(uint256 who, uint256 shares) external {
        address a = actors[who % 3];
        uint256 max = vault.maxRedeem(a);
        if (max == 0) return;
        shares = bound(shares, 1, max);
        if (vault.previewRedeem(shares) == 0) return;
        vm.prank(a);
        vault.redeem(shares, a, a);
    }

    function transfer(uint256 from, uint256 to, uint256 shares) external {
        address a = actors[from % 3];
        address b = actors[to % 3];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        vm.prank(a);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        vault.transfer(b, shares);
    }

    function requestRedeem(uint256 who, uint256 shares) external {
        address a = actors[who % 3];
        uint256 bal = vault.balanceOf(a);
        if (bal == 0) return;
        shares = bound(shares, 1, bal);
        uint256 assets = vault.previewRedeem(shares);
        if (assets == 0) return;
        // The request settles the head of the queue, which may be somebody else's.
        uint256[3] memory before = _balances();
        vm.prank(a);
        vault.requestRedeem(shares, a, a);
        queuedSum += assets;
        _addPaid(before);
    }

    function allocate(uint256 amount) external {
        uint256 liquid = vault.liquidAssets();
        uint256 floor = vault.totalAssets() * 1_000 / 10_000 + 1;
        if (liquid <= floor) return;
        amount = bound(amount, 1, liquid - floor);
        vault.pushToStrategy(amount);
    }

    function giveBack(uint256 amount, uint256 profitBps) external {
        uint256 deployed = vault.deployedAssets();
        if (deployed == 0) return;
        amount = bound(amount, 1, deployed);
        uint256 withProfit = amount + amount * bound(profitBps, 0, 200) / 10_000;
        uint256 have = usdc.balanceOf(address(this));
        if (withProfit > have) usdc.mint(address(this), withProfit - have);
        uint256[3] memory before = _balances();
        vault.returnFromStrategy(withProfit);
        _addPaid(before);
    }

    function report(uint256 moveBps, bool up) external {
        uint256 deployed = vault.deployedAssets();
        if (deployed == 0) return;
        skip(1 hours);
        uint256 delta = deployed * bound(moveBps, 0, 500) / 10_000;
        uint256 nav = up ? deployed + delta : deployed - delta;
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes memory message =
            vault.pqcMessage(reporter, "reportNav", abi.encode(nav), vault.pqcNonce(reporter), deadline);
        bytes memory sig = abi.encodePacked(keccak256(abi.encodePacked("ok", reporterKey, message)));
        vault.reportNav(nav, deadline, sig);
    }

    function wait(uint256 secs) external {
        skip(bound(secs, 1, 2 days));
    }

    function _balances() private view returns (uint256[3] memory b) {
        for (uint256 i; i < 3; i++) {
            b[i] = usdc.balanceOf(actors[i]);
        }
    }

    function _addPaid(uint256[3] memory before) private {
        for (uint256 i; i < 3; i++) {
            paidSum += usdc.balanceOf(actors[i]) - before[i];
        }
    }
}

contract AgUSDInvariantTest is Fixture {
    Handler internal handler;
    address internal dave = makeAddr("dave");

    function setUp() public override {
        super.setUp();
        _onboard(dave);
        handler = new Handler(vault, qUsdc, reporter, pubkeyOf[reporter], [alice, bob, dave]);
        vm.startPrank(deployer);
        qUsdc.grantRole(qUsdc.MINTER_ROLE(), address(handler));
        vm.stopPrank();
        _setRoles(reporter, guardian, address(handler));
        targetContract(address(handler));
    }

    /// @dev The queue is owed exactly what was queued and not yet paid.
    function invariant_pendingIsWhatTheQueueIsOwed() public view {
        assertEq(vault.pendingRedemptions(), handler.queuedSum() - handler.paidSum());
    }

    /// @dev What the holders own never exceeds what the vault has, net of what it owes.
    function invariant_sharesAreBacked() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets() + 1);
    }

    /// @dev Instant exits can never reach the queue's cash.
    function invariant_liquidNeverIncludesThePending() public view {
        uint256 idle = qUsdc.balanceOf(address(vault));
        uint256 pending = vault.pendingRedemptions();
        assertEq(vault.liquidAssets(), idle > pending ? idle - pending : 0);
        assertLe(vault.maxWithdraw(alice), vault.liquidAssets());
    }

    /// @dev The queue is senior. Locked profit is a slice of what is left after it, and if a loss ever leaves
    ///      less than the queue is owed, the holders' claim reads zero rather than negative.
    function invariant_theQueueIsSenior() public view {
        uint256 gross = qUsdc.balanceOf(address(vault)) + vault.deployedAssets();
        uint256 pending = vault.pendingRedemptions();
        if (gross >= pending) assertLe(vault.unvestedProfit(), gross - pending);
        else assertEq(vault.totalAssets(), 0);
    }

    /// @dev Shares only ever sit with approved lenders or the exempt fee recipient.
    function invariant_onlyPermittedAccountsHoldShares() public view {
        uint256 sum = vault.balanceOf(alice) + vault.balanceOf(bob) + vault.balanceOf(dave)
            + vault.balanceOf(treasury);
        assertEq(sum, vault.totalSupply());
    }

    /// @dev The queue's cursor never passes its end, and settled entries are cleared.
    function invariant_theQueueCursorIsSane() public view {
        uint256 next = vault.nextToSettle();
        assertLe(next, vault.nextRedemptionId());
        if (next > 0) {
            (address owner_,,,) = vault.redemptions(next - 1);
            assertEq(owner_, address(0));
        }
    }
}
