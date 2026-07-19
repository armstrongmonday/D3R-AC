const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deploy } = require("./helpers");

describe("D3RACHub", function () {
  let admin, stranger, recipient, minted;
  let token, registry, controller, riskRegistry, fundingRegistry, hub;

  const COMMUNITY_ID = ethers.encodeBytes32String("ohafia");
  const SCALE = 10n ** 18n;

  beforeEach(async function () {
    [admin, stranger, recipient, minted] = await ethers.getSigners();

    token = await deploy("D3RACToken", admin, 1_000_000, admin.address);
    registry = await deploy("IdentityRegistry", admin, admin.address);
    controller = await deploy("DisbursementController", admin, await registry.getAddress(), admin.address);
    riskRegistry = await deploy("RiskRegistry", admin, (SCALE * 35n) / 100n, admin.address); // theta = 0.35
    fundingRegistry = await deploy("FundingRequestRegistry", admin, admin.address);

    hub = await deploy(
      "D3RACHub",
      admin,
      admin.address,
      await token.getAddress(),
      await registry.getAddress(),
      await controller.getAddress(),
      await riskRegistry.getAddress(),
      await fundingRegistry.getAddress()
    );

    // Wire the Hub in. Different grant mechanisms are needed for
    // different functions, and mixing them up is exactly the kind of
    // mistake this test file exists to catch:
    //   - IdentityRegistry.verifyRecipient, DisbursementController.
    //     attestMilestone, RiskRegistry.updateRisk, and
    //     FundingRequestRegistry.openRequest are role-gated (verifier /
    //     attester / dataFeeder / proposer mappings), so the Hub can be
    //     ADDED alongside the existing admin/owner.
    //   - DisbursementController.createCommitment/cancelCommitment and
    //     RiskRegistry.registerCommunity are gated by a single admin/
    //     owner address, not a role mapping — so the Hub must actually
    //     BECOME that admin/owner via transferAdmin/transferOwnership,
    //     which REPLACES (not adds to) the previous holder's access.
    await registry.setVerifier(await hub.getAddress(), true);
    await controller.setAttester(await hub.getAddress(), true);
    await controller.transferAdmin(await hub.getAddress());
    await token.setMinter(await hub.getAddress(), true);
    await riskRegistry.addDataFeeder(await hub.getAddress());
    await riskRegistry.transferOwnership(await hub.getAddress());
    await fundingRegistry.addProposer(await hub.getAddress());
  });

  describe("deployment", function () {
    it("rejects a zero address for admin or any of the three core modules", async function () {
      const { deploy: d } = require("./helpers");
      await expect(
        d("D3RACHub", admin, ethers.ZeroAddress, await token.getAddress(), await registry.getAddress(), await controller.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("D3RACHub: admin is zero address");
      await expect(
        d("D3RACHub", admin, admin.address, ethers.ZeroAddress, await registry.getAddress(), await controller.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWith("D3RACHub: token is zero address");
    });

    it("accepts a zero address for riskRegistry and fundingRequestRegistry -- they're optional", async function () {
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      expect(await bareHub.riskRegistry()).to.equal(ethers.ZeroAddress);
      expect(await bareHub.fundingRequestRegistry()).to.equal(ethers.ZeroAddress);
    });

    it("records the initial admin and module addresses", async function () {
      expect(await hub.admin()).to.equal(admin.address);
      expect(await hub.token()).to.equal(await token.getAddress());
      expect(await hub.identityRegistry()).to.equal(await registry.getAddress());
      expect(await hub.disbursementController()).to.equal(await controller.getAddress());
      expect(await hub.riskRegistry()).to.equal(await riskRegistry.getAddress());
      expect(await hub.fundingRequestRegistry()).to.equal(await fundingRegistry.getAddress());
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

    it("allows unwiring riskRegistry/fundingRequestRegistry back to the zero address", async function () {
      await hub.setRiskRegistry(ethers.ZeroAddress);
      expect(await hub.riskRegistry()).to.equal(ethers.ZeroAddress);
      await hub.setFundingRequestRegistry(ethers.ZeroAddress);
      expect(await hub.fundingRequestRegistry()).to.equal(ethers.ZeroAddress);
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

    it("blocks verifyRecipient, createCommitment, attestMilestone, mintTokens, registerCommunity, updateRisk, and openFundingRequest while paused", async function () {
      await riskRegistry.connect(admin); // no-op, keep admin context explicit
      await hub.pause();
      await expect(hub.verifyRecipient(recipient.address, "Test Coalition")).to.be.revertedWith("D3RACHub: paused");
      await expect(
        hub.createCommitment(recipient.address, await token.getAddress(), "Test Coalition", ["M"], [1000])
      ).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.attestMilestone(0, 0)).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.mintTokens(minted.address, 100)).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.registerCommunity(COMMUNITY_ID, "Ohafia", "Abia State")).to.be.revertedWith("D3RACHub: paused");
      await expect(hub.updateRisk(COMMUNITY_ID, SCALE, SCALE, SCALE)).to.be.revertedWith("D3RACHub: paused");
      await expect(
        hub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x")
      ).to.be.revertedWith("D3RACHub: paused");
    });

    it("does NOT block cancelCommitment, closeFundingRequest, or admin/module management while paused", async function () {
      await hub.verifyRecipient(recipient.address, "Test Coalition");
      await hub.createCommitment(recipient.address, await token.getAddress(), "Test Coalition", ["M"], [1000]);
      await hub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x");

      await hub.pause();
      await expect(hub.cancelCommitment(0)).to.not.be.reverted;
      await expect(hub.closeFundingRequest(0)).to.not.be.reverted;
      await expect(hub.setToken(await token.getAddress())).to.not.be.reverted;
      await expect(hub.transferAdmin(admin.address)).to.not.be.reverted; // no-op transfer, still allowed
    });
  });

  describe("orchestration: token / identity / disbursement (requires the Hub to hold roles)", function () {
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
        await controller.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
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

  describe("orchestration: risk registry", function () {
    it("registerCommunity forwards to RiskRegistry (requires the Hub to be RiskRegistry's owner)", async function () {
      await hub.registerCommunity(COMMUNITY_ID, "Ohafia", "Abia State");
      expect(await riskRegistry.communityCount()).to.equal(1);
    });

    it("reverts if the Hub has NOT been made RiskRegistry's owner", async function () {
      const bareRisk = await deploy("RiskRegistry", admin, SCALE / 2n, await hub.getAddress()); // feeder granted, owner NOT transferred
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        await bareRisk.getAddress(),
        ethers.ZeroAddress
      );
      await expect(bareHub.registerCommunity(COMMUNITY_ID, "X", "Y")).to.be.revertedWith(
        "RiskRegistry: caller is not owner"
      );
    });

    it("updateRisk forwards to RiskRegistry and actually recomputes the score (data-feeder status is enough, no ownership transfer needed)", async function () {
      await hub.registerCommunity(COMMUNITY_ID, "Ohafia", "Abia State");
      await hub.updateRisk(COMMUNITY_ID, SCALE, SCALE, SCALE); // H=E=V=1.0 -> R=1.0
      expect(await riskRegistry.riskScore(COMMUNITY_ID)).to.equal(SCALE);
    });

    it("reverts registerCommunity/updateRisk when riskRegistry is not set", async function () {
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      await expect(bareHub.registerCommunity(COMMUNITY_ID, "X", "Y")).to.be.revertedWith(
        "D3RACHub: riskRegistry not set"
      );
      await expect(bareHub.updateRisk(COMMUNITY_ID, SCALE, SCALE, SCALE)).to.be.revertedWith(
        "D3RACHub: riskRegistry not set"
      );
    });
  });

  describe("orchestration: funding request registry", function () {
    it("openFundingRequest forwards to FundingRequestRegistry (requires the Hub to hold proposer status)", async function () {
      await expect(hub.openFundingRequest(COMMUNITY_ID, 1000, "Shelter rebuild", "ipfs://report"))
        .to.emit(fundingRegistry, "RequestOpened");
      expect(await fundingRegistry.requestCount()).to.equal(1);
    });

    it("reverts if the Hub has NOT been granted proposer status", async function () {
      const bareFunding = await deploy("FundingRequestRegistry", admin, admin.address); // Hub never added as proposer
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        ethers.ZeroAddress,
        await bareFunding.getAddress()
      );
      await expect(
        bareHub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x")
      ).to.be.revertedWith("FundingRequestRegistry: caller is not an authorized proposer");
    });

    it("closeFundingRequest succeeds for a request the Hub itself opened", async function () {
      await hub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x");
      await expect(hub.closeFundingRequest(0)).to.not.be.reverted;
      const r = await fundingRegistry.getRequest(0);
      expect(r.status).to.equal(3n); // Status.Closed
    });

    it("reverts openFundingRequest/closeFundingRequest when fundingRequestRegistry is not set", async function () {
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      await expect(
        bareHub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x")
      ).to.be.revertedWith("D3RACHub: fundingRequestRegistry not set");
      await expect(bareHub.closeFundingRequest(0)).to.be.revertedWith("D3RACHub: fundingRequestRegistry not set");
    });
  });

  describe("systemStatus", function () {
    it("aggregates all five module addresses, paused state, supply, commitment count, community count, and request count in one call", async function () {
      await hub.verifyRecipient(recipient.address, "Ohafia Relief Coalition");
      await hub.createCommitment(recipient.address, await token.getAddress(), "Ohafia Relief Coalition", ["M"], [1000]);
      await hub.registerCommunity(COMMUNITY_ID, "Ohafia", "Abia State");
      await hub.openFundingRequest(COMMUNITY_ID, 1000, "desc", "ipfs://x");

      const status = await hub.systemStatus();
      expect(status.tokenAddress).to.equal(await token.getAddress());
      expect(status.identityRegistryAddress).to.equal(await registry.getAddress());
      expect(status.disbursementControllerAddress).to.equal(await controller.getAddress());
      expect(status.riskRegistryAddress).to.equal(await riskRegistry.getAddress());
      expect(status.fundingRequestRegistryAddress).to.equal(await fundingRegistry.getAddress());
      expect(status.isPaused).to.equal(false);
      expect(status.tokenTotalSupply).to.equal(await token.totalSupply());
      expect(status.totalCommitments).to.equal(1);
      expect(status.totalCommunities).to.equal(1);
      expect(status.totalFundingRequests).to.equal(1);
    });

    it("reports zero counts for risk/funding when those modules aren't set, without reverting", async function () {
      const bareHub = await deploy(
        "D3RACHub",
        admin,
        admin.address,
        await token.getAddress(),
        await registry.getAddress(),
        await controller.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress
      );
      const status = await bareHub.systemStatus();
      expect(status.riskRegistryAddress).to.equal(ethers.ZeroAddress);
      expect(status.fundingRequestRegistryAddress).to.equal(ethers.ZeroAddress);
      expect(status.totalCommunities).to.equal(0);
      expect(status.totalFundingRequests).to.equal(0);
    });
  });
});
