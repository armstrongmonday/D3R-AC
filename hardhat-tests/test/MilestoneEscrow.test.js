const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

// Loaded from artifacts-raw/, produced by compile2.js using the local
// `solc` 0.8.20 package directly — bypasses Hardhat's own compiler
// downloader (which needs a network host not available in this sandbox)
// while still testing the exact bytecode that solc 0.8.20 produces.
function loadArtifact(name) {
  const p = path.join(__dirname, "..", "artifacts-raw", `${name}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

describe("MilestoneEscrow (D3R·AC)", function () {
  let escrow, token;
  let owner, attestor, depositor, recipient1, recipient2, stranger;

  const communityId = ethers.encodeBytes32String("c3"); // Maiduguri Corridor, matches riskModel.ts

  beforeEach(async function () {
    [owner, attestor, depositor, recipient1, recipient2, stranger] = await ethers.getSigners();

    const tokenArtifact = loadArtifact("MockTRC20");
    const TokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, owner);
    token = await TokenFactory.deploy(ethers.parseUnits("1000000", 6));
    await token.waitForDeployment();

    const escrowArtifact = loadArtifact("MilestoneEscrow");
    const EscrowFactory = new ethers.ContractFactory(escrowArtifact.abi, escrowArtifact.bytecode, owner);
    escrow = await EscrowFactory.connect(owner).deploy(attestor.address);
    await escrow.waitForDeployment();

    // Fund the depositor and approve the escrow
    await token.transfer(depositor.address, ethers.parseUnits("10000", 6));
    await token.connect(depositor).approve(await escrow.getAddress(), ethers.parseUnits("10000", 6));
  });

  describe("createCommitment", function () {
    it("locks the correct total and emits CommitmentCreated", async function () {
      const amounts = [ethers.parseUnits("100", 6), ethers.parseUnits("200", 6)];
      const tx = await escrow.connect(depositor).createCommitment(
        communityId,
        await token.getAddress(),
        amounts,
        ["Shelter kits phase 1", "Shelter kits phase 2"],
        [recipient1.address, recipient2.address]
      );
      await expect(tx).to.emit(escrow, "CommitmentCreated");

      const c = await escrow.getCommitment(0);
      expect(c.totalAmount).to.equal(ethers.parseUnits("300", 6));
      expect(c.depositor).to.equal(depositor.address);
      expect(await token.balanceOf(await escrow.getAddress())).to.equal(ethers.parseUnits("300", 6));
    });

    it("rejects mismatched array lengths", async function () {
      await expect(
        escrow.connect(depositor).createCommitment(
          communityId,
          await token.getAddress(),
          [ethers.parseUnits("100", 6)],
          ["only one description", "extra"],
          [recipient1.address]
        )
      ).to.be.revertedWith("MilestoneEscrow: array length mismatch");
    });

    it("rejects zero-amount milestones", async function () {
      await expect(
        escrow.connect(depositor).createCommitment(
          communityId,
          await token.getAddress(),
          [0],
          ["bad"],
          [recipient1.address]
        )
      ).to.be.revertedWith("MilestoneEscrow: milestone amount must be > 0");
    });

    it("fails if depositor has not approved enough allowance", async function () {
      // Fund `stranger` with tokens but never call approve() —
      // this isolates the allowance check from the balance check.
      await token.transfer(stranger.address, ethers.parseUnits("50", 6));
      await expect(
        escrow.connect(stranger).createCommitment(
          communityId,
          await token.getAddress(),
          [ethers.parseUnits("50", 6)],
          ["no allowance"],
          [recipient1.address]
        )
      ).to.be.revertedWith("insufficient allowance");
    });
  });

  describe("attestation and release ordering", function () {
    beforeEach(async function () {
      await escrow.connect(depositor).createCommitment(
        communityId,
        await token.getAddress(),
        [ethers.parseUnits("100", 6), ethers.parseUnits("200", 6)],
        ["phase 1", "phase 2"],
        [recipient1.address, recipient2.address]
      );
    });

    it("blocks release before attestation", async function () {
      await expect(escrow.releaseMilestone(0, 0)).to.be.revertedWith(
        "MilestoneEscrow: milestone not attested"
      );
    });

    it("blocks non-attestors from attesting", async function () {
      await expect(
        escrow.connect(stranger).attestMilestone(0, 0)
      ).to.be.revertedWith("MilestoneEscrow: caller is not an attestor");
    });

    it("allows release only after the correct milestone is attested, funds go to fixed recipient", async function () {
      await escrow.connect(attestor).attestMilestone(0, 0);
      const before = await token.balanceOf(recipient1.address);

      const tx = await escrow.releaseMilestone(0, 0);
      await expect(tx)
        .to.emit(escrow, "MilestoneReleased")
        .withArgs(0, 0, recipient1.address, ethers.parseUnits("100", 6));

      const after = await token.balanceOf(recipient1.address);
      expect(after - before).to.equal(ethers.parseUnits("100", 6));

      // Milestone 1 (phase 2) must remain untouched
      const m1 = await escrow.getMilestone(0, 1);
      expect(m1.released).to.equal(false);
    });

    it("prevents double release of the same milestone", async function () {
      await escrow.connect(attestor).attestMilestone(0, 0);
      await escrow.releaseMilestone(0, 0);
      await expect(escrow.releaseMilestone(0, 0)).to.be.revertedWith(
        "MilestoneEscrow: milestone already released"
      );
    });

    it("tracks releasedBasisPoints correctly across partial release", async function () {
      await escrow.connect(attestor).attestMilestone(0, 0);
      await escrow.releaseMilestone(0, 0);
      // 100 released out of 300 total = 3333 bps
      expect(await escrow.releasedBasisPoints(0)).to.equal(3333);
    });
  });

  describe("cancellation", function () {
    beforeEach(async function () {
      await escrow.connect(depositor).createCommitment(
        communityId,
        await token.getAddress(),
        [ethers.parseUnits("100", 6), ethers.parseUnits("200", 6)],
        ["phase 1", "phase 2"],
        [recipient1.address, recipient2.address]
      );
    });

    it("refunds only unattested milestones to the depositor", async function () {
      await escrow.connect(attestor).attestMilestone(0, 0); // phase 1 attested, not released
      const before = await token.balanceOf(depositor.address);

      const tx = await escrow.connect(depositor).cancelCommitment(0);
      // Only phase 2 (200) should be refunded — phase 1 is attested and protected
      await expect(tx).to.emit(escrow, "CommitmentCancelled").withArgs(0, ethers.parseUnits("200", 6));

      const after = await token.balanceOf(depositor.address);
      expect(after - before).to.equal(ethers.parseUnits("200", 6));
    });

    it("does not allow a stranger to cancel", async function () {
      await expect(escrow.connect(stranger).cancelCommitment(0)).to.be.revertedWith(
        "MilestoneEscrow: not authorized to cancel"
      );
    });

    it("allows the owner (not just depositor) to cancel", async function () {
      await expect(escrow.connect(owner).cancelCommitment(0)).to.not.be.reverted;
    });

    it("blocks further attestation/release after cancellation", async function () {
      await escrow.connect(depositor).cancelCommitment(0);
      await expect(escrow.connect(attestor).attestMilestone(0, 1)).to.be.revertedWith(
        "MilestoneEscrow: commitment is cancelled"
      );
    });
  });

  describe("admin controls", function () {
    it("only owner can add/remove attestors", async function () {
      await expect(escrow.connect(stranger).addAttestor(stranger.address)).to.be.revertedWith(
        "MilestoneEscrow: caller is not owner"
      );
      await escrow.connect(owner).addAttestor(stranger.address);
      expect(await escrow.attestors(stranger.address)).to.equal(true);

      await escrow.connect(owner).removeAttestor(stranger.address);
      expect(await escrow.attestors(stranger.address)).to.equal(false);
    });

    it("pausing blocks new commitments and releases but not cancellation", async function () {
      await escrow.connect(depositor).createCommitment(
        communityId,
        await token.getAddress(),
        [ethers.parseUnits("50", 6)],
        ["p1"],
        [recipient1.address]
      );
      await escrow.connect(owner).pause();

      await expect(
        escrow.connect(depositor).createCommitment(
          communityId,
          await token.getAddress(),
          [ethers.parseUnits("50", 6)],
          ["p1"],
          [recipient1.address]
        )
      ).to.be.revertedWith("MilestoneEscrow: contract is paused");

      // Cancellation must still work while paused so depositors are never trapped
      await expect(escrow.connect(depositor).cancelCommitment(0)).to.not.be.reverted;
    });

    it("only owner can pause/unpause", async function () {
      await expect(escrow.connect(stranger).pause()).to.be.revertedWith(
        "MilestoneEscrow: caller is not owner"
      );
    });
  });

  describe("multiple independent commitments", function () {
    it("keeps separate commitments fully isolated", async function () {
      await escrow.connect(depositor).createCommitment(
        communityId,
        await token.getAddress(),
        [ethers.parseUnits("100", 6)],
        ["c3 phase 1"],
        [recipient1.address]
      );
      await escrow.connect(depositor).createCommitment(
        ethers.encodeBytes32String("c4"), // Port Harcourt Delta
        await token.getAddress(),
        [ethers.parseUnits("50", 6)],
        ["c4 phase 1"],
        [recipient2.address]
      );

      await escrow.connect(attestor).attestMilestone(1, 0);
      await escrow.releaseMilestone(1, 0);

      // Commitment 0 must be entirely unaffected
      const c0 = await escrow.getCommitment(0);
      expect(c0.releasedAmount).to.equal(0);
      const c1 = await escrow.getCommitment(1);
      expect(c1.releasedAmount).to.equal(ethers.parseUnits("50", 6));
    });
  });
});
