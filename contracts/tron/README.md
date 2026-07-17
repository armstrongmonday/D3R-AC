# TRON Contracts

## Current status

Contract source is now committed. Three contracts, dependency-free
(no OpenZeppelin import — see each file's header comment for why),
compiled clean against solc 0.8.20 with the optimizer on:

- **`D3RACToken.sol`** — the TRC-20 relief-fund token. Implements the
  full standard surface, including the minimal slice the frontend
  (`frontend/src/lib/tronAdapter.ts`) already calls against
  (`balanceOf`, `decimals`, `symbol`, `transfer`), plus `approve` /
  `transferFrom` / `allowance` and an owner-gated `mint`/`setMinter` so a
  `DisbursementController` (or a treasury process) can be authorized to
  mint without opening minting to anyone.
- **`IdentityRegistry.sol`** — the wallet/identity layer. An admin
  designates verifiers, who verify recipient wallets (communities / NGO
  coordinators) with a human-readable label. This is the "who is allowed
  to receive relief funds at all" gate, separate from the milestone logic
  below.
- **`DisbursementController.sol`** — the milestone-release logic this
  file previously described as still-needed. A commitment is created for
  a recipient the `IdentityRegistry` has verified, split into milestones.
  Each milestone needs an `attester`-role attestation before its funds
  can be released; release itself is permissionless once attested (the
  attestation is the real gate, not who submits the transaction). Every
  state change — commitment created, milestone attested, milestone
  released, commitment cancelled — is an event.

This is **not deployed or audited**. See Known limitations below and
[`docs/deployment-guide.md`](../../docs/deployment-guide.md) before
targeting even testnet with anything resembling real funds.

## How the interface maps to what the frontend expects

The frontend (`frontend/src/lib/tronAdapter.ts`) is written against a
standard **TRC-20** token interface for reading balances and moving
funds:

```solidity
function balanceOf(address _owner) external view returns (uint256 balance);
function decimals() external view returns (uint8);
function symbol() external view returns (string);
function transfer(address _to, uint256 _value) external returns (bool);
```

`D3RACToken.sol` implements exactly this (plus the rest of standard
TRC-20), so the existing frontend adapter works against it unmodified —
just point `VITE_TRON_NETWORK` / the disbursement console's token-address
field at wherever it gets deployed.

## Design decisions worth knowing before you read the code

- **Attestation trust model**: `DisbursementController` doesn't decide
  *how* a milestone is verified — that's deliberately left to whoever
  holds attester status (set via `setAttester`), per
  [`docs/risk-model.md`](../../docs/risk-model.md)'s note that this is
  "deployment-specific." Start with a small multisig as the attester,
  not a single EOA.
- **Funds aren't pulled automatically**: `createCommitment` only records
  a schedule; it doesn't transfer tokens into the contract.
  `releaseMilestone` checks the contract's own token balance and reverts
  rather than partially paying, so the contract needs to actually hold
  (or be funded with) enough of the token before milestones can release.
- **Cancellation doesn't sweep funds**: `cancelCommitment` stops future
  releases but leaves already-deposited, unreleased tokens in the
  contract rather than silently redirecting them — that's left as a
  separate, auditable admin action.

## Known limitations

- **No professional security audit has been performed.** Do not deploy
  to mainnet with real funds without both an implementation review and a
  professional audit first — see
  [`docs/deployment-guide.md`](../../docs/deployment-guide.md).
- **Not yet deployed to any network** (Shasta, Nile, or mainnet). No
  deployed address exists to point the frontend at yet.
- **No test suite yet** — TronBox tests covering the milestone lifecycle
  (including failure paths: zero-amount, unauthorized caller, insufficient
  balance, double-release, double-attestation) still need to be written
  before testnet deployment, per the checklist in
  [`docs/deployment-guide.md`](../../docs/deployment-guide.md).
- `admin` / `owner` / `verifiers` / `attesters` are single-key roles as
  written. Multisig-ify before mainnet, per the deployment guide's
  security checklist.

## Testnets

Development and testing should target:

- **Shasta** — https://shasta.tronscan.org/
- **Nile** — https://nile.tronscan.org/

Do not target TRON mainnet until the checklist in
[`docs/deployment-guide.md`](../../docs/deployment-guide.md) is
satisfied.
