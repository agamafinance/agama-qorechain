// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Fixture} from "./utils/Fixture.sol";
import {PqAccount} from "../src/account/PqAccount.sol";
import {PqAccountFactory, IHybridGuardAdmin} from "../src/account/PqAccountFactory.sol";
import {PqcAuth} from "../src/pqc/PqcAuth.sol";

/// @notice A lender who only ever signs messages: its PqAccount, controlled by its ML-DSA-87 key, gets verified,
///         takes test USDC, deposits and exits, while whoever submits the messages can change nothing.
contract PqAccountTest is Fixture {
    PqAccountFactory internal factory;
    address internal dana = makeAddr("dana"); // a QoreX user: an ML-DSA-87 key, nothing else
    address internal relayer = makeAddr("relayer");

    function setUp() public override {
        super.setUp();
        address[] memory targets = new address[](3);
        (targets[0], targets[1], targets[2]) = (address(qUsdc), address(registry), address(vault));
        factory = new PqAccountFactory(admin, IHybridGuardAdmin(address(hybridGuard)), targets);
        vm.prank(admin);
        hybridGuard.transferOwnership(address(factory));
        vm.prank(admin);
        factory.acceptGuardOwnership();
        _setPqKey(dana, true);
    }

    function _call(address target, bytes memory data) internal pure returns (PqAccount.Call[] memory c) {
        c = new PqAccount.Call[](1);
        c[0] = PqAccount.Call(target, data);
    }

    /// @dev What QoreX signs: the prefix, then the text the account rebuilds.
    function _text(address owner, PqAccount.Call[] memory calls, string memory summary, uint256 deadline, uint256 n)
        internal
        view
        returns (bytes memory)
    {
        address acc = factory.accountOf(owner);
        return bytes(
            string.concat(
                "qorechain-msg-v1|qorechain-diana|",
                summary,
                "\n\nAgama account ",
                vm.toLowercase(vm.toString(acc)),
                "\nnonce ",
                vm.toString(n),
                "\nvalid until ",
                vm.toString(deadline),
                "\ncalls ",
                vm.toString(keccak256(abi.encode(calls)))
            )
        );
    }

    function _run(address owner, PqAccount.Call[] memory calls, uint256 n) internal {
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _sign(owner, _text(owner, calls, "Agama", deadline, n));
        vm.prank(relayer);
        factory.execute(owner, calls, "Agama", deadline, sig);
    }

    function test_addressIsKnownBeforeTheAccountExists() public {
        address predicted = factory.accountOf(dana);
        assertEq(predicted.code.length, 0);
        _run(dana, _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ())), 0);
        assertGt(predicted.code.length, 0);
        assertEq(factory.ownerOf(predicted), dana);
        assertEq(qUsdc.balanceOf(predicted), qUsdc.FAUCET_AMOUNT());
        assertTrue(hybridGuard.exempt(predicted));
    }

    function test_fullLenderFlowWithSignaturesOnly() public {
        address acc = factory.accountOf(dana);
        _run(dana, _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ())), 0);
        _run(dana, _call(address(registry), abi.encodeCall(registry.publishEncryptionKey, (_mlkemKey()))), 1);
        bytes memory env = _envelope(3_600, 7);
        _run(dana, _call(address(registry), abi.encodeCall(registry.fileDossier, (env))), 2);
        _approve(acc, keccak256(env));
        assertTrue(registry.isEligible(acc));

        PqAccount.Call[] memory c = new PqAccount.Call[](2);
        c[0] = PqAccount.Call(address(qUsdc), abi.encodeCall(qUsdc.approve, (address(vault), type(uint256).max)));
        c[1] = PqAccount.Call(address(vault), abi.encodeCall(vault.deposit, (2_500e6, acc)));
        _run(dana, c, 3);
        assertGt(vault.balanceOf(acc), 0);

        uint256 shares = vault.balanceOf(acc) / 10;
        _run(dana, _call(address(vault), abi.encodeCall(vault.redeem, (shares, acc, acc))), 4);
        assertGt(qUsdc.balanceOf(acc), 0);
        assertEq(PqAccount(acc).nonce(), 5);
    }

    function test_replayIsRefused() public {
        PqAccount.Call[] memory calls = _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ()));
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _sign(dana, _text(dana, calls, "Agama", deadline, 0));
        factory.execute(dana, calls, "Agama", deadline, sig);
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, dana));
        factory.execute(dana, calls, "Agama", deadline, sig);
    }

    function test_submitterCannotChangeTheCalls() public {
        _run(dana, _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ())), 0);
        address acc = factory.accountOf(dana);
        uint256 deadline = block.timestamp + 300;
        // dana signs a 1 USDC approval; the relayer submits it as an unlimited one
        PqAccount.Call[] memory signed = _call(address(qUsdc), abi.encodeCall(qUsdc.approve, (relayer, 1e6)));
        bytes memory sig = _sign(dana, _text(dana, signed, "Agama", deadline, 1));
        PqAccount.Call[] memory forged = _call(address(qUsdc), abi.encodeCall(qUsdc.approve, (relayer, type(uint256).max)));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, dana));
        PqAccount(acc).execute(forged, "Agama", deadline, sig);
        // nor the summary the owner read
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, dana));
        PqAccount(acc).execute(signed, "Something else", deadline, sig);
    }

    function test_anotherKeyCannotSign() public {
        _setPqKey(carol, true);
        PqAccount.Call[] memory calls = _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ()));
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _sign(carol, _text(dana, calls, "Agama", deadline, 0));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, dana));
        factory.execute(dana, calls, "Agama", deadline, sig);
    }

    function test_expiredMessageIsRefused() public {
        PqAccount.Call[] memory calls = _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ()));
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _sign(dana, _text(dana, calls, "Agama", deadline, 0));
        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(PqAccount.Expired.selector, deadline));
        factory.execute(dana, calls, "Agama", deadline, sig);
    }

    function test_onlyAgamaTargets() public {
        PqAccount.Call[] memory calls = _call(address(qMessenger), "");
        uint256 deadline = block.timestamp + 300;
        bytes memory sig = _sign(dana, _text(dana, calls, "Agama", deadline, 0));
        vm.expectRevert(abi.encodeWithSelector(PqAccount.TargetNotAllowed.selector, address(qMessenger)));
        factory.execute(dana, calls, "Agama", deadline, sig);
    }

    function test_noAccountForAKeylessOwner() public {
        PqAccount.Call[] memory calls = _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ()));
        vm.expectRevert(abi.encodeWithSelector(PqAccountFactory.OwnerNotQuantumSafe.selector, carol));
        factory.execute(carol, calls, "Agama", block.timestamp + 300, "");
        _setPqKey(carol, false); // registered without proof of possession
        vm.expectRevert(abi.encodeWithSelector(PqAccountFactory.OwnerNotQuantumSafe.selector, carol));
        factory.create(carol);
    }

    function test_rotatedKeyIsPickedUp() public {
        _run(dana, _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ())), 0);
        bytes memory oldKey = pubkeyOf[dana];
        _setPqKey(dana, true); // dana rotates its ML-DSA-87 key on QoreChain
        PqAccount.Call[] memory calls = _call(address(qUsdc), abi.encodeCall(qUsdc.faucet, ()));
        uint256 deadline = block.timestamp + 300;
        bytes memory msg_ = _text(dana, calls, "Agama", deadline, 1);
        bytes memory stale = abi.encodePacked(keccak256(abi.encodePacked("ok", oldKey, msg_)));
        vm.expectRevert(abi.encodeWithSelector(PqcAuth.BadPqcSignature.selector, dana));
        factory.execute(dana, calls, "Agama", deadline, stale);
        _run(dana, calls, 1);
    }

    function test_adminOnly() public {
        vm.expectRevert(PqAccountFactory.NotAdmin.selector);
        factory.setTarget(address(qMessenger), true);
        vm.expectRevert(PqAccountFactory.NotAdmin.selector);
        factory.setExempt(carol, true, "no");
    }
}
