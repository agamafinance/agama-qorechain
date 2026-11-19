// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IERC3643ComplianceModule} from "@qorechain/asset-kit/erc3643/IERC3643ComplianceModule.sol";
import {IHolderEligibility} from "@qorechain/asset-kit/interfaces/IHolderEligibility.sol";

/// @title AgamaComplianceModule
/// @notice Agama's sealed KYC as an ERC-3643 (T-REX v4) compliance module. Any permissioned token on QoreChain can
///         plug it into its modular compliance and admit exactly the holders Agama's compliance officer approved
///         with ML-DSA-87, who still hold a proven ML-DSA-87 key, without ever seeing their identity: the dossiers
///         stay sealed, the decision is all the token needs.
/// @dev Built on the Asset Kit's interface, the same shape as its QoreChainHybridHolderModule, with the policy
///      being the AccessRegistry instead of the bare hybrid-holder guard. Plug and play: no per-compliance state.
contract AgamaComplianceModule is IERC3643ComplianceModule {
    IHolderEligibility public immutable policy;

    mapping(address compliance => bool) private _bound;

    error OnlyComplianceCanBind();
    error ComplianceAlreadyBound();
    error ComplianceNotBound();

    constructor(IHolderEligibility policy_) {
        policy = policy_;
    }

    function bindCompliance(address compliance) external override {
        if (msg.sender != compliance) revert OnlyComplianceCanBind();
        if (_bound[compliance]) revert ComplianceAlreadyBound();
        _bound[compliance] = true;
        emit ComplianceBound(compliance);
    }

    function unbindCompliance(address compliance) external override {
        if (msg.sender != compliance) revert OnlyComplianceCanBind();
        if (!_bound[compliance]) revert ComplianceNotBound();
        _bound[compliance] = false;
        emit ComplianceUnbound(compliance);
    }

    function moduleTransferAction(address, address, uint256) external view override {
        if (!_bound[msg.sender]) revert ComplianceNotBound();
    }

    function moduleMintAction(address, uint256) external view override {
        if (!_bound[msg.sender]) revert ComplianceNotBound();
    }

    function moduleBurnAction(address, uint256) external view override {
        if (!_bound[msg.sender]) revert ComplianceNotBound();
    }

    /// @notice A burn (to = 0) is always allowed, as in agUSD: an approval that lapses never traps a holder.
    function moduleCheck(address from, address to, uint256, address) external view override returns (bool) {
        if (to == address(0)) return true;
        if (from != address(0) && !policy.isEligible(from)) return false;
        return policy.isEligible(to);
    }

    function isComplianceBound(address compliance) external view override returns (bool) {
        return _bound[compliance];
    }

    function canComplianceBind(address) external pure override returns (bool) {
        return true;
    }

    function isPlugAndPlay() external pure override returns (bool) {
        return true;
    }

    function name() external pure override returns (string memory) {
        return "AgamaComplianceModule";
    }
}
