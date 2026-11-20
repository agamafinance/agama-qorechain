// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";
import {PqAccount} from "./PqAccount.sol";
import {PqcAuth} from "../pqc/PqcAuth.sol";

interface IHybridGuardAdmin {
    function setExempt(address account, bool value, string calldata reason) external;
    function acceptOwnership() external;
    function transferOwnership(address newOwner) external;
}

/// @title PqAccountFactory
/// @notice Deploys each lender's PqAccount at an address fixed by the owner alone (CREATE2), so the app knows it
///         before it exists, and creates it with the first action. It owns the Asset Kit's hybrid holder guard: a
///         contract has no ML-DSA-87 key of its own, so the guard exempts each account it deploys, and it deploys
///         one only for an owner whose ML-DSA-87 key is registered with proof of possession. An exempt account is
///         therefore as quantum-safe as the key that controls it.
contract PqAccountFactory {
    IHybridGuardAdmin public immutable guard;
    /// @notice The operator's key: sets Agama's targets and passes other exemptions to the guard.
    address public admin;
    mapping(address target => bool) public allowedTarget;
    mapping(address account => address owner) public ownerOf;

    event AccountCreated(address indexed owner, address indexed account);
    event TargetSet(address indexed target, bool allowed);

    error NotAdmin();
    error OwnerNotQuantumSafe(address owner);

    constructor(address admin_, IHybridGuardAdmin guard_, address[] memory targets) {
        admin = admin_;
        guard = guard_;
        for (uint256 i; i < targets.length; ++i) {
            allowedTarget[targets[i]] = true;
            emit TargetSet(targets[i], true);
        }
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function accountOf(address owner) public view returns (address) {
        return Create2.computeAddress(bytes32(uint256(uint160(owner))), keccak256(abi.encodePacked(type(PqAccount).creationCode, abi.encode(owner))));
    }

    /// @notice The owner's account, deployed and exempted if it is not yet. Anyone may call it.
    function create(address owner) public returns (PqAccount account) {
        address a = accountOf(owner);
        if (a.code.length != 0) return PqAccount(a);
        if (!PqcAuth.isQuantumSafe(owner)) revert OwnerNotQuantumSafe(owner);
        account = new PqAccount{salt: bytes32(uint256(uint160(owner)))}(owner);
        ownerOf[address(account)] = owner;
        guard.setExempt(address(account), true, "Agama PqAccount: controlled by its owner's ML-DSA-87 key");
        emit AccountCreated(owner, address(account));
    }

    /// @notice The first action and the account in one transaction; later actions go straight to the account.
    function execute(address owner, PqAccount.Call[] calldata calls, string calldata summary, uint256 deadline, bytes calldata pqSignature)
        external
    {
        create(owner).execute(calls, summary, deadline, pqSignature);
    }

    // ---- admin ---------------------------------------------------------------------------------------------------
    function setTarget(address target, bool allowed) external onlyAdmin {
        allowedTarget[target] = allowed;
        emit TargetSet(target, allowed);
    }

    function acceptGuardOwnership() external onlyAdmin {
        guard.acceptOwnership();
    }

    function setExempt(address account, bool value, string calldata reason) external onlyAdmin {
        guard.setExempt(account, value, reason);
    }

    /// @notice Hands the guard back, should this factory be replaced.
    function transferGuard(address to) external onlyAdmin {
        guard.transferOwnership(to);
    }

    function setAdmin(address next) external onlyAdmin {
        admin = next;
    }
}
