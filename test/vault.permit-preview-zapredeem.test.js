// The LP-completeness batch: EIP-2612 permit on the share token, previewDeposit (the missing
// ERC-4626-style entry-side quote), and zapRedeem / zapRedeemWithPermit (USDC-only exit through
// the periphery — the mirror of zapDeposit; the vault's redeem itself still never swaps).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVaultFixture, deposit, balancedVlt } = require("./helpers/setup");

const USDC = (n) => BigInt(n) * 10n ** 6n;
const VLT = (n) => BigInt(n) * 10n ** 18n;

async function eventArgs(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    } catch (_) {}
  }
  return null;
}

// EIP-2612 signature over the vault share token (OZ ERC20Permit: name = token name, version "1").
async function signPermit(ctx, owner, spender, value, deadline) {
  const domain = {
    name: "Bankroll VLT-USDC LP",
    version: "1",
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: ctx.vault.target,
  };
  const types = {
    Permit: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };
  const message = {
    owner: owner.address,
    spender,
    value,
    nonce: await ctx.vault.nonces(owner.address),
    deadline,
  };
  return ethers.Signature.from(await owner.signTypedData(domain, types, message));
}

describe("permit / previewDeposit / zapRedeem", () => {
  describe("EIP-2612 permit on vltUSDC shares", () => {
    it("sets an allowance from a signature and bumps the nonce", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(1_000))).wait();
      const shares = await ctx.vault.balanceOf(ctx.alice.address);

      const sig = await signPermit(ctx, ctx.alice, ctx.bob.address, shares, ethers.MaxUint256);
      await (
        await ctx.vault
          .connect(ctx.carol) // anyone can submit the signed permit
          .permit(ctx.alice.address, ctx.bob.address, shares, ethers.MaxUint256, sig.v, sig.r, sig.s)
      ).wait();

      expect(await ctx.vault.allowance(ctx.alice.address, ctx.bob.address)).to.equal(shares);
      expect(await ctx.vault.nonces(ctx.alice.address)).to.equal(1n);

      // The allowance is a real one: bob can move the shares.
      await (await ctx.vault.connect(ctx.bob).transferFrom(ctx.alice.address, ctx.bob.address, shares)).wait();
      expect(await ctx.vault.balanceOf(ctx.bob.address)).to.equal(shares);
    });
  });

  describe("previewDeposit", () => {
    it("matches an executed subsequent deposit exactly (shares) and within 1 wei (consumed)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();

      const usdcAmt = USDC(2_500);
      const vltAmt = balancedVlt(ctx, usdcAmt);
      const [pShares, pVlt, pUsdc] = await ctx.vault.previewDeposit(vltAmt, usdcAmt);
      expect(pShares).to.be.greaterThan(0n);

      const receipt = await (await deposit(ctx, ctx.bob, usdcAmt, { vltAmount: vltAmt })).wait();
      const ev = await eventArgs(ctx.vault, receipt, "Deposit");
      expect(ev.sharesOut).to.equal(pShares);
      expect(ev.vltUsed > pVlt ? ev.vltUsed - pVlt : pVlt - ev.vltUsed).to.be.lessThanOrEqual(1n);
      expect(ev.usdcUsed > pUsdc ? ev.usdcUsed - pUsdc : pUsdc - ev.usdcUsed).to.be.lessThanOrEqual(1n);
    });

    it("quotes the first deposit (dead-share haircut) and post-donation L/share > 1 states", async () => {
      const ctx = await loadFixture(deployVaultFixture);

      // Empty vault: shares = L - MINIMUM_LIQUIDITY.
      const usdcAmt = USDC(10_000);
      const vltAmt = balancedVlt(ctx, usdcAmt);
      const [firstShares] = await ctx.vault.previewDeposit(vltAmt, usdcAmt);
      const firstReceipt = await (await deposit(ctx, ctx.alice, usdcAmt, { vltAmount: vltAmt })).wait();
      const firstEv = await eventArgs(ctx.vault, firstReceipt, "Deposit");
      expect(firstEv.sharesOut).to.equal(firstShares);

      // Donation pushes L/share above 1; the preview must track the new share price.
      await (await ctx.vlt.mint(ctx.carol.address, VLT(100))).wait();
      await (await ctx.usdc.mint(ctx.carol.address, USDC(200))).wait();
      await (await ctx.vlt.connect(ctx.carol).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      await (await ctx.usdc.connect(ctx.carol).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      await (await ctx.vault.connect(ctx.carol).donate(VLT(100), USDC(200), ctx.carol.address, ethers.MaxUint256)).wait();

      const [pShares] = await ctx.vault.previewDeposit(vltAmt, usdcAmt);
      const receipt = await (await deposit(ctx, ctx.bob, usdcAmt, { vltAmount: vltAmt })).wait();
      const ev = await eventArgs(ctx.vault, receipt, "Deposit");
      expect(ev.sharesOut).to.equal(pShares);
      expect(pShares).to.be.lessThan(firstShares); // shares got pricier after the gift

      // Degenerate input never reverts.
      const [zShares, zVlt, zUsdc] = await ctx.vault.previewDeposit(0n, 0n);
      expect(zShares + zVlt + zUsdc).to.equal(0n);
    });
  });

  describe("zapRedeem", () => {
    // The mock router needs a USDC reserve to pay out the reverse (VLT -> USDC) leg.
    async function seedRouterUsdc(ctx, amount) {
      await (await ctx.usdc.mint(ctx.mockRouter.target, amount)).wait();
    }
    function sellData(ctx, vltAmount) {
      return ctx.mockRouter.interface.encodeFunctionData("swapVltForUsdc", [
        vltAmount,
        ctx.zapHelper.target,
      ]);
    }

    it("exits USDC-only: shares in, USDC out to the receiver, helper keeps nothing", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
      await seedRouterUsdc(ctx, USDC(1_000_000));

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const supplyBefore = await ctx.vault.totalSupply();
      const [expVlt] = await ctx.vault.previewRedeem(shares);
      const usdcBefore = await ctx.usdc.balanceOf(ctx.alice.address);

      await (await ctx.vault.connect(ctx.alice).approve(ctx.zapHelper.target, shares)).wait();
      const receipt = await (
        await ctx.zapHelper
          .connect(ctx.alice)
          .zapRedeem(shares, 1n, ethers.MaxUint256, ctx.alice.address, sellData(ctx, expVlt))
      ).wait();
      const redeemEv = await eventArgs(ctx.vault, receipt, "Redeem");

      // Vault event: helper is the owner (burned its own balance), alice... receiver is the
      // helper mid-flow; the exit attribution for zaps is the helper's delivery below.
      expect(redeemEv.owner).to.equal(ctx.zapHelper.target);

      // Alice: no shares left, USDC-only proceeds, no VLT beyond route dust.
      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);
      expect(await ctx.vault.totalSupply()).to.equal(supplyBefore - shares);
      const usdcGained = (await ctx.usdc.balanceOf(ctx.alice.address)) - usdcBefore;
      expect(usdcGained).to.be.greaterThan(0n);

      // Custody-free: the helper holds nothing afterwards.
      expect(await ctx.usdc.balanceOf(ctx.zapHelper.target)).to.equal(0n);
      expect(await ctx.vlt.balanceOf(ctx.zapHelper.target)).to.equal(0n);
      expect(await ctx.vault.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    });

    it("enforces the aggregate minUsdcOut and the deadline", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(1_000))).wait();
      await seedRouterUsdc(ctx, USDC(100_000));
      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const [expVlt] = await ctx.vault.previewRedeem(shares);
      await (await ctx.vault.connect(ctx.alice).approve(ctx.zapHelper.target, shares)).wait();

      await expect(
        ctx.zapHelper
          .connect(ctx.alice)
          .zapRedeem(shares, USDC(1_000_000), ethers.MaxUint256, ctx.alice.address, sellData(ctx, expVlt))
      ).to.be.revertedWith("zap-slippage");
      await expect(
        ctx.zapHelper.connect(ctx.alice).zapRedeem(shares, 1n, 0n, ctx.alice.address, sellData(ctx, expVlt))
      ).to.be.revertedWith("expired");
    });

    it("zapRedeemWithPermit: one transaction, no prior approval", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(5_000))).wait();
      await seedRouterUsdc(ctx, USDC(500_000));

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const [expVlt] = await ctx.vault.previewRedeem(shares);
      expect(await ctx.vault.allowance(ctx.alice.address, ctx.zapHelper.target)).to.equal(0n);

      const sig = await signPermit(ctx, ctx.alice, ctx.zapHelper.target, shares, ethers.MaxUint256);
      await (
        await ctx.zapHelper
          .connect(ctx.alice)
          .zapRedeemWithPermit(
            shares, 1n, ethers.MaxUint256, ctx.alice.address,
            sig.v, sig.r, sig.s, sellData(ctx, expVlt)
          )
      ).wait();

      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);
      expect(await ctx.usdc.balanceOf(ctx.alice.address)).to.be.greaterThan(0n);
      expect(await ctx.vault.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    });
  });
});
