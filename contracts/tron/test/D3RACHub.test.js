const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploy } = require("./helpers");

describe("D3RACHub", function () {
  let admin, stranger, recipient, minted;
  let token, registry, controller, hub;

  beforeEach(async function () {
    [admin, stranger, recipient, minted] = await ethers.getSigners();

    token = await deploy("D3RACToken", admin, 1_000_000, admin.address);
    registry = await deploy("IdentityRegistry", admin, admin.address);
    controller = await deploy("DisbursementController", admin, await registry.getAddress(), admin.address);
    hub = await deploy(
      "D3RACHub",
      admin,
      admin.address,
      await token.getAddress(),
      await registry.getAddress(),
      await controller.getAddress()
    );

    // Wire the Hub in. Two different grant mechanisms are needed here,
    // and mixing them up is exactly the kind of mistake this test file
    // exists to catch:
    //   - IdentityRegistry.verifyRecipient and
    //     DisbursementController.attestMilestone are role-gated
    //     (verifier / attester mappings), so the Hub can be ADDED
    //     alongside the existing admin.
    //   - DisbursementController.createCommitment/cancelCommitment are
    //     gated by a single `admin` address, not a role mapping — so the
    //     Hub must actually BECOME that admin via transferAdmin, which
    //     replaces (not adds to) the previous admin's access.
    await registry.setVerifier(await hub.getAddress(), true);
    await controller.setAttester(await hub.getAddress(), true);
    await controller.transferAdmin(await hub.getAddress());
    await token.setMinter(await hub.getAddress(), true);
  });

  describe("deployment", function () {
    it("rejects a zero address for admin or any module", async function () {
      const { deploy: d } = require("./helpers");
      await expect(
        d("D3RACHub", admin, ethers.ZeroAddress, await token.getAddress(), await registry.getAddress(), await controller.getAddress())
      ).to.be.revertedWith("D3RACHub: admin is zero address");
      await expect(
        d("D3RACHub", admin, admin.address, ethers.ZeroAddress, await registry.getAddress(), await controller.getAddress())
      ).to.be.revertedWith("D3RACHub: token is zero address");
    });

    it("records the initial admin and module addresses", async function () {
      expect(await hub.admin()).to.equal(admin.address);
      expect(await hub.token()).to.equal(await token.getAddress());
      expect(await hub.identityRegistry()).to.equal(await registry.getAddress());
      expect(await hub.disbursementController()).to.equal(await controller.getAddress());
      expect(await hub.paused()).to.equal(false);
    });
  });

  describe("module management", function () {
    it("only admin can update a module pointer", async function () {
      await expect(hub.connect(stranger).setToken(stranger.address)).to.be.revertedWith(
        "D3RACHub: caller is not admin"
      );
    });

    it("updates a module pointer and emits ModuleUpdated", async function () {
      const newToken = await deploy("D3RACToken", admin, 0, admin.address);
      await expect(hub.setToken(await newToken.getAddress())).to.emit(hub, "ModuleUpdated");
      expect(await hub.token()).to.equal(await newToken.getAddress());
    });

    it("only admin can transfer admin, and it takes effect immediately", async function () {
      await expect(hub.connect(stranger).transferAdmin(stranger.address)).to.be.revertedWith(
        "D3RACHub: caller is not admin"
      );
      await hub.transferAdmin(stranger.address);
      expect(await hub.admin()).to.equal(stranger.address);
      await expect(hub.pause()).to.be.revertedWith("D3RACHub: caller is not admin");
    });
  });

  describe("pause", function () {
    it("only admin can pause/unpause", async function () {
      await expect(hub.connect(stranger).pause()).to.be.revertedWith("D3RACHub: caller is not admin");
    });

    it("rejects double-pausing or unpausing when not paused", async function () {
      await hub.pause();
      await expect(hub.pause()).to.be.revertedWith("D3RACHub: already paused");
      await hub.unpause();
      await expect(hub.unpause()).to.be.revertedWith("D3RACHub: not paused");
    });

    it("blocks verifyRecipient, createCommitment, attestMilestone, and mintTokens while paused", async function () {
      await hub.pause();
      await expect(hub.verifyRecipient(recipient.address, "Test Coalition")).to.be.revertedWith(
        "D3RACHub: paused"
      );
      await expect(
        hub.createCommitment(recipient.address, await token.getAddress(), "Test Coalition", ["M"], [1000])
      ).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.attestMilestone(0, 0)).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.mintTokens(minted.address, 100)).to.be.revertedWith("D3RACHub: paused");
    });

    it("does NOT block cancelCommitment or admin/module management while paused", async function () {
      await hub.verifyRecipient(recipient.address, "Test Coalition");
      await hub.createCommitment(recipient.address, await token.getAddress(), "Test Coalition", ["M"], [1000]);

      await hub.pause();
      await expect(hub.cancelCommitment(0)).to.not.be.reverted;
      await expect(hub.setToken(await token.getAddress())).to.not.be.reverted;
      await expect(hub.transferAdmin(admin.address)).to.not.be.reverted; // no-op transfer, still allowed
    });
  });

  describe("orchestration (requires the Hub to hold roles on the underlying contracts)", function () {
    it("verifyRecipient forwards to IdentityRegistry and actually verifies", async function () {
      await hub.verifyRecipient(recipient.address, "Ohafia Relief Coalition");
      expect(await registry.isVerified(recipient.address)).to.equal(true);
    });

    it("reverts if the Hub has NOT been granted verifier status", async function () {
      const bareRegistry = await deploy("IdentityRegistry", admin, admin.address); // Hub never added as verifier here
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await bareRegistry.getAddress(),
        await controller.getAddress()
      );
      await expect(bareHub.verifyRecipient(recipient.address, "X")).to.be.revertedWith(
        "IdentityRegistry: caller is not a verifier"
      );
    });

    it("createCommitment + attestMilestone forward through to DisbursementController", async function () {
      await hub.verifyRecipient(recipient.address, "Ohafia Relief Coalition");
      await hub.createCommitment(recipient.address, await token.getAddress(), "Ohafia Relief Coalition", ["Water restored"], [1000]);
      await hub.attestMilestone(0, 0);
      const m = await controller.getMilestone(0, 0);
      expect(m.attested).to.equal(true);
    });

    it("transferring DisbursementController's admin to the Hub is exclusive, not additive — the original EOA loses direct createCommitment access", async function () {
      await expect(
        controller.connect(admin).createCommitment(
          recipient.address, await token.getAddress(), "X", ["M"], [1000]
        )
      ).to.be.revertedWith("DisbursementController: caller is not admin");
    });

    it("mintTokens forwards to D3RACToken and actually mints", async function () {
      const before = await token.balanceOf(minted.address);
      await hub.mintTokens(minted.address, 500);
      expect(await token.balanceOf(minted.address)).to.equal(before + 500n);
    });

    it("only admin can call orchestration functions", async function () {
      await expect(
        hub.connect(stranger).verifyRecipient(recipient.address, "X")
      ).to.be.revertedWith("D3RACHub: caller is not admin");
      await expect(hub.connect(stranger).mintTokens(stranger.address, 1)).to.be.revertedWith(
        "D3RACHub: caller is not admin"
      );
    });
  });

  describe("systemStatus", function () {
    it("aggregates module addresses, paused state, supply, and commitment count in one call", async function () {
      await hub.verifyRecipient(recipient.address, "Ohafia Relief Coalition");
      await hub.createCommitment(recipient.address, await token.getAddress(), "Ohafia Relief Coalition", ["M"], [1000]);

      const status = await hub.systemStatus();
      expect(status.tokenAddress).to.equal(await token.getAddress());
      expect(status.identityRegistryAddress).to.equal(await registry.getAddress());
      expect(status.disbursementControllerAddress).to.equal(await controller.getAddress());
      expect(status.isPaused).to.equal(false);
      expect(status.tokenTotalSupply).to.equal(await token.totalSupply());
      expect(status.totalCommitments).to.equal(1);
    });
  });
});
