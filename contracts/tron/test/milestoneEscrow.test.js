// TronBox/TVM-native port of the executed test suite in
// hardhat-tests/MilestoneEscrow.test.js (see that file's header for why
// both exist). Run this against a real TVM node to confirm TRON-specific
// behavior (fee model, energy/bandwidth, TronLink-signed transactions)
// matches the Solidity-level guarantees already verified there.
//
// Requires a local TRE (TRON Real Environment) node:
//   docker run -it --rm -p 9090:9090 tronbox/tre
// then, from contracts/tron/:
//   tronbox test --network development
//
// This suite was NOT executed in the sandbox that produced this repo
// state — there is no TVM node available there. Treat it as ready-to-run
// scaffolding, not as already-passing, until you've run it yourself
// against TRE or Shasta/Nile.

const MilestoneEscrow = artifacts.require("MilestoneEscrow");
const MockTRC20 = artifacts.require("MockTRC20");

contract("MilestoneEscrow (D3R·AC)", (accounts) => {
  const [owner, attestor, depositor, recipient1, recipient2, stranger] = accounts;
  const communityId = tronWeb.utils.crypto.byte32ToHexString
    ? tronWeb.utils.crypto.byte32ToHexString("c3")
    : "0x" + Buffer.from("c3").toString("hex").padEnd(64, "0");

  let escrow;
  let token;

  beforeEach(async () => {
    token = await MockTRC20.new("1000000000000", { from: owner }); // 1,000,000 * 1e6
    escrow = await MilestoneEscrow.new(attestor, { from: owner });

    await token.transfer(depositor, "10000000000", { from: owner }); // 10,000 * 1e6
    await token.approve(escrow.address, "10000000000", { from: depositor });
  });

  it("locks the correct total on createCommitment", async () => {
    await escrow.createCommitment(
      communityId,
      token.address,
      ["100000000", "200000000"], // 100, 200 (1e6 decimals)
      ["Shelter kits phase 1", "Shelter kits phase 2"],
      [recipient1, recipient2],
      { from: depositor }
    );

    const c = await escrow.getCommitment(0);
    assert.equal(c.totalAmount.toString(), "300000000");
    const escrowBalance = await token.balanceOf(escrow.address);
    assert.equal(escrowBalance.toString(), "300000000");
  });

  it("blocks release before attestation", async () => {
    await escrow.createCommitment(
      communityId,
      token.address,
      ["100000000"],
      ["phase 1"],
      [recipient1],
      { from: depositor }
    );

    try {
      await escrow.releaseMilestone(0, 0, { from: owner });
      assert.fail("expected revert");
    } catch (err) {
      assert.include(err.message, "not attested");
    }
  });

  it("releases funds to the fixed recipient only after attestation", async () => {
    await escrow.createCommitment(
      communityId,
      token.address,
      ["100000000"],
      ["phase 1"],
      [recipient1],
      { from: depositor }
    );

    await escrow.attestMilestone(0, 0, { from: attestor });
    const before = await token.balanceOf(recipient1);
    await escrow.releaseMilestone(0, 0, { from: owner });
    const after = await token.balanceOf(recipient1);

    assert.equal((after.sub ? after.sub(before) : after - before).toString(), "100000000");
  });

  it("refunds only unattested milestones on cancellation", async () => {
    await escrow.createCommitment(
      communityId,
      token.address,
      ["100000000", "200000000"],
      ["phase 1", "phase 2"],
      [recipient1, recipient2],
      { from: depositor }
    );
    await escrow.attestMilestone(0, 0, { from: attestor }); // phase 1 attested, not released

    const before = await token.balanceOf(depositor);
    await escrow.cancelCommitment(0, { from: depositor });
    const after = await token.balanceOf(depositor);

    // Only phase 2 (200) comes back — phase 1 is attested and protected.
    assert.equal((after.sub ? after.sub(before) : after - before).toString(), "200000000");
  });

  it("blocks non-attestors from attesting", async () => {
    await escrow.createCommitment(
      communityId,
      token.address,
      ["100000000"],
      ["phase 1"],
      [recipient1],
      { from: depositor }
    );
    try {
      await escrow.attestMilestone(0, 0, { from: stranger });
      assert.fail("expected revert");
    } catch (err) {
      assert.include(err.message, "not an attestor");
    }
  });
});
