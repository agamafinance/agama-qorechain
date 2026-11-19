// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IHolderEligibility} from "@qorechain/asset-kit/interfaces/IHolderEligibility.sol";
import {PqcGoverned} from "../pqc/PqcGoverned.sol";

/// @title AccessRegistry
/// @notice Who may hold agUSD, decided without putting anybody's identity on chain.
/// @dev The flow, every step of it post-quantum:
///
///        1. The lender publishes an ML-KEM-1024 encryption key, bound to an account that already proved its
///           ML-DSA-87 key to QoreChain. The publishing transaction is itself hybrid-signed (secp256k1 + ML-DSA-87).
///        2. The lender files a dossier: a QoreSeal envelope (ML-KEM-1024 + AES-256-GCM) sealed in the browser to
///           the compliance officer and the auditor. The chain stores ciphertext and nothing else.
///        3. The compliance officer opens it off chain, decides, and signs the decision with ML-DSA-87. The decision
///           names the hash of the exact dossier it read, so a dossier replaced afterwards is not approved, and it
///           carries a decision letter sealed to the lender and the auditor, which the lender opens in the browser.
///        4. `isEligible` is what the vault reads: an approval that has not expired, held by an account that is
///           still quantum safe. Approvals, rejections and revocations exist only as signatures `pqcVerify` checked.
///
///      "Quantum safe" is the Asset Kit's definition, not ours: QoreChain's `QoreChainHybridHolderGuard` reads the
///      pqcKeyStatus precompile with a strict decoder and fails closed, and this registry is itself an Asset Kit
///      `IHolderEligibility` policy, the interface its ERC-3643 module, CMTAT rule and vaults consume.
///
///      What stays public, by design of QoreSeal: who applied, when, the size of the envelope and the outcome.
contract AccessRegistry is PqcGoverned, IHolderEligibility {
    /// @notice FIPS 203 ML-KEM-1024 encapsulation key size.
    uint256 public constant MLKEM_1024_PUBLIC_KEY = 1568;
    /// @notice A dossier is a few hundred bytes of JSON sealed to a handful of readers; this bounds what one
    ///         account can make the chain store.
    uint256 public constant MAX_ENVELOPE = 16_384;
    /// @notice "QSEL", the QoreSeal envelope magic.
    bytes4 public constant QSEL = 0x5153454c;

    enum Status {
        None,
        Pending,
        Approved,
        Rejected,
        Revoked
    }

    struct Member {
        Status status;
        uint8 tier;
        uint64 filedAt;
        uint64 decidedAt;
        uint64 expiresAt;
        /// @dev Block of the decision, so a reader finds the sealed letter in one log query.
        uint64 decidedBlock;
        bytes32 dossierHash;
    }

    /// @notice The compliance officer: decides on dossiers, with its ML-DSA-87 key only.
    address public complianceOfficer;
    /// @notice The Asset Kit's hybrid-holder guard: a registered ML-DSA-87 key with proof of possession.
    IHolderEligibility public immutable hybridGuard;

    mapping(address account => bytes) public encryptionKey;
    mapping(address account => bytes) public dossier;
    mapping(address account => Member) public members;

    /// @notice Every account that ever filed, in order: the officer's work list.
    address[] public applicants;

    event EncryptionKeyPublished(address indexed account, bytes32 keyHash);
    event DossierFiled(address indexed account, bytes32 dossierHash, uint256 size);
    event Approved(address indexed account, uint8 tier, uint64 expiresAt, bytes32 dossierHash, bytes letter);
    event Rejected(address indexed account, bytes32 dossierHash, bytes letter);
    event Revoked(address indexed account);
    event ComplianceOfficerChanged(address indexed previous, address indexed next);

    error NotQuantumSafe(address account);
    error BadEncryptionKey(uint256 length);
    error BadEnvelope();
    error NoEncryptionKey(address account);
    error NotPending(address account, Status status);
    error StaleDossier(bytes32 signed, bytes32 filed);
    error AlreadyExpired(uint64 expiresAt);
    error NotApproved(address account);

    constructor(address admin_, address complianceOfficer_, IHolderEligibility hybridGuard_) PqcGoverned(admin_) {
        if (complianceOfficer_ == address(0) || address(hybridGuard_) == address(0)) revert ZeroAddress();
        hybridGuard = hybridGuard_;
        complianceOfficer = complianceOfficer_;
        emit ComplianceOfficerChanged(address(0), complianceOfficer_);
    }

    // ------------------------------------------------------------------
    // Lender side
    // ------------------------------------------------------------------

    /// @notice Binds an ML-KEM-1024 key to the caller. Only an account with a proven ML-DSA-87 key may: the
    ///         encryption key then inherits the post-quantum authentication of every transaction that account sends.
    function publishEncryptionKey(bytes calldata mlkemPublicKey) external {
        if (!hybridGuard.isEligible(msg.sender)) revert NotQuantumSafe(msg.sender);
        if (mlkemPublicKey.length != MLKEM_1024_PUBLIC_KEY) revert BadEncryptionKey(mlkemPublicKey.length);
        encryptionKey[msg.sender] = mlkemPublicKey;
        emit EncryptionKeyPublished(msg.sender, keccak256(mlkemPublicKey));
    }

    /// @notice Files (or refiles) the caller's sealed dossier. The decision letter is sealed to the caller's
    ///         encryption key, so one must be published first.
    function fileDossier(bytes calldata envelope) external {
        if (!hybridGuard.isEligible(msg.sender)) revert NotQuantumSafe(msg.sender);
        if (encryptionKey[msg.sender].length == 0) revert NoEncryptionKey(msg.sender);
        if (envelope.length < 64 || envelope.length > MAX_ENVELOPE || bytes4(envelope[:4]) != QSEL) {
            revert BadEnvelope();
        }
        Member storage m = members[msg.sender];
        if (m.status == Status.None) applicants.push(msg.sender);
        // Refiling while approved puts the account back in review: the officer approved the old dossier.
        m.status = Status.Pending;
        m.filedAt = uint64(block.timestamp);
        m.dossierHash = keccak256(envelope);
        dossier[msg.sender] = envelope;
        emit DossierFiled(msg.sender, m.dossierHash, envelope.length);
    }

    // ------------------------------------------------------------------
    // Compliance officer, by signature only
    // ------------------------------------------------------------------

    /// @notice Approves `account` for `tier` until `expiresAt`. `letter` is the decision sealed to the account and
    ///         the auditor; its hash is part of what the officer signed.
    function approve(
        address account,
        uint8 tier,
        uint64 expiresAt,
        bytes32 dossierHash,
        bytes calldata letter,
        uint256 deadline,
        bytes calldata signature
    ) external {
        Member storage m = _pending(account, dossierHash);
        if (expiresAt <= block.timestamp) revert AlreadyExpired(expiresAt);
        _pqcAuthorize(
            complianceOfficer,
            "approve",
            abi.encode(account, tier, expiresAt, dossierHash, keccak256(letter)),
            deadline,
            signature
        );
        m.status = Status.Approved;
        m.tier = tier;
        m.expiresAt = expiresAt;
        m.decidedAt = uint64(block.timestamp);
        m.decidedBlock = uint64(block.number);
        emit Approved(account, tier, expiresAt, dossierHash, letter);
    }

    function reject(address account, bytes32 dossierHash, bytes calldata letter, uint256 deadline, bytes calldata signature)
        external
    {
        Member storage m = _pending(account, dossierHash);
        _pqcAuthorize(
            complianceOfficer, "reject", abi.encode(account, dossierHash, keccak256(letter)), deadline, signature
        );
        m.status = Status.Rejected;
        m.decidedAt = uint64(block.timestamp);
        m.decidedBlock = uint64(block.number);
        emit Rejected(account, dossierHash, letter);
    }

    /// @notice Ends an approval. The holder keeps every agUSD it has and can always redeem; it can no longer
    ///         receive or send shares.
    function revoke(address account, uint256 deadline, bytes calldata signature) external {
        Member storage m = members[account];
        if (m.status != Status.Approved) revert NotApproved(account);
        _pqcAuthorize(complianceOfficer, "revoke", abi.encode(account), deadline, signature);
        m.status = Status.Revoked;
        m.decidedAt = uint64(block.timestamp);
        m.decidedBlock = uint64(block.number);
        emit Revoked(account);
    }

    function setComplianceOfficer(address next, uint256 deadline, bytes calldata signature) external {
        if (next == address(0)) revert ZeroAddress();
        _onlyAdmin("setComplianceOfficer", abi.encode(next), deadline, signature);
        emit ComplianceOfficerChanged(complianceOfficer, next);
        complianceOfficer = next;
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    /// @notice May `account` hold agUSD right now: approved, not expired, and still a hybrid holder.
    function isEligible(address account) public view override returns (bool) {
        Member storage m = members[account];
        return m.status == Status.Approved && m.expiresAt > block.timestamp && hybridGuard.isEligible(account);
    }

    function applicantCount() external view returns (uint256) {
        return applicants.length;
    }

    /// @notice Accounts from `start` whose dossier waits for a decision, at most `max` of them.
    function pending(uint256 start, uint256 max) external view returns (address[] memory out, uint256 next) {
        uint256 n = applicants.length;
        out = new address[](max);
        uint256 k;
        for (next = start; next < n && k < max; ++next) {
            address a = applicants[next];
            if (members[a].status == Status.Pending) out[k++] = a;
        }
        assembly ("memory-safe") {
            mstore(out, k)
        }
    }

    /// @notice Every approved account, for the data room's membership.
    function approved() external view returns (address[] memory out) {
        uint256 n = applicants.length;
        out = new address[](n);
        uint256 k;
        for (uint256 i; i < n; ++i) {
            if (isEligible(applicants[i])) out[k++] = applicants[i];
        }
        assembly ("memory-safe") {
            mstore(out, k)
        }
    }

    function _pending(address account, bytes32 dossierHash) private view returns (Member storage m) {
        m = members[account];
        if (m.status != Status.Pending) revert NotPending(account, m.status);
        if (m.dossierHash != dossierHash) revert StaleDossier(dossierHash, m.dossierHash);
    }
}
