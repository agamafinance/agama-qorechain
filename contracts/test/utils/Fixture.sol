// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {MockPqc} from "./MockPqc.sol";
import {MockUSDC} from "../../src/mocks/MockUSDC.sol";
import {IBurnMintToken} from "../../src/cctp/AttestedMessenger.sol";
import {PqAttestedMessenger} from "../../src/cctp/PqAttestedMessenger.sol";
import {EcdsaAttestedMessenger} from "../../src/cctp/EcdsaAttestedMessenger.sol";
import {PqcSigned} from "../../src/pqc/PqcSigned.sol";
import {AccessRegistry} from "../../src/qore/AccessRegistry.sol";
import {AgUSD} from "../../src/qore/AgUSD.sol";
import {CrossChainAllocator} from "../../src/qore/CrossChainAllocator.sol";
import {DataRoom} from "../../src/qore/DataRoom.sol";
import {AbfAssetIssuer} from "../../src/l1/AbfAssetIssuer.sol";
import {AgamaL1Receiver} from "../../src/l1/AgamaL1Receiver.sol";
import {ITokenMessengerV2} from "../../src/interfaces/cctp/ITokenMessengerV2.sol";
import {IMessageTransmitterV2} from "../../src/interfaces/cctp/IMessageTransmitterV2.sol";

/// @notice Both legs in one EVM. QoreChain: the PQC precompiles (mocked), the access registry, the data room, agUSD,
///         the allocator and the ML-DSA attested messenger. Ethereum: the ECDSA attested messenger, the issuer and
///         the receiver. Every post-quantum role (admin, reporter, compliance officer, manager, attester) holds a
///         mock ML-DSA key; the test signs for them with `_sign`. Messages are captured from the logs exactly as the
///         relayer captures them from a receipt.
abstract contract Fixture is Test {
    uint32 internal constant QORECHAIN = 9001;
    uint32 internal constant ETHEREUM = 0;
    uint64 internal constant APPROVAL_TERM = 3650 days;

    // forge-lint: disable-next-line(screaming-snake-case-const)
    MockPqc internal constant pqc = MockPqc(address(0x0000000000000000000000000000000000000a02));

    // Post-quantum roles: they exist only as ML-DSA keys.
    address internal admin = makeAddr("admin");
    address internal reporter = makeAddr("reporter");
    address internal officer = makeAddr("officer");
    address internal manager = makeAddr("manager");
    address internal pqAttester = makeAddr("pqAttester");

    // Classical keys.
    address internal deployer = makeAddr("deployer");
    address internal guardian = makeAddr("guardian");
    address internal operator = makeAddr("operator");
    address internal ethAdmin = makeAddr("ethAdmin");
    uint256 internal ecdsaAttesterKey = 0xA77E57;
    address internal ecdsaAttester;

    // Everybody else.
    address internal treasury = makeAddr("treasury");
    address internal custody = makeAddr("custody");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol"); // never onboarded

    mapping(address account => bytes) internal pubkeyOf;
    uint256 private keyCounter;

    // QoreChain
    MockUSDC internal qUsdc;
    PqAttestedMessenger internal qMessenger;
    AccessRegistry internal registry;
    DataRoom internal dataRoom;
    AgUSD internal vault;
    CrossChainAllocator internal allocator;

    // Ethereum
    MockUSDC internal eUsdc;
    EcdsaAttestedMessenger internal eMessenger;
    AbfAssetIssuer internal issuer;
    AgamaL1Receiver internal receiver;

    function defaultConfig() internal view returns (AgUSD.Config memory) {
        return AgUSD.Config({
            depositCap: 10_000_000e6,
            reserveBps: 1_000,
            performanceFeeBps: 1_000,
            maxNavChangeBps: 500,
            minReportInterval: 1 hours,
            profitVestingPeriod: 1 days,
            feeRecipient: treasury
        });
    }

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        vm.etch(address(0x0a01), type(MockPqc).runtimeCode);
        vm.etch(address(0x0a02), type(MockPqc).runtimeCode);
        ecdsaAttester = vm.addr(ecdsaAttesterKey);

        _setPqKey(admin, true);
        _setPqKey(reporter, true);
        _setPqKey(officer, true);
        _setPqKey(manager, true);
        _setPqKey(pqAttester, true);

        vm.startPrank(deployer);
        // QoreChain
        qUsdc = new MockUSDC(deployer);
        qMessenger = new PqAttestedMessenger(QORECHAIN, IBurnMintToken(address(qUsdc)), pqAttester, admin);
        qUsdc.grantRole(qUsdc.MINTER_ROLE(), address(qMessenger));
        qUsdc.grantRole(qUsdc.MINTER_ROLE(), deployer);
        registry = new AccessRegistry(admin, officer);
        dataRoom = new DataRoom(registry, admin, manager);
        vault = new AgUSD(qUsdc, registry, admin, reporter, guardian, defaultConfig());
        allocator = new CrossChainAllocator(
            vault,
            ITokenMessengerV2(address(qMessenger)),
            IMessageTransmitterV2(address(qMessenger)),
            ETHEREUM,
            admin,
            operator
        );

        // Ethereum
        eUsdc = new MockUSDC(deployer);
        eMessenger = new EcdsaAttestedMessenger(ETHEREUM, IBurnMintToken(address(eUsdc)), ecdsaAttester, ethAdmin);
        eUsdc.grantRole(eUsdc.MINTER_ROLE(), address(eMessenger));
        eUsdc.grantRole(eUsdc.MINTER_ROLE(), deployer);
        issuer = new AbfAssetIssuer(eUsdc, ethAdmin, custody, 9_000);
        receiver = new AgamaL1Receiver(
            eUsdc,
            IMessageTransmitterV2(address(eMessenger)),
            ITokenMessengerV2(address(eMessenger)),
            IERC4626(address(issuer)),
            QORECHAIN,
            _b32(address(allocator)),
            ethAdmin
        );
        vm.stopPrank();

        // Ethereum wiring, classical owner.
        vm.startPrank(ethAdmin);
        issuer.setAllowlisted(address(receiver), true);
        eMessenger.setRemote(QORECHAIN, _b32(address(qMessenger)), _b32(address(qUsdc)));
        vm.stopPrank();
        vm.prank(custody);
        eUsdc.approve(address(issuer), type(uint256).max);

        // QoreChain wiring, every step signed by the admin's ML-DSA key and relayed by whoever.
        _setRoles(reporter, guardian, address(allocator));
        _setExempt(treasury, true);
        _setRemoteQore(ETHEREUM, _b32(address(eMessenger)), _b32(address(eUsdc)));
        _setRemoteReceiver(_b32(address(receiver)));

        _onboard(alice);
        _onboard(bob);
    }

    // ------------------------------------------------------------------
    // Post-quantum signing
    // ------------------------------------------------------------------

    function _setPqKey(address account, bool proven) internal {
        bytes memory pk = abi.encodePacked("mldsa87:", keccak256(abi.encode(account, ++keyCounter)));
        pubkeyOf[account] = pk;
        pqc.setKey(account, pk, proven);
    }

    function _removePqKey(address account) internal {
        delete pubkeyOf[account];
        pqc.setKey(account, "", false);
    }

    /// @notice `signer`'s ML-DSA-87 signature over `message`, as the mock precompile verifies it.
    function _sign(address signer, bytes memory message) internal view returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked("ok", pubkeyOf[signer], message)));
    }

    /// @notice `signer` authorises `action(params)` on `target` at its current nonce, valid for an hour.
    function _signed(address target, address signer, bytes32 action, bytes memory params)
        internal
        view
        returns (uint256 deadline, bytes memory signature)
    {
        deadline = vm.getBlockTimestamp() + 1 hours;
        signature = _signedBy(signer, target, signer, action, params, deadline);
    }

    /// @notice `keyHolder` signs the message meant for `signer` (equal to `signer` for an honest signature).
    function _signedBy(
        address keyHolder,
        address target,
        address signer,
        bytes32 action,
        bytes memory params,
        uint256 deadline
    ) internal view returns (bytes memory) {
        PqcSigned t = PqcSigned(target);
        return _sign(keyHolder, t.pqcMessage(signer, action, params, t.pqcNonce(signer), deadline));
    }

    // ---- admin actions on the bridge ----

    function _setRemoteQore(uint32 domain, bytes32 messenger, bytes32 token) internal {
        (uint256 d, bytes memory s) =
            _signed(address(qMessenger), admin, "setRemote", abi.encode(domain, messenger, token));
        qMessenger.setRemote(domain, messenger, token, d, s);
    }

    function _setRemoteReceiver(bytes32 next) internal {
        (uint256 d, bytes memory s) = _signed(address(allocator), admin, "setRemoteReceiver", abi.encode(next));
        allocator.setRemoteReceiver(next, d, s);
    }

    // ---- admin actions on the vault ----

    function _setRoles(address reporter_, address guardian_, address allocator_) internal {
        (uint256 d, bytes memory s) =
            _signed(address(vault), admin, "setRoles", abi.encode(reporter_, guardian_, allocator_));
        vault.setRoles(reporter_, guardian_, allocator_, d, s);
    }

    function _setExempt(address account, bool on) internal {
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "setExempt", abi.encode(account, on));
        vault.setExempt(account, on, d, s);
    }

    function _setConfig(AgUSD.Config memory c) internal {
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "setConfig", abi.encode(c));
        vault.setConfig(c, d, s);
    }

    function _unpause() internal {
        (uint256 d, bytes memory s) = _signed(address(vault), admin, "unpause", "");
        vault.unpause(d, s);
    }

    function _reportNav(uint256 nav) internal {
        (uint256 d, bytes memory s) = _signed(address(vault), reporter, "reportNav", abi.encode(nav));
        vault.reportNav(nav, d, s);
    }

    // ---- onboarding through the access registry ----

    function _mlkemKey() internal pure returns (bytes memory k) {
        k = new bytes(1568);
        k[0] = 0x42;
    }

    function _envelope(uint256 size, uint256 seed) internal pure returns (bytes memory e) {
        e = new bytes(size);
        e[0] = 0x51; // Q
        e[1] = 0x53; // S
        e[2] = 0x45; // E
        e[3] = 0x4c; // L
        bytes32 tag = bytes32(seed);
        if (size > 4) e[size - 1] = tag[31];
        if (size > 5) e[size - 2] = tag[30];
    }

    function _file(address account, uint256 seed) internal returns (bytes32 dossierHash) {
        bytes memory env = _envelope(256, seed);
        vm.prank(account);
        registry.fileDossier(env);
        return keccak256(env);
    }

    function _approveSig(address account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes memory letter)
        internal
        view
        returns (uint256 deadline, bytes memory sig)
    {
        return _signed(
            address(registry),
            officer,
            "approve",
            abi.encode(account, tier, expiresAt, dossierHash, keccak256(letter))
        );
    }

    function _approve(address account, bytes32 dossierHash) internal {
        uint64 expiresAt = uint64(vm.getBlockTimestamp() + APPROVAL_TERM);
        (uint256 d, bytes memory s) = _approveSig(account, 1, expiresAt, dossierHash, "letter");
        registry.approve(account, 1, expiresAt, dossierHash, "letter", d, s);
    }

    /// @notice The full lender flow: ML-DSA key, ML-KEM key, sealed dossier, signed approval.
    function _onboard(address account) internal {
        if (pubkeyOf[account].length == 0) _setPqKey(account, true);
        vm.prank(account);
        registry.publishEncryptionKey(_mlkemKey());
        _approve(account, _file(account, uint160(account)));
    }

    function _revoke(address account) internal {
        (uint256 d, bytes memory s) = _signed(address(registry), officer, "revoke", abi.encode(account));
        registry.revoke(account, d, s);
    }

    // ------------------------------------------------------------------
    // Money and messages
    // ------------------------------------------------------------------

    function _b32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _fund(address who, uint256 amount) internal {
        vm.prank(deployer);
        qUsdc.mint(who, amount);
    }

    function _fundEth(address who, uint256 amount) internal {
        vm.prank(deployer);
        eUsdc.mint(who, amount);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        _fund(who, amount);
        vm.startPrank(who);
        qUsdc.approve(address(vault), amount);
        shares = vault.deposit(amount, who);
        vm.stopPrank();
    }

    /// @notice The Ethereum leg's secp256k1 attestation.
    function _attestEth(bytes memory message) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ecdsaAttesterKey, keccak256(message));
        return abi.encodePacked(r, s, v);
    }

    /// @notice The QoreChain leg's ML-DSA-87 attestation, by the registered attester.
    function _attestQore(bytes memory message) internal view returns (bytes memory) {
        return _sign(pqAttester, qMessenger.attestationMessage(message));
    }

    /// @dev The last MessageSent in the recorded logs, which is what a relayer reads off the receipt.
    function _lastMessage() internal returns (bytes memory message) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256("MessageSent(bytes)");
        for (uint256 i = logs.length; i > 0; i--) {
            if (logs[i - 1].topics[0] == topic) return abi.decode(logs[i - 1].data, (bytes));
        }
        revert("no MessageSent");
    }
}
