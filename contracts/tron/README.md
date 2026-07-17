# TRON Contracts

## Current status

**`MilestoneEscrow.sol` is implemented and logic-tested, not yet deployed or
audited.** It implements the milestone-based disbursement design this file
previously only described as a gap. Read the whole status section below
before treating this as ready for real funds — it isn't yet.

## What's implemented

`MilestoneEscrow.sol` is a TRC-20-based escrow that:

- **Locks funds per community** into a `Commitment`, split into `Milestone`
  tranches (`createCommitment`) — the depositor `approve()`s the escrow,
  then the escrow `transferFrom`s the total in.
- **Requires attestation before release** — an authorized `attestor`
  address confirms a milestone's real-world condition was met
  (`attestMilestone`) before anyone can trigger `releaseMilestone`. These
  are two separate calls/events on purpose: verification and disbursement
  are independently auditable.
- **Fixes the recipient at creation time** — attestation can never redirect
  where funds go; only the address locked in when the commitment was
  created can receive a given milestone's payout.
- **Protects attested-but-unreleased funds from clawback** —
  `cancelCommitment` only refunds milestones that were never attested. A
  cancellation cannot be used to take back funds a community has already
  been confirmed to be owed.
- **Owner + attestor roles**, an emergency `pause()` (blocks new
  commitments/releases, but cancellation still works so depositors are
  never trapped), and a reentrancy guard on the two functions that move
  tokens out (`releaseMilestone`, `cancelCommitment`).
- **Emits an event for every state transition** (created, attested,
  released, cancelled, role/pause changes) — the auditability the main
  README's "transparent fund release" claim depends on.

Every function above maps directly onto the frontend's `Community` shape in
`frontend/src/lib/riskModel.ts` (`fundedMilestones` / `totalMilestones`) —
wiring the Dashboard/Disburse pages to this contract instead of the plain
TRC-20 `transfer` currently in `tronAdapter.ts` is the natural next step,
not a redesign.

## Testing

- **17 tests, currently passing**, verifying fund-locking correctness,
  attestation/release ordering, access control on every admin/attestor
  function, refund-only-of-unattested-milestones on cancellation, and pause
  behavior. These ran on Hardhat's in-memory EVM rather than a live TVM
  node — see `../../hardhat-tests/README.md` for exactly what that does and
  doesn't prove for a TRON deployment.
- **`test/milestoneEscrow.test.js`** in this directory is the TronBox-native
  port of the same test cases, for running against a real TVM node (TRE via
  Docker, or Shasta/Nile) — see the file header for the exact command. It
  has not been executed against a live node yet; treat it as ready-to-run
  scaffolding until you've run it yourself.

## What's still needed before any mainnet use

- **Run the TronBox test suite against a real TVM node** (TRE or
  Shasta/Nile) — the Hardhat suite above verifies Solidity-level logic, not
  TRON-specific behavior (gas/energy costs, TronLink-signed transactions,
  non-standard TRC-20 `transfer` return values on whatever real token you
  disburse).
- **A professional security audit.** Nothing here has been audited — see
  the main README's Security section and `../../docs/deployment-guide.md`.
- **A decision on the attestor trust model.** This version uses a single
  global attestor role (any address you add can attest any commitment).
  That's an intentional v1 simplification, not a final design — moving to
  a multisig or per-community attestor set is a natural v2 step before
  trusting this with real relief funds, and is flagged explicitly rather
  than left implicit.
- **Testing against the real TRC-20 token(s)** you intend to disburse —
  some TRC-20s on TRON deviate from strict boolean-return `transfer`
  semantics; this contract's `require(ok, ...)` checks assume standard
  behavior.

## Deploying

See `../../docs/deployment-guide.md` for the full process. In short:

```bash
cd contracts/tron
tronbox compile
tronbox migrate --network shasta   # testnet first, always
```

## Testnets

Development and testing should target:

- **Shasta** — https://shasta.tronscan.org/
- **Nile** — https://nile.tronscan.org/

Do not target TRON mainnet until the checklist in
`../../docs/deployment-guide.md` is satisfied.
