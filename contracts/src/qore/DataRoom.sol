// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {PqcGoverned} from "../pqc/PqcGoverned.sol";
import {AccessRegistry} from "./AccessRegistry.sol";

/// @title DataRoom
/// @notice The credit book's loan tape, readable by the vault's approved lenders and the auditor and by nobody else.
/// @dev Private credit lives on information a public chain cannot publish: who borrowed, against what, how it
///      performs. The data room keeps it on chain anyway, encrypted, with QoreSeal's private-group construction:
///
///        epoch      a 32-byte group key. A new one starts every time the set of approved lenders changes, and its
///                   distribution is that key sealed with ML-KEM-1024 to each member's published key and to the
///                   auditor. A lender who leaves keeps the epochs it belonged to and cannot read the next one.
///                   The distribution comes in parts of at most PART_SIZE members (plus the auditor in each): a
///                   single envelope grows by 1.6 kB per reader, and past about thirty readers the public RPC refused
///                   the request outright (FINDINGS 19). The manager signs the hashes of every part at once; anyone
///                   may then post a part, which the contract accepts only if it hashes to what was signed.
///        report     a batch (loan tape, NAV breakdown) encrypted with the epoch key under AES-256-GCM, published
///                   with a commitment to its ciphertext and a salted commitment to its plaintext, so a member who
///                   decrypts it can prove what it read.
///
///      Both are signed by the manager with ML-DSA-87 and checked by `pqcVerify` before they are accepted, so a
///      reader knows the tape came from the manager and not from whoever relayed it. Members must be lenders the
///      AccessRegistry approves at the moment the epoch is published.
///
///      The ciphertext lives in this contract's logs; storage keeps one record per epoch and per report with the
///      block it was published in, so a reader fetches each in one log query.
contract DataRoom is PqcGoverned {
    /// @notice "QSEL", the QoreSeal envelope magic; "QSBT", the batch magic.
    bytes4 public constant QSEL = 0x5153454c;
    bytes4 public constant QSBT = 0x51534254;
    /// @notice Members per distribution part. Member i of an epoch reads part i / PART_SIZE.
    uint256 public constant PART_SIZE = 8;

    struct Epoch {
        uint64 publishedAt;
        uint64 blockNumber;
        uint32 members;
        uint32 parts;
        uint32 partsPosted;
        bytes32 membersHash;
        /// @dev keccak256(abi.encode(partHashes)), what the manager signed.
        bytes32 distributionHash;
    }

    struct Report {
        uint64 epoch;
        uint64 publishedAt;
        uint64 blockNumber;
        uint32 size;
        bytes32 ciphertextCommitment;
        bytes32 plaintextCommitment;
        bytes32 kind;
    }

    AccessRegistry public immutable access;
    /// @notice Signs epochs and reports with its ML-DSA-87 key.
    address public manager;

    Epoch[] internal _epochs;
    Report[] internal _reports;
    /// @notice Whether an account is a member of an epoch.
    mapping(uint256 epoch => mapping(address account => bool)) public isMember;
    /// @notice An account's position in an epoch's member list, plus one (0: not a member).
    mapping(uint256 epoch => mapping(address account => uint256)) public memberPosition;
    /// @notice The signed hash of each distribution part, and the block it was posted in (0: not yet).
    mapping(uint256 epoch => mapping(uint256 part => bytes32)) public partHash;
    mapping(uint256 epoch => mapping(uint256 part => uint64)) public partBlock;

    event EpochPublished(uint256 indexed epoch, address[] members, bytes32[] partHashes);
    event EpochPart(uint256 indexed epoch, uint256 indexed part, bytes distribution);
    event ReportPublished(
        uint256 indexed index,
        uint256 indexed epoch,
        bytes32 indexed kind,
        bytes blob,
        bytes32 ciphertextCommitment,
        bytes32 plaintextCommitment
    );
    event ManagerChanged(address indexed previous, address indexed next);

    error WrongEpoch(uint256 expected, uint256 given);
    error NoSuchEpoch(uint256 epoch);
    error NotEligible(address account);
    error BadEnvelope();
    error BadBatch();
    error BadParts(uint256 members, uint256 parts);
    error NoSuchPart(uint256 epoch, uint256 part);
    error PartMismatch(bytes32 signed, bytes32 posted);
    error PartPosted(uint256 epoch, uint256 part);

    constructor(AccessRegistry access_, address admin_, address manager_) PqcGoverned(admin_) {
        if (manager_ == address(0)) revert ZeroAddress();
        access = access_;
        manager = manager_;
        emit ManagerChanged(address(0), manager_);
    }

    /// @notice Starts epoch `epoch` for `members`. `partHashes` are the keccak256 of the distribution parts: the epoch
    ///         key sealed to members [k * PART_SIZE, (k + 1) * PART_SIZE) and the auditor, for part k.
    function publishEpoch(
        uint256 epoch,
        address[] calldata members,
        bytes32[] calldata partHashes,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (epoch != _epochs.length) revert WrongEpoch(_epochs.length, epoch);
        uint256 parts = members.length == 0 ? 1 : (members.length + PART_SIZE - 1) / PART_SIZE;
        if (partHashes.length != parts) revert BadParts(members.length, partHashes.length);
        bytes32 membersHash = keccak256(abi.encode(members));
        bytes32 distributionHash = keccak256(abi.encode(partHashes));
        _pqcAuthorize(manager, "publishEpoch", abi.encode(epoch, membersHash, distributionHash), deadline, signature);

        for (uint256 i; i < members.length; ++i) {
            if (!access.isEligible(members[i])) revert NotEligible(members[i]);
            isMember[epoch][members[i]] = true;
            memberPosition[epoch][members[i]] = i + 1;
        }
        for (uint256 k; k < parts; ++k) {
            partHash[epoch][k] = partHashes[k];
        }
        _epochs.push(
            Epoch({
                publishedAt: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                members: uint32(members.length),
                parts: uint32(parts),
                partsPosted: 0,
                membersHash: membersHash,
                distributionHash: distributionHash
            })
        );
        emit EpochPublished(epoch, members, partHashes);
    }

    /// @notice Posts part `part` of epoch `epoch`'s key distribution. Anyone may: it is accepted only if it hashes to
    ///         what the manager signed.
    function publishEpochPart(uint256 epoch, uint256 part, bytes calldata distribution) external {
        if (epoch >= _epochs.length) revert NoSuchEpoch(epoch);
        bytes32 signed = partHash[epoch][part];
        if (signed == bytes32(0)) revert NoSuchPart(epoch, part);
        if (partBlock[epoch][part] != 0) revert PartPosted(epoch, part);
        if (distribution.length < 64 || bytes4(distribution[:4]) != QSEL) revert BadEnvelope();
        bytes32 posted = keccak256(distribution);
        if (posted != signed) revert PartMismatch(signed, posted);
        partBlock[epoch][part] = uint64(block.number);
        _epochs[epoch].partsPosted += 1;
        emit EpochPart(epoch, part, distribution);
    }

    /// @notice The part of epoch `epoch` that `account` reads, and the block it was posted in (0 when not yet).
    function partOf(uint256 epoch, address account) external view returns (bool member, uint256 part, uint64 blockNumber) {
        uint256 pos = memberPosition[epoch][account];
        if (pos == 0) return (false, 0, 0);
        part = (pos - 1) / PART_SIZE;
        return (true, part, partBlock[epoch][part]);
    }

    /// @notice Publishes a batch encrypted under epoch `epoch`'s key.
    function publishReport(
        uint256 epoch,
        bytes32 kind,
        bytes calldata blob,
        bytes32 ciphertextCommitment,
        bytes32 plaintextCommitment,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (epoch >= _epochs.length) revert NoSuchEpoch(epoch);
        if (blob.length < 83 || bytes4(blob[:4]) != QSBT) revert BadBatch();
        _pqcAuthorize(
            manager,
            "publishReport",
            abi.encode(epoch, kind, keccak256(blob), ciphertextCommitment, plaintextCommitment),
            deadline,
            signature
        );
        uint256 index = _reports.length;
        _reports.push(
            Report({
                // forge-lint: disable-next-line(unsafe-typecast)
                epoch: uint64(epoch),
                publishedAt: uint64(block.timestamp),
                blockNumber: uint64(block.number),
                size: uint32(blob.length),
                ciphertextCommitment: ciphertextCommitment,
                plaintextCommitment: plaintextCommitment,
                kind: kind
            })
        );
        emit ReportPublished(index, epoch, kind, blob, ciphertextCommitment, plaintextCommitment);
    }

    function setManager(address next, uint256 deadline, bytes calldata signature) external {
        if (next == address(0)) revert ZeroAddress();
        _onlyAdmin("setManager", abi.encode(next), deadline, signature);
        emit ManagerChanged(manager, next);
        manager = next;
    }

    // ---- reads ----

    function epochCount() external view returns (uint256) {
        return _epochs.length;
    }

    function reportCount() external view returns (uint256) {
        return _reports.length;
    }

    function epochs(uint256 epoch) external view returns (Epoch memory) {
        return _epochs[epoch];
    }

    function reports(uint256 index) external view returns (Report memory) {
        return _reports[index];
    }

    /// @notice The last `max` reports, newest first.
    function latestReports(uint256 max) external view returns (Report[] memory out) {
        uint256 n = _reports.length;
        uint256 k = max < n ? max : n;
        out = new Report[](k);
        for (uint256 i; i < k; ++i) {
            out[i] = _reports[n - 1 - i];
        }
    }
}
