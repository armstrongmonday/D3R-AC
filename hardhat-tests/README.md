# Why a Hardhat test harness in a TRON project?

`MilestoneEscrow.sol` will deploy and run on TRON (TVM), via TronBox — see
[`../contracts/tron/tronbox-config.js`](../contracts/tron/tronbox-config.js)
and [`../contracts/tron/test/milestoneEscrow.test.js`](../contracts/tron/test/milestoneEscrow.test.js)
for the real deployment/testing path.

This directory exists because **running TronBox's own tests requires a live
TVM node** (TRE via Docker, or a Shasta/Nile testnet connection) — something
not available in the environment this contract was first built and verified
in. TVM is Solidity/EVM-compatible for everything this contract actually
uses (no TRON-specific precompiles, no energy/bandwidth-dependent logic) —
so Hardhat's in-memory EVM is a valid way to execute and verify the
contract's *logic* (access control, ordering, refund rules, reentrancy
safety) before you ever touch a TRON node.

**What this proves:** the 17 tests in `MilestoneEscrow.test.js` all pass —
happy-path fund locking, attestation-then-release ordering, double-release
prevention, refund-only-of-unattested-milestones on cancellation, access
control on every admin/attestor function, and pause behavior.

**What this does NOT prove:** anything TRON-specific — actual gas/energy
costs, TronLink transaction signing, TRC-20 tokens with non-standard
`transfer` return values (some TRC-20s on TRON don't strictly follow the
boolean-return convention — worth checking against whatever real token you
disburse). Run the TronBox test suite against a real TVM node before any
testnet deployment; treat this Hardhat suite as a fast pre-check, not a
substitute.

## Running this

```bash
npm install
npm run compile   # compiles MilestoneEscrow.sol + MockTRC20.sol with solc 0.8.20
npm test          # runs the 17 tests against Hardhat's in-memory EVM
```

`artifacts-raw/` contains the pre-compiled ABI + bytecode used by the tests
directly (bypassing Hardhat's own compiler download step, which needs
network access to `binaries.soliditylang.org` — not available in every
sandboxed environment). If you have normal internet access, you can ignore
this and just run `npx hardhat test` after `npx hardhat compile` the usual
way.
