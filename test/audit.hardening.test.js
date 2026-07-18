// Regression tests for the Shieldify hardening batch (see AUDIT-SHIELDIFY-RESPONSE.md):
// L-01 zero-share deposits, I-04 zap() deadline, I-05 previewRedeem bound,
// I-06 cached position key, I-07 self-recipient, I-08 constructor validation.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVaultFixture, deposit } = require("./helpers/setup");

const USDC = (n) => BigInt(n) * 10n ** 6n;
const VLT = (n) => BigInt(n) * 10n ** 18n;

describe("Shieldify hardening", () => {
  describe("L-01: zero-share deposits revert", () => {
    it("rejects a dust deposit that would add liquidity but mint zero shares", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();

      // Donate so the next deposit auto-compounds without minting -> L/share > 1.
      await (await ctx.vlt.mint(ctx.alice.address, VLT(50))).wait();
      await (await ctx.usdc.mint(ctx.alice.address, USDC(100))).wait();
      await (await ctx.vlt.connect(ctx.alice).transfer(ctx.vault.target, VLT(50))).wait();
      await (await ctx.usdc.connect(ctx.alice).transfer(ctx.vault.target, USDC(100))).wait();

      // Sub-share dust (values from the Shieldify PoC: adds 1 unit of L).
      const vltDust = 707_107n;
      await (await ctx.vlt.mint(ctx.bob.address, vltDust)).wait();
      await (await ctx.usdc.mint(ctx.bob.address, 1n)).wait();
      await (await ctx.vlt.connect(ctx.bob).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      await (await ctx.usdc.connect(ctx.bob).approve(ctx.vault.target, ethers.MaxUint256)).wait();

      await expect(
        ctx.vault.connect(ctx.bob).deposit(vltDust, 1n, 0n, ethers.MaxUint256, ctx.bob.address)
      ).to.be.revertedWith("zero-shares-minted");
    });

    it("still accepts a normal small deposit (shares > 0)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
      await (await deposit(ctx, ctx.bob, USDC(10))).wait();
      expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.greaterThan(0n);
    });
  });

  describe("I-04: zap() deadline", () => {
    it("reverts an expired zap before pulling tokens", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.zapHelper
          .connect(ctx.alice)
          .zap(ctx.usdc.target, ctx.vlt.target, 1n, 0n, 0n, ctx.alice.address, "0x")
      ).to.be.revertedWith("expired");
    });
  });

  describe("I-05: previewRedeem input clamp", () => {
    it("never reverts: out-of-range shares clamp to the full-supply quote", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
      const supply = await ctx.vault.totalSupply();
      const [fullV, fullU] = await ctx.vault.previewRedeem(supply);
      expect(fullV + fullU).to.be.greaterThan(0n);
      // supply+1 and an absurd input (the old uint128-truncation case) both return the ceiling.
      expect(await ctx.vault.previewRedeem(supply + 1n)).to.deep.equal([fullV, fullU]);
      expect(await ctx.vault.previewRedeem(2n ** 200n)).to.deep.equal([fullV, fullU]);
      expect(await ctx.vault.previewRedeem(ethers.MaxUint256)).to.deep.equal([fullV, fullU]);
    });
  });

  describe("I-06: cached position key", () => {
    it("matches Position.calculatePositionKey over the vault's fixed inputs", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      const expected = ethers.solidityPackedKeccak256(
        ["address", "int24", "int24", "bytes32"],
        [ctx.vault.target, await ctx.vault.tickLower(), await ctx.vault.tickUpper(), ethers.ZeroHash]
      );
      expect(await ctx.vault.positionKey()).to.equal(expected);
    });
  });

  describe("I-07: self-recipient", () => {
    it("rejects minting shares to the vault itself", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(deposit(ctx, ctx.alice, USDC(1_000), { recipient: ctx.vault.target }))
        .to.be.revertedWith("self-recipient");
    });
  });

  describe("I-08: constructor validation", () => {
    async function badDeploy(ctx, keyOverrides, usdcAddr) {
      const Vault = await ethers.getContractFactory("VltUsdcVault");
      const key = { ...ctx.poolKey, ...keyOverrides };
      return Vault.deploy(ctx.poolManager.target, key, usdcAddr ?? ctx.usdc.target);
    }

    it("rejects a non-1% fee tier", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(badDeploy(ctx, { fee: 3000 })).to.be.revertedWith("fee-not-1pct");
    });

    it("rejects zero tick spacing", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(badDeploy(ctx, { tickSpacing: 0 })).to.be.revertedWith("bad-tick-spacing");
    });

    it("rejects a native currency leg", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        badDeploy(ctx, { currency0: ethers.ZeroAddress })
      ).to.be.revertedWith("native-not-allowed");
    });

    it("rejects an uninitialized pool", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      // Fresh token pair -> a pool id that was never initialized on this manager.
      const Mock = await ethers.getContractFactory("MockERC20");
      const a = await Mock.deploy("Token A", "TA", 18);
      const b = await Mock.deploy("Token B", "TB", 6);
      const [c0, c1] =
        BigInt(a.target) < BigInt(b.target) ? [a.target, b.target] : [b.target, a.target];
      await expect(
        badDeploy(ctx, { currency0: c0, currency1: c1 }, c0)
      ).to.be.revertedWith("pool-not-initialized");
    });
  });
});
