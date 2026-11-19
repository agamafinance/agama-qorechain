// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MockUSDC} from "../src/mocks/MockUSDC.sol";
import {FestUsdOnRamp, IMintBurnUsdc} from "../src/qore/FestUsdOnRamp.sol";

contract FakeFusd is ERC20 {
    constructor() ERC20("Fest USD", "fUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FestUsdOnRampTest is Test {
    FakeFusd internal fusd = new FakeFusd();
    MockUSDC internal usdc = new MockUSDC(address(this));
    FestUsdOnRamp internal ramp;
    address internal lender = makeAddr("fest-lender");

    function setUp() public {
        ramp = new FestUsdOnRamp(fusd, IMintBurnUsdc(address(usdc)));
        usdc.grantRole(usdc.MINTER_ROLE(), address(ramp));
        fusd.mint(lender, 1_000e6);
    }

    function test_roundTripIsOneToOne() public {
        vm.startPrank(lender);
        fusd.approve(address(ramp), 400e6);
        ramp.onRamp(400e6);
        assertEq(usdc.balanceOf(lender), 400e6);
        assertEq(fusd.balanceOf(address(ramp)), 400e6);

        usdc.approve(address(ramp), 150e6);
        ramp.offRamp(150e6);
        assertEq(usdc.balanceOf(lender), 250e6);
        assertEq(fusd.balanceOf(lender), 750e6);
        assertEq(fusd.balanceOf(address(ramp)), 250e6);
        vm.stopPrank();
    }

    function test_cannotTakeOutMoreFusdThanCameIn() public {
        usdc.grantRole(usdc.MINTER_ROLE(), address(this));
        usdc.mint(lender, 100e6); // mock USDC from the faucet, not from the ramp
        vm.startPrank(lender);
        usdc.approve(address(ramp), 100e6);
        vm.expectRevert();
        ramp.offRamp(100e6);
        vm.stopPrank();
    }

    function test_offRampNeedsAnAllowance() public {
        vm.startPrank(lender);
        fusd.approve(address(ramp), 10e6);
        ramp.onRamp(10e6);
        vm.expectRevert();
        ramp.offRamp(10e6);
        vm.stopPrank();
    }

    function test_zeroIsRefused() public {
        vm.expectRevert(FestUsdOnRamp.ZeroAmount.selector);
        ramp.onRamp(0);
        vm.expectRevert(FestUsdOnRamp.ZeroAmount.selector);
        ramp.offRamp(0);
    }

    function testFuzz_onRampMintsExactly(uint96 amount) public {
        amount = uint96(bound(amount, 1, 1_000e6));
        vm.startPrank(lender);
        fusd.approve(address(ramp), amount);
        ramp.onRamp(amount);
        vm.stopPrank();
        assertEq(usdc.balanceOf(lender), amount);
        assertEq(usdc.totalSupply(), fusd.balanceOf(address(ramp)));
    }
}
