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

/// @title D3RACHub
/// @notice The central coordinator for D3R·AC — the "brain box" that sits
///         in front of D3RACToken, IdentityRegistry, and
///         DisbursementController. It exists to give the project three
///         things none of those contracts provide on their own:
///
///         1. **One admin surface.** Instead of separately managing admin
///            keys on three contracts, an operator (ideally
///            MultiSigAdmin.sol) administers the Hub, and the Hub is
///            granted verifier/attester/minter status on the underlying
///            contracts. Day-to-day actions (verify a recipient, attest a
///            milestone, create a commitment, mint) go through the Hub.
///         2. **One emergency stop.** `pause()` halts the Hub's own
///            write-paths (verify, attest, createCommitment, mint) in one
///            call, without needing to touch three separate contracts'
///            role mappings under pressure. `cancelCommitment` and all
///            admin/module-management functions stay callable while
///            paused, since those are the defensive actions you need
///            *during* an incident.
///         3. **One place to read system status.** `systemStatus()`
///            aggregates state that would otherwise take three separate
///            calls (and three separate contract addresses) for the
///            frontend or a block explorer to assemble.
///
/// @dev The Hub does NOT replace the underlying contracts' own access
///      control — it's an additional caller that must itself be granted
///      verifier/attester/minter status after deployment (see
///      contracts/tron/README.md's "Wiring the Hub" section). Calling
///      the underlying contracts directly, bypassing the Hub, is still
///      possible for anyone who already holds a role there; the Hub is a
///      convenience and a pause point, not a sealed choke point. Treat it
///      as operational tooling, not a security boundary by itself.
///      Dependency-free by design — see D3RACToken.sol for rationale.
contract D3RACHub {
    address public admin;
    bool public paused;

    IMintableToken public token;
    IdentityRegistry public identityRegistry;
    IDisbursementControllerHub public disbursementController;

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
    ///        token) address.
    /// @param identityRegistry_ Deployed IdentityRegistry address.
    /// @param disbursementController_ Deployed DisbursementController
    ///        address.
    constructor(
        address admin_,
        address token_,
        address identityRegistry_,
        address disbursementController_
    ) {
        require(admin_ != address(0), "D3RACHub: admin is zero address");
        require(token_ != address(0), "D3RACHub: token is zero address");
        require(identityRegistry_ != address(0), "D3RACHub: identityRegistry is zero address");
        require(disbursementController_ != address(0), "D3RACHub: disbursementController is zero address");

        admin = admin_;
        token = IMintableToken(token_);
        identityRegistry = IdentityRegistry(identityRegistry_);
        disbursementController = IDisbursementControllerHub(disbursementController_);

        emit AdminTransferred(address(0), admin_);
        emit ModuleUpdated("token", address(0), token_);
        emit ModuleUpdated("identityRegistry", address(0), identityRegistry_);
        emit ModuleUpdated("disbursementController", address(0), disbursementController_);
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

    // ── Aggregate status (one call instead of three contracts) ─────────

    function systemStatus() external view returns (
        address tokenAddress,
        address identityRegistryAddress,
        address disbursementControllerAddress,
        bool isPaused,
        uint256 tokenTotalSupply,
        uint256 totalCommitments
    ) {
        return (
            address(token),
            address(identityRegistry),
            address(disbursementController),
            paused,
            token.totalSupply(),
            disbursementController.commitmentCount()
        );
    }
}
