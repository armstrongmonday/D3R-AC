// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title MilestoneEscrow
/// @notice D3R·AC's on-chain fund-release layer: TRC-20 tokens are locked
///         against a community "commitment", split into milestone tranches,
///         and released one tranche at a time only after an authorized
///         attestor confirms that milestone's real-world condition was met.
/// @dev This is the contract described (but not yet implemented) in
///      contracts/tron/README.md at the time this was written. It is built
///      to match the ChainAdapter/tronAdapter.ts frontend already in the
///      repo and the Community/riskModel.ts data shape (id, fundedMilestones,
///      totalMilestones) so the Dashboard and Disburse pages can be wired to
///      it directly.
///
///      Security posture: this contract holds real disaster-relief funds
///      once deployed with real tokens. It has NOT been professionally
///      audited. Do not point it at TRON mainnet with real value until an
///      independent audit has been done — see docs/deployment-guide.md.
/// @dev Minimal TRC-20 interface, matching frontend/src/lib/tronAdapter.ts's
///      TRC20_ABI surface (balanceOf/decimals/symbol/transfer) plus
///      transferFrom, which the escrow needs to pull funds in on
///      commitment creation.
interface ITRC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract MilestoneEscrow {
    // ---------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------
    address public owner;

    /// @dev Global attestors can confirm a milestone on ANY commitment.
    ///      Matches contracts/tron/README.md's "authorized reporter role"
    ///      option — start with one trusted reporter (e.g. TAAD ops), add
    ///      more addresses (NGO partner, second verifier) as trust expands.
    ///      This is intentionally simple for v1; a threshold/multisig
    ///      attestation scheme is a natural v2 upgrade and is called out
    ///      in NatSpec below wherever it would slot in.
    mapping(address => bool) public attestors;

    modifier onlyOwner() {
        require(msg.sender == owner, "MilestoneEscrow: caller is not owner");
        _;
    }

    modifier onlyAttestor() {
        require(attestors[msg.sender], "MilestoneEscrow: caller is not an attestor");
        _;
    }

    // ---------------------------------------------------------------
    // Reentrancy guard
    // ---------------------------------------------------------------
    // Minimal hand-rolled guard rather than an OpenZeppelin import, so
    // `tronbox compile` doesn't depend on resolving an external package —
    // keeps the contract self-contained for a repo where contracts/tron
    // has no package.json of its own yet.
    uint256 private constant _NOT_ENTERED = 1;
    uint256 private constant _ENTERED = 2;
    uint256 private _reentrancyStatus = _NOT_ENTERED;

    modifier nonReentrant() {
        require(_reentrancyStatus != _ENTERED, "MilestoneEscrow: reentrant call");
        _reentrancyStatus = _ENTERED;
        _;
        _reentrancyStatus = _NOT_ENTERED;
    }

    // ---------------------------------------------------------------
    // Emergency pause — lets the owner freeze new commitments/releases
    // (e.g. if an attestor key is suspected compromised) without needing
    // to migrate funds. Existing cancellations still work so depositors
    // are never trapped.
    // ---------------------------------------------------------------
    bool public paused;

    modifier whenNotPaused() {
        require(!paused, "MilestoneEscrow: contract is paused");
        _;
    }

    // ---------------------------------------------------------------
    // Data model
    // ---------------------------------------------------------------
    struct Milestone {
        uint256 amount;      // TRC-20 raw (smallest-unit) amount for this tranche
        string description;  // human-readable milestone condition, e.g. "Shelter kits delivered, phase 1"
        bool attested;
        bool released;
        address recipient;   // fixed at creation — attestation can never redirect funds
    }

    struct Commitment {
        bytes32 communityId;  // keccak of / matches Community.id in riskModel.ts (e.g. "c3")
        address token;        // TRC-20 token contract address
        address depositor;    // funder of record (donor, NGO treasury, TAAD ops wallet)
        uint256 totalAmount;  // sum of all milestone amounts, escrowed at creation
        uint256 releasedAmount;
        bool cancelled;
        Milestone[] milestones;
    }

    Commitment[] private _commitments;

    // ---------------------------------------------------------------
    // Events — every state transition is emitted so the whole point of
    // the on-chain approach ("auditable, no opaque intermediary layer")
    // actually holds: anyone can reconstruct full fund history from logs.
    // ---------------------------------------------------------------
    event CommitmentCreated(
        uint256 indexed commitmentId,
        bytes32 indexed communityId,
        address indexed token,
        address depositor,
        uint256 totalAmount,
        uint256 milestoneCount
    );
    event MilestoneAttested(uint256 indexed commitmentId, uint256 indexed milestoneIndex, address indexed attestor);
    event MilestoneReleased(uint256 indexed commitmentId, uint256 indexed milestoneIndex, address indexed recipient, uint256 amount);
    event CommitmentCancelled(uint256 indexed commitmentId, uint256 refundedAmount);
    event AttestorAdded(address indexed attestor);
    event AttestorRemoved(address indexed attestor);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    constructor(address initialAttestor) {
        owner = msg.sender;
        if (initialAttestor != address(0)) {
            attestors[initialAttestor] = true;
            emit AttestorAdded(initialAttestor);
        }
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MilestoneEscrow: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function addAttestor(address attestor) external onlyOwner {
        require(attestor != address(0), "MilestoneEscrow: zero address");
        attestors[attestor] = true;
        emit AttestorAdded(attestor);
    }

    function removeAttestor(address attestor) external onlyOwner {
        attestors[attestor] = false;
        emit AttestorRemoved(attestor);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ---------------------------------------------------------------
    // Commitment lifecycle
    // ---------------------------------------------------------------

    /// @notice Lock TRC-20 funds for a community, split into milestone tranches.
    /// @dev Caller (the depositor) must have already called `approve(escrow, totalAmount)`
    ///      on the TRC-20 token — standard approve/transferFrom pattern, same as any
    ///      TRC-20 spender contract.
    function createCommitment(
        bytes32 communityId,
        address token,
        uint256[] calldata amounts,
        string[] calldata descriptions,
        address[] calldata recipients
    ) external whenNotPaused returns (uint256 commitmentId) {
        require(token != address(0), "MilestoneEscrow: zero token address");
        require(amounts.length > 0, "MilestoneEscrow: at least one milestone required");
        require(
            amounts.length == descriptions.length && amounts.length == recipients.length,
            "MilestoneEscrow: array length mismatch"
        );

        uint256 total = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            require(amounts[i] > 0, "MilestoneEscrow: milestone amount must be > 0");
            require(recipients[i] != address(0), "MilestoneEscrow: zero recipient address");
            total += amounts[i];
        }

        commitmentId = _commitments.length;
        _commitments.push();
        Commitment storage c = _commitments[commitmentId];
        c.communityId = communityId;
        c.token = token;
        c.depositor = msg.sender;
        c.totalAmount = total;

        for (uint256 i = 0; i < amounts.length; i++) {
            c.milestones.push(
                Milestone({
                    amount: amounts[i],
                    description: descriptions[i],
                    attested: false,
                    released: false,
                    recipient: recipients[i]
                })
            );
        }

        // Effects are fully written before the external call (checks-effects-
        // interactions), even though transferFrom here is the funding step,
        // not a withdrawal, to keep the pattern consistent everywhere.
        bool ok = ITRC20(token).transferFrom(msg.sender, address(this), total);
        require(ok, "MilestoneEscrow: TRC-20 transferFrom failed");

        emit CommitmentCreated(commitmentId, communityId, token, msg.sender, total, amounts.length);
    }

    /// @notice Confirm that a milestone's real-world condition has been met.
    /// @dev Only an authorized attestor can call this. Attesting does not move
    ///      funds by itself — release is a separate step so attestation and
    ///      disbursement are two independently auditable events.
    function attestMilestone(uint256 commitmentId, uint256 milestoneIndex) external onlyAttestor whenNotPaused {
        Commitment storage c = _getCommitment(commitmentId);
        require(!c.cancelled, "MilestoneEscrow: commitment is cancelled");
        Milestone storage m = _getMilestone(c, milestoneIndex);
        require(!m.attested, "MilestoneEscrow: milestone already attested");
        m.attested = true;
        emit MilestoneAttested(commitmentId, milestoneIndex, msg.sender);
    }

    /// @notice Release an attested milestone's funds to its fixed recipient.
    /// @dev Deliberately permissionless once attested: no second gatekeeper
    ///      sits between "verified" and "paid," and funds can only ever go to
    ///      the recipient address that was locked in at commitment creation —
    ///      attestation can never redirect where money goes.
    function releaseMilestone(uint256 commitmentId, uint256 milestoneIndex) external nonReentrant whenNotPaused {
        Commitment storage c = _getCommitment(commitmentId);
        require(!c.cancelled, "MilestoneEscrow: commitment is cancelled");
        Milestone storage m = _getMilestone(c, milestoneIndex);
        require(m.attested, "MilestoneEscrow: milestone not attested");
        require(!m.released, "MilestoneEscrow: milestone already released");

        // Effects before interaction.
        m.released = true;
        c.releasedAmount += m.amount;

        bool ok = ITRC20(c.token).transfer(m.recipient, m.amount);
        require(ok, "MilestoneEscrow: TRC-20 transfer failed");

        emit MilestoneReleased(commitmentId, milestoneIndex, m.recipient, m.amount);
    }

    /// @notice Cancel a commitment and refund any not-yet-attested milestones
    ///         back to the depositor.
    /// @dev Only the depositor or the owner can cancel. Milestones that are
    ///      already attested (verified as met) but not yet released are
    ///      intentionally NOT refunded here — a cancellation must not be usable
    ///      to claw back funds a community has already been confirmed to be
    ///      owed. Call `releaseMilestone` for those first if the commitment
    ///      needs to be wound down; only genuinely unmet milestones come back.
    function cancelCommitment(uint256 commitmentId) external nonReentrant {
        Commitment storage c = _getCommitment(commitmentId);
        require(msg.sender == c.depositor || msg.sender == owner, "MilestoneEscrow: not authorized to cancel");
        require(!c.cancelled, "MilestoneEscrow: already cancelled");

        uint256 refund = 0;
        for (uint256 i = 0; i < c.milestones.length; i++) {
            Milestone storage m = c.milestones[i];
            if (!m.released && !m.attested) {
                refund += m.amount;
                m.released = true; // settled as refunded, can never be released later
            }
        }
        c.cancelled = true;

        if (refund > 0) {
            bool ok = ITRC20(c.token).transfer(c.depositor, refund);
            require(ok, "MilestoneEscrow: refund transfer failed");
        }

        emit CommitmentCancelled(commitmentId, refund);
    }

    // ---------------------------------------------------------------
    // Views — read-only, used by the frontend Dashboard to render the
    // same fundedMilestones/totalMilestones shape already in riskModel.ts.
    // ---------------------------------------------------------------
    function commitmentCount() external view returns (uint256) {
        return _commitments.length;
    }

    function getCommitment(uint256 commitmentId)
        external
        view
        returns (
            bytes32 communityId,
            address token,
            address depositor,
            uint256 totalAmount,
            uint256 releasedAmount,
            bool cancelled,
            uint256 milestoneCount
        )
    {
        Commitment storage c = _getCommitment(commitmentId);
        return (c.communityId, c.token, c.depositor, c.totalAmount, c.releasedAmount, c.cancelled, c.milestones.length);
    }

    function getMilestone(uint256 commitmentId, uint256 milestoneIndex)
        external
        view
        returns (
            uint256 amount,
            string memory description,
            bool attested,
            bool released,
            address recipient
        )
    {
        Commitment storage c = _getCommitment(commitmentId);
        Milestone storage m = _getMilestone(c, milestoneIndex);
        return (m.amount, m.description, m.attested, m.released, m.recipient);
    }

    /// @notice Fraction of a commitment released so far, expressed in basis points (0–10000).
    /// @dev Convenience view mirroring riskModel.ts's fundedMilestones/totalMilestones ratio,
    ///      but computed from actual escrowed value rather than a milestone count, since
    ///      milestone tranches are not assumed to be equal-sized.
    function releasedBasisPoints(uint256 commitmentId) external view returns (uint256) {
        Commitment storage c = _getCommitment(commitmentId);
        if (c.totalAmount == 0) return 0;
        return (c.releasedAmount * 10000) / c.totalAmount;
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------
    function _getCommitment(uint256 commitmentId) internal view returns (Commitment storage) {
        require(commitmentId < _commitments.length, "MilestoneEscrow: invalid commitment id");
        return _commitments[commitmentId];
    }

    function _getMilestone(Commitment storage c, uint256 milestoneIndex) internal view returns (Milestone storage) {
        require(milestoneIndex < c.milestones.length, "MilestoneEscrow: invalid milestone index");
        return c.milestones[milestoneIndex];
    }
}
