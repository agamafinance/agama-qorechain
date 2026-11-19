// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {AgamaComplianceModule} from "../src/qore/AgamaComplianceModule.sol";

contract AgamaComplianceModuleTest is Fixture {
    AgamaComplianceModule internal module;
    address internal compliance = makeAddr("trex-compliance");
    address internal stranger = makeAddr("module-stranger");

    function setUp() public override {
        super.setUp();
        module = new AgamaComplianceModule(registry);
        _onboard(alice);
        _onboard(bob);
    }

    function test_onlyApprovedLendersPassTheCheck() public view {
        assertTrue(module.moduleCheck(alice, bob, 1, compliance));
        assertTrue(module.moduleCheck(address(0), alice, 1, compliance), "mint to an approved lender");
        assertFalse(module.moduleCheck(alice, stranger, 1, compliance), "transfer to a stranger");
        assertFalse(module.moduleCheck(stranger, alice, 1, compliance), "transfer from a stranger");
        assertFalse(module.moduleCheck(address(0), stranger, 1, compliance), "mint to a stranger");
    }

    function test_burnsAreNeverBlocked() public {
        _revoke(alice);
        assertTrue(module.moduleCheck(alice, address(0), 1, compliance));
        assertFalse(module.moduleCheck(alice, bob, 1, compliance), "a revoked lender cannot transfer");
    }

    function test_onlyTheComplianceBindsItself() public {
        vm.expectRevert(AgamaComplianceModule.OnlyComplianceCanBind.selector);
        module.bindCompliance(compliance);
        vm.prank(compliance);
        module.bindCompliance(compliance);
        assertTrue(module.isComplianceBound(compliance));
        vm.prank(compliance);
        vm.expectRevert(AgamaComplianceModule.ComplianceAlreadyBound.selector);
        module.bindCompliance(compliance);
    }

    function test_actionsNeedABoundCompliance() public {
        vm.prank(compliance);
        vm.expectRevert(AgamaComplianceModule.ComplianceNotBound.selector);
        module.moduleTransferAction(alice, bob, 1);
        vm.prank(compliance);
        module.bindCompliance(compliance);
        vm.prank(compliance);
        module.moduleTransferAction(alice, bob, 1);
        vm.prank(compliance);
        module.unbindCompliance(compliance);
        assertFalse(module.isComplianceBound(compliance));
    }

    function test_plugAndPlay() public view {
        assertTrue(module.isPlugAndPlay());
        assertTrue(module.canComplianceBind(compliance));
        assertEq(module.name(), "AgamaComplianceModule");
    }
}
