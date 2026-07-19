// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IdentityRegistry.sol";

/// @dev Minimal interface onto DisbursementController — kept local rather
///      than importing the contract, matching the pattern DisbursementController.sol
///      itself uses for ITRC20. Only the surface D3RACHub actually calls.
interface IDisbursementControllerHub {
    function createCommitment(
        address recipient,
        address token,
        string calldata community,
        string[] calldata descriptions,
        uint256[] calldata amounts
    ) external returns (uint256 commitmentId);

    function attestMilestone(uint256 commitmentId, uint256 milestoneIndex) external;
    function cancelCommitment(uint256 commitmentId) external;
    function commitmentCount() external view returns (uint256);
}

/// @dev Minimal interface onto D3RACToken — only what D3RACHub calls.
interface IMintableToken {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function mint(address to, uint256 value) external;
}

/// @dev Minimal interface onto RiskRegistry — only what D3RACHub calls.
interface IRiskRegistryHub {
    function registerCommunity(bytes32 communityId, string calldata name_, string calldata region) external;
    function updateRisk(bytes32 communityId, uint256 hazard, uint256 exposure, uint256 vulnerability) external;
    function communityCount() external view returns (uint256);
}

/// @dev Minimal interface onto FundingRequestRegistry — only what D3RACHub calls.
interface IFundingRequestRegistryHub {
    function openRequest(
        bytes32 communityId,
        uint256 amountRequested,
        string calldata description,
        string calldata dataSourceURI
    ) external returns (uint256 requestId);

    function closeRequest(uint256 requestId) external;
    function requestCount() external view returns (uint256);
}

/// @title D3RACHub
/// @notice The central coordinator for D3R·AC — the "brain box" that sits
///         in front of D3RACToken, IdentityRegistry, DisbursementController,
///         RiskRegistry, and FundingRequestRegistry. It exists to give the
///         project three things none of those contracts provide on their
///         own:
///
///         1. **One admin surface.** Instead of separately managing admin
///            keys on five contracts, an operator (ideally
///            MultiSigAdmin.sol) administers the Hub, and the Hub is
///            granted verifier/attester/minter/dataFeeder/proposer status
///            on the underlying contracts. Day-to-day actions (verify a
///            recipient, attest a milestone, create a commitment, mint,
///            register a community, push a risk update, open a funding
///            request) go through the Hub.
///         2. **One emergency stop.** `pause()` halts the Hub's own
///            write-paths (verify, createCommitment, attest, mint,
///            registerCommunity, updateRisk, openFundingRequest) in one
///            call, without needing to touch five separate contracts'
///            role mappings under pressure. `cancelCommitment`,
///            `closeFundingRequest`, and all admin/module-management
///            functions stay callable while paused, since those are the
///            defensive actions you need *during* an incident.
///         3. **One place to read system status.** `systemStatus()`
///            aggregates state that would otherwise take five separate
///            calls (and five separate contract addresses) for the
///            frontend or a block explorer to assemble.
///
/// @dev The Hub does NOT replace the underlying contracts' own access
///      control — it's an additional caller that must itself be granted
///      the relevant role after deployment (see contracts/tron/README.md's
///      "Wiring the Hub" section — the additive-vs-exclusive distinction
///      documented there applies to the new modules too: updateRisk and
///      openFundingRequest are role-gated (additive, via addDataFeeder /
///      addProposer), while registerCommunity is gated by RiskRegistry's
///      single `owner` (exclusive — the Hub must actually become that
///      owner via transferOwnership, same as DisbursementController's
///      createCommitment). Calling the underlying contracts directly,
///      bypassing the Hub, is still possible for anyone who already holds
///      a role there; the Hub is a convenience and a pause point, not a
///      sealed choke point. Treat it as operational tooling, not a
///      security boundary by itself. RiskRegistry and
///      FundingRequestRegistry are optional at construction (address(0)
///      is accepted and can be wired in later) — matching the "connect by
///      convention, not by hard dependency" design already used between
///      those two contracts themselves.
///      Dependency-free by design — see D3RACToken.sol for rationale.
contract D3RACHub {
    address public admin;
    bool public paused;

    IMintableToken public token;
    IdentityRegistry public identityRegistry;
    IDisbursementControllerHub public disbursementController;
    IRiskRegistryHub public riskRegistry;
    IFundingRequestRegistryHub public fundingRequestRegistry;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event ModuleUpdated(bytes32 indexed module, address indexed previousAddress, address indexed newAddress);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    modifier onlyAdmin() {
        require(msg.sender == admin, "D3RACHub: caller is not admin");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "D3RACHub: paused");
        _;
    }

    /// @param admin_ Should be a multisig (see MultiSigAdmin.sol) before
    ///        mainnet use — this address controls every module pointer
    ///        and the emergency pause.
    /// @param token_ Deployed D3RACToken (or any IMintableToken-compatible
    ///        token) address. Required.
    /// @param identityRegistry_ Deployed IdentityRegistry address. Required.
    /// @param disbursementController_ Deployed DisbursementController
    ///        address. Required.
    /// @param riskRegistry_ Deployed RiskRegistry address, or address(0)
    ///        to leave it unconfigured for now (set later via
    ///        `setRiskRegistry`) — optional, connect-by-convention rather
    ///        than a hard dependency of the core triad.
    /// @param fundingRequestRegistry_ Deployed FundingRequestRegistry
    ///        address, or address(0) to leave it unconfigured for now
    ///        (set later via `setFundingRequestRegistry`) — same
    ///        optionality as riskRegistry_.
    constructor(
        address admin_,
        address token_,
        address identityRegistry_,
        address disbursementController_,
        address riskRegistry_,
        address fundingRequestRegistry_
    ) {
        require(admin_ != address(0), "D3RACHub: admin is zero address");
        require(token_ != address(0), "D3RACHub: token is zero address");
        require(identityRegistry_ != address(0), "D3RACHub: identityRegistry is zero address");
        require(disbursementController_ != address(0), "D3RACHub: disbursementController is zero address");

        admin = admin_;
        token = IMintableToken(token_);
        identityRegistry = IdentityRegistry(identityRegistry_);
        disbursementController = IDisbursementControllerHub(disbursementController_);
        riskRegistry = IRiskRegistryHub(riskRegistry_);
        fundingRequestRegistry = IFundingRequestRegistryHub(fundingRequestRegistry_);

        emit AdminTransferred(address(0), admin_);
        emit ModuleUpdated("token", address(0), token_);
        emit ModuleUpdated("identityRegistry", address(0), identityRegistry_);
        emit ModuleUpdated("disbursementController", address(0), disbursementController_);
        emit ModuleUpdated("riskRegistry", address(0), riskRegistry_);
        emit ModuleUpdated("fundingRequestRegistry", address(0), fundingRequestRegistry_);
    }

    // ── Admin / module management (always callable, even while paused —
    //    an incident that requires re-pointing a module or changing admin
    //    shouldn't be blocked by the pause meant to contain it) ──────────

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "D3RACHub: new admin is zero address");
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    function setToken(address newToken) external onlyAdmin {
        require(newToken != address(0), "D3RACHub: token is zero address");
        emit ModuleUpdated("token", address(token), newToken);
        token = IMintableToken(newToken);
    }

    function setIdentityRegistry(address newRegistry) external onlyAdmin {
        require(newRegistry != address(0), "D3RACHub: identityRegistry is zero address");
        emit ModuleUpdated("identityRegistry", address(identityRegistry), newRegistry);
        identityRegistry = IdentityRegistry(newRegistry);
    }

    function setDisbursementController(address newController) external onlyAdmin {
        require(newController != address(0), "D3RACHub: disbursementController is zero address");
        emit ModuleUpdated("disbursementController", address(disbursementController), newController);
        disbursementController = IDisbursementControllerHub(newController);
    }

    /// @notice Set or clear the RiskRegistry module. Unlike the three
    ///         core setters above, address(0) is accepted here — this
    ///         pairing is optional, so unwiring it back to "not
    ///         configured" is a legitimate admin action, not an error.
    function setRiskRegistry(address newRiskRegistry) external onlyAdmin {
        emit ModuleUpdated("riskRegistry", address(riskRegistry), newRiskRegistry);
        riskRegistry = IRiskRegistryHub(newRiskRegistry);
    }

    /// @notice Set or clear the FundingRequestRegistry module. Same
    ///         optionality as setRiskRegistry above.
    function setFundingRequestRegistry(address newFundingRequestRegistry) external onlyAdmin {
        emit ModuleUpdated("fundingRequestRegistry", address(fundingRequestRegistry), newFundingRequestRegistry);
        fundingRequestRegistry = IFundingRequestRegistryHub(newFundingRequestRegistry);
    }

    // ── Emergency pause ──────────────────────────────────────────────────

    function pause() external onlyAdmin {
        require(!paused, "D3RACHub: already paused");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        require(paused, "D3RACHub: not paused");
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ── Orchestration (gated behind admin + pause; requires the Hub to
    //    itself hold verifier/attester/minter status on the underlying
    //    contract — see "Wiring the Hub" in contracts/tron/README.md) ────

    /// @notice Verify a recipient via IdentityRegistry, routed through the
    ///         Hub so it's subject to the pause and shows up alongside
    ///         every other admin action from one contract's event log.
    function verifyRecipient(address recipient, string calldata community) external onlyAdmin whenNotPaused {
        identityRegistry.verifyRecipient(recipient, community);
    }

    /// @notice Create a milestone-based funding commitment via
    ///         DisbursementController. See DisbursementController.sol's
    ///         createCommitment for parameter details.
    function createCommitment(
        address recipient,
        address commitmentToken,
        string calldata community,
        string[] calldata descriptions,
        uint256[] calldata amounts
    ) external onlyAdmin whenNotPaused returns (uint256 commitmentId) {
        return disbursementController.createCommitment(recipient, commitmentToken, community, descriptions, amounts);
    }

    /// @notice Attest a milestone via DisbursementController.
    function attestMilestone(uint256 commitmentId, uint256 milestoneIndex) external onlyAdmin whenNotPaused {
        disbursementController.attestMilestone(commitmentId, milestoneIndex);
    }

    /// @notice Cancel a commitment. Deliberately NOT gated by
    ///         whenNotPaused — halting a bad commitment is exactly the
    ///         kind of defensive action a pause shouldn't block.
    function cancelCommitment(uint256 commitmentId) external onlyAdmin {
        disbursementController.cancelCommitment(commitmentId);
    }

    /// @notice Mint tokens via D3RACToken. Requires the Hub to hold
    ///         minter status on the token (D3RACToken.setMinter).
    function mintTokens(address to, uint256 value) external onlyAdmin whenNotPaused {
        token.mint(to, value);
    }

    /// @notice Register a community via RiskRegistry. Requires riskRegistry
    ///         to be set AND the Hub to actually be RiskRegistry's `owner`
    ///         (RiskRegistry.transferOwnership) — this is exclusive, not
    ///         additive, same as DisbursementController's createCommitment.
    function registerCommunity(bytes32 communityId, string calldata name_, string calldata region)
        external
        onlyAdmin
        whenNotPaused
    {
        require(address(riskRegistry) != address(0), "D3RACHub: riskRegistry not set");
        riskRegistry.registerCommunity(communityId, name_, region);
    }

    /// @notice Push a risk update via RiskRegistry. Requires riskRegistry
    ///         to be set AND the Hub to hold data-feeder status
    ///         (RiskRegistry.addDataFeeder) — additive, same pattern as
    ///         verifier/attester/minter.
    function updateRisk(bytes32 communityId, uint256 hazard, uint256 exposure, uint256 vulnerability)
        external
        onlyAdmin
        whenNotPaused
    {
        require(address(riskRegistry) != address(0), "D3RACHub: riskRegistry not set");
        riskRegistry.updateRisk(communityId, hazard, exposure, vulnerability);
    }

    /// @notice Open a funding request via FundingRequestRegistry. Requires
    ///         fundingRequestRegistry to be set AND the Hub to hold
    ///         proposer status (FundingRequestRegistry.addProposer) —
    ///         additive. Because FundingRequestRegistry records the caller
    ///         as the request's `requester`, a request opened this way is
    ///         attributed to the Hub itself — which is what makes
    ///         closeFundingRequest below work with no further wiring, but
    ///         also means only requests opened *through the Hub* can be
    ///         closed through it (see closeFundingRequest's note).
    function openFundingRequest(
        bytes32 communityId,
        uint256 amountRequested,
        string calldata description,
        string calldata dataSourceURI
    ) external onlyAdmin whenNotPaused returns (uint256 requestId) {
        require(address(fundingRequestRegistry) != address(0), "D3RACHub: fundingRequestRegistry not set");
        return fundingRequestRegistry.openRequest(communityId, amountRequested, description, dataSourceURI);
    }

    /// @notice Close a funding request. FundingRequestRegistry.closeRequest
    ///         only allows the request's own requester or
    ///         FundingRequestRegistry's owner to close it — so this only
    ///         succeeds for requests the Hub itself opened (see
    ///         openFundingRequest), unless the Hub has separately been
    ///         made FundingRequestRegistry's owner via transferOwnership.
    ///         Deliberately NOT gated by whenNotPaused, matching
    ///         cancelCommitment — closing a bad request is a defensive
    ///         action a pause shouldn't block.
    function closeFundingRequest(uint256 requestId) external onlyAdmin {
        require(address(fundingRequestRegistry) != address(0), "D3RACHub: fundingRequestRegistry not set");
        fundingRequestRegistry.closeRequest(requestId);
    }

    // ── Aggregate status (one call instead of five contracts) ─────────

    function systemStatus() external view returns (
        address tokenAddress,
        address identityRegistryAddress,
        address disbursementControllerAddress,
        address riskRegistryAddress,
        address fundingRequestRegistryAddress,
        bool isPaused,
        uint256 tokenTotalSupply,
        uint256 totalCommitments,
        uint256 totalCommunities,
        uint256 totalFundingRequests
    ) {
        return (
            address(token),
            address(identityRegistry),
            address(disbursementController),
            address(riskRegistry),
            address(fundingRequestRegistry),
            paused,
            token.totalSupply(),
            disbursementController.commitmentCount(),
            address(riskRegistry) != address(0) ? riskRegistry.communityCount() : 0,
            address(fundingRequestRegistry) != address(0) ? fundingRequestRegistry.requestCount() : 0
        );
    }
}
