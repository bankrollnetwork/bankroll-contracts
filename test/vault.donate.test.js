// donate(vltAmount, usdcAmount, deadline): the sanctioned no-mint gift path — adds balanced
// liquidity at the pool price for ALL current holders, refunds the short leg, mints nothing.
// Covers the happy path (L rises, supply fixed, holder value up, refund exact), the no-holders
// and deadline/zero guards, the compound-trigger interaction, the reentrancy guard, and a
// characterization of the documented JIT-capture caveat on large one-shot donations.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  deposit,
  redeem,
  accrueFeesTo,
  balancedVlt,
} = require("./helpers/setup");

const USDC = (n) => BigInt(n) * 10n ** 6n;

const reentrantFixture = () => deployVaultFixture({ reentrantToken: true });

async function eventArgs(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed.args;
    } catch (_) {}
  }
  return null;
}

// Mint + approve a balanced (usdcAmt, VLT-equivalent) pair for `user`; returns the VLT amount.
async function fundForDonate(ctx, user, usdcAmt) {
  const vltAmt = balancedVlt(ctx, usdcAmt);
  await (await ctx.usdc.mint(user.address, usdcAmt)).wait();
  await (await ctx.vlt.mint(user.address, vltAmt)).wait();
  await (await ctx.usdc.connect(user).approve(ctx.vault.target, ethers.MaxUint256)).wait();
  await (await ctx.vlt.connect(user).approve(ctx.vault.target, ethers.MaxUint256)).wait();
  return vltAmt;
}

// Fixture price is cfg.usdcPerVlt USDC per VLT: value a (vltRaw 18d, usdcRaw 6d) pair in 6d USDC.
function usdcValue(ctx, vltRaw, usdcRaw) {
  return (BigInt(vltRaw) * BigInt(ctx.cfg.usdcPerVlt)) / 10n ** 12n + BigInt(usdcRaw);
}

describe("vault.donate", () => {
  it("adds liquidity for holders without minting: supply fixed, holder value up, refund exact", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();

    const aliceShares = await ctx.vault.balanceOf(ctx.alice.address);
    const supplyBefore = await ctx.vault.totalSupply();
    const liqBefore = await ctx.vault.positionLiquidity();
    const [prevVlt, prevUsdc] = await ctx.vault.previewRedeem(aliceShares);

    const usdcAmt = USDC(200);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    const receipt = await (
      await ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, ethers.MaxUint256)
    ).wait();
    const ev = await eventArgs(ctx.vault, receipt, "Donate");

    // No shares anywhere: the donor got nothing, supply is unchanged.
    expect(await ctx.vault.balanceOf(ctx.carol.address)).to.equal(0n);
    expect(await ctx.vault.totalSupply()).to.equal(supplyBefore);

    // The gift landed in L, and the event reports exactly that ΔL.
    expect(ev.donor).to.equal(ctx.carol.address);
    expect(ev.liquidityAdded).to.be.greaterThan(0n);
    expect(await ctx.vault.positionLiquidity()).to.equal(liqBefore + ev.liquidityAdded);

    // Every existing share redeems for more than before, immediately.
    const [nowVlt, nowUsdc] = await ctx.vault.previewRedeem(aliceShares);
    expect(usdcValue(ctx, nowVlt, nowUsdc)).to.be.greaterThan(usdcValue(ctx, prevVlt, prevUsdc));

    // Refund is exact: the donor is out only what the pool consumed (event amounts).
    expect(await ctx.vlt.balanceOf(ctx.carol.address)).to.equal(vltAmt - ev.vltUsed);
    expect(await ctx.usdc.balanceOf(ctx.carol.address)).to.equal(usdcAmt - ev.usdcUsed);
    expect(ev.vltUsed > 0n && ev.usdcUsed > 0n).to.equal(true);

    console.log(`      GAS donate ${receipt.gasUsed} dLiq=${ev.liquidityAdded}`);
  });

  it("reverts with no holders to gift (pre-supply donation would gift the first depositor)", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    const usdcAmt = USDC(200);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    await expect(
      ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, ethers.MaxUint256)
    ).to.be.revertedWith("no-holders");
  });

  it("enforces the deadline and non-zero legs", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await (await deposit(ctx, ctx.alice, USDC(1_000))).wait();
    const usdcAmt = USDC(10);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    await expect(ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, 0n)).to.be.revertedWith("expired");
    await expect(ctx.vault.connect(ctx.carol).donate(0n, usdcAmt, ethers.MaxUint256)).to.be.revertedWith("zero-donation");
    await expect(ctx.vault.connect(ctx.carol).donate(vltAmt, 0n, ethers.MaxUint256)).to.be.revertedWith("zero-donation");
  });

  it("folds >= $100 of claimable value BEFORE the donation (donor triggers the compound)", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await (await deposit(ctx, ctx.alice, USDC(50_000))).wait();
    await accrueFeesTo(ctx, await ctx.vault.AUTO_COMPOUND_MIN_USDC());

    const usdcAmt = USDC(50);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    const receipt = await (
      await ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, ethers.MaxUint256)
    ).wait();

    expect(await eventArgs(ctx.vault, receipt, "Compound")).to.not.equal(null);
    expect(await eventArgs(ctx.vault, receipt, "Donate")).to.not.equal(null);
    const [, , claimableAfter] = await ctx.vault.compoundClaimable();
    expect(claimableAfter).to.be.lessThan(await ctx.vault.AUTO_COMPOUND_MIN_USDC());
  });

  it("guard: a hostile token cannot re-enter the vault mid-donate", async () => {
    const ctx = await loadFixture(reentrantFixture);
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();

    // Fund + approve BEFORE arming (mint is a token _update too); the first armed VLT movement
    // is then donate's own transferFrom, fired while donate holds the nonReentrant lock.
    const usdcAmt = USDC(100);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    await (await ctx.vlt.setTarget(ctx.vault.target)).wait();
    await (await ctx.vlt.setMode(1 /* MODE_DEPOSIT */)).wait();
    await (await ctx.vlt.arm(true)).wait();

    await (await ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, ethers.MaxUint256)).wait();
    expect(await ctx.vlt.reentryAttempted()).to.equal(true);
    expect(await ctx.vlt.reentryReverted()).to.equal(true);
    const selector = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
    expect((await ctx.vlt.lastError()).slice(0, 10)).to.equal(selector);
  });

  // CHARACTERIZATION of the documented JIT caveat (header + NatSpec): a large one-shot donation
  // is front-runnable — deposit before, redeem after, skim a pro-rata slice of the gift. The
  // operational mitigation is small tranches / private submission; this test pins the behavior
  // so a future change that silently alters it fails loudly.
  it("JIT capture: a front-running depositor skims a pro-rata slice of a one-shot donation", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();

    // Bob front-runs the pending donation with a large deposit (~90% of supply).
    const bobReceipt = await (await deposit(ctx, ctx.bob, USDC(90_000))).wait();
    const bobIn = await eventArgs(ctx.vault, bobReceipt, "Deposit");
    const bobShares = await ctx.vault.balanceOf(ctx.bob.address);
    const supply = await ctx.vault.totalSupply();

    const usdcAmt = USDC(1_000);
    const vltAmt = await fundForDonate(ctx, ctx.carol, usdcAmt);
    const donReceipt = await (
      await ctx.vault.connect(ctx.carol).donate(vltAmt, usdcAmt, ethers.MaxUint256)
    ).wait();
    const don = await eventArgs(ctx.vault, donReceipt, "Donate");

    // Bob back-runs with a full redeem.
    const redReceipt = await (await redeem(ctx, ctx.bob, bobShares)).wait();
    const bobOut = await eventArgs(ctx.vault, redReceipt, "Redeem");

    const inVal = usdcValue(ctx, bobIn.vltUsed, bobIn.usdcUsed);
    const outVal = usdcValue(ctx, bobOut.vltOut, bobOut.usdcOut);
    const donVal = usdcValue(ctx, don.vltUsed, don.usdcUsed);
    const captured = outVal - inVal;

    // Captured ≈ donation × bob's supply share (~90%), bounded by the whole donation.
    expect(captured).to.be.greaterThan(donVal / 2n);
    expect(captured).to.be.lessThan(donVal);
    console.log(
      `      JIT: donated=$${Number(donVal) / 1e6} captured=$${Number(captured) / 1e6} ` +
      `(bob share ${(Number(bobShares * 10000n / supply) / 100).toFixed(2)}%)`
    );
  });
});
