const MilestoneEscrow = artifacts.require("MilestoneEscrow");

// The initial attestor address is read from an env var so the same
// migration script works across shasta/nile/mainnet without editing code —
// set INITIAL_ATTESTOR_ADDRESS before running `tronbox migrate`.
//
// If unset, the deployer address itself becomes the initial attestor
// (fine for early testnet iteration; replace with TAAD's actual
// verification wallet, or a dedicated attestor key, before any real funds
// move through this contract).
module.exports = function (deployer, network, accounts) {
  const initialAttestor = process.env.INITIAL_ATTESTOR_ADDRESS || accounts[0];
  console.log(`Deploying MilestoneEscrow on ${network} with initial attestor: ${initialAttestor}`);
  deployer.deploy(MilestoneEscrow, initialAttestor);
};
