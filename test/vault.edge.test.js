const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  fundUsdc,
  deposit,
  redeem,
  triggerCompound,
  accrueFeesTo,
  swapExact,
  removeBaseLiquidity,
  balancedVlt,
} = require("./helpers/setup");

const USDC = (n) => BigInt(Math.round(n * 1e6));

function findEvent(vault, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch (_) {}
  }
  return null;
}

// Named fixture (loadFixture rejects anonymous functions) that swaps VLT for the
// hostile reentrant token.
const reentrantFixture = () => deployVaultFixture({ reentrantToken: true });

describe("VltUsdcVault — edge cases, abuse & admin", () => {
  describe("input validation", () => {
    it("deposit(0,0) reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.vault.connect(ctx.alice).deposit(0, 0, 0, ethers.MaxUint256, ctx.alice.address)
      ).to.be.revertedWith("zero-deposit");
    });

    it("deposit to the zero address reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.vault.connect(ctx.alice).deposit(1, 1, 0, ethers.MaxUint256, ethers.ZeroAddress)
      ).to.be.revertedWith("zero-recipient");
    });

    it("redeem to the zero address reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.vault.connect(ctx.alice).redeem(1, ethers.ZeroAddress)
      ).to.be.revertedWith("zero-receiver");
    });

    it("deposit past its deadline reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(1000));
      // A deadline already in the past (any elapsed block time exceeds 1).
      await expect(deposit(ctx, ctx.alice, USDC(1000), { deadline: 1n })).to.be.revertedWith(
        "expired"
      );
    });

    it("a dust deposit that adds no liquidity reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      // 1 wei of each token can't fund any liquidity.
      await expect(deposit(ctx, ctx.alice, 1n, { vltAmount: 1n })).to.be.revertedWith(
        "no-liquidity-added"
      );
    });

    it("redeem(0) reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(1000));
      await (await deposit(ctx, ctx.alice, USDC(1000))).wait();
      await expect(redeem(ctx, ctx.alice, 0)).to.be.revertedWith("zero-shares");
    });

    it("redeem above balance reverts (ERC20 burn underflow)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(1000));
      await (await deposit(ctx, ctx.alice, USDC(1000))).wait();
      const bal = await ctx.vault.balanceOf(ctx.alice.address);
      await expect(redeem(ctx, ctx.alice, bal + 1n)).to.be.revertedWithCustomError(
        ctx.vault,
        "ERC20InsufficientBalance"
      );
    });
  });

  describe("first-deposit inflation attack", () => {
    it("a donation is socialized by the auto-compound; the next depositor still gets fair, non-zero shares", async () => {
      const ctx = await loadFixture(deployVaultFixture);

      // Attacker makes the (valid) first deposit.
      await fundUsdc(ctx, ctx.alice, USDC(200));
      await (await deposit(ctx, ctx.alice, USDC(100))).wait();

      const supplyBefore = await ctx.vault.totalSupply();
      const liqBefore = await ctx.vault.positionLiquidity();

      // Attacker donates a huge amount of BOTH tokens straight to the vault, trying to
      // make 1 share look extremely valuable so the victim's deposit rounds to 0 shares.
      await (await ctx.usdc.mint(ctx.alice.address, USDC(1_000_000))).wait();
      await (await ctx.vlt.mint(ctx.alice.address, 10n ** 24n)).wait();
      await (await ctx.usdc.connect(ctx.alice).transfer(ctx.vault.target, USDC(1_000_000))).wait();
      await (await ctx.vlt.connect(ctx.alice).transfer(ctx.vault.target, 10n ** 24n)).wait();

      // The donation sits inert (shares track ΔL at the pool) until a deposit triggers the
      // auto-compound — which reinvests it for the holders existing BEFORE the victim enters.
      expect(await ctx.vault.positionLiquidity()).to.equal(liqBefore);

      // Victim deposits: the compound leg socializes the donation first (no shares minted for
      // it), then the victim's shares mint at the post-compound price per the exact ΔL formula.
      // Fewer shares than pre-donation, but each is proportionally richer — value-fair, and the
      // attacker recovers nothing: the donation went to the pre-victim holders (largely the
      // locked dead shares on a fresh vault), making inflation griefing a money-loser.
      await fundUsdc(ctx, ctx.bob, USDC(1000));
      const rc = await (await deposit(ctx, ctx.bob, USDC(1000))).wait();
      const cmp = findEvent(ctx.vault, rc, "Compound");
      const dep = findEvent(ctx.vault, rc, "Deposit");
      expect(cmp.liquidityAdded).to.be.greaterThan(0n); // the balanced part of the donation reinvested

      const lAtMint = liqBefore + cmp.liquidityAdded;
      const expectedShares = (supplyBefore * dep.liquidityAdded) / lAtMint;
      const bobShares = await ctx.vault.balanceOf(ctx.bob.address);
      expect(bobShares).to.equal(expectedShares);
      expect(bobShares).to.be.greaterThan(0n);
      // Only the victim's own mint grew the supply — the donation minted nobody shares.
      expect(await ctx.vault.totalSupply()).to.equal(supplyBefore + dep.sharesOut);

      // Value-fairness: the victim's redeemable claim is worth ~their own $2,000 deposit
      // ($1,000 USDC + $1,000 in VLT) — they neither capture the donation nor pay for it.
      const [pVlt, pUsdc] = await ctx.vault.previewRedeem(bobShares);
      const valueUsdc = pUsdc + (pVlt * 2n) / 10n ** 12n; // VLT at the ~2 USDC/VLT reference
      expect(valueUsdc).to.be.greaterThan((USDC(2000) * 97n) / 100n);
      expect(valueUsdc).to.be.lessThan((USDC(2000) * 103n) / 100n);
    });
  });

  describe("reentrancy & the self-only compound gate", () => {
    // Fund + approve BEFORE arming, so the first armed VLT movement is the deposit's own
    // transferFrom (inside the nonReentrant deposit), not a setup mint.
    async function armedDeposit(ctx, mode) {
      const usdcAmt = USDC(10000);
      const vltAmt = balancedVlt(ctx, usdcAmt);
      await (await ctx.usdc.mint(ctx.alice.address, usdcAmt)).wait();
      await (await ctx.vlt.mint(ctx.alice.address, vltAmt)).wait();
      await (await ctx.usdc.connect(ctx.alice).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      await (await ctx.vlt.connect(ctx.alice).approve(ctx.vault.target, ethers.MaxUint256)).wait();

      await (await ctx.vlt.setTarget(ctx.vault.target)).wait();
      await (await ctx.vlt.setMode(mode)).wait();
      await (await ctx.vlt.arm(true)).wait();

      await (
        await ctx.vault.connect(ctx.alice).deposit(vltAmt, usdcAmt, 0, ethers.MaxUint256, ctx.alice.address)
      ).wait();
      expect(await ctx.vlt.reentryAttempted()).to.equal(true);
      expect(await ctx.vlt.reentryReverted()).to.equal(true);
      return ctx.vlt.lastError();
    }

    it("blocks reentry from a hostile token mid-deposit (ReentrancyGuardReentrantCall)", async () => {
      const ctx = await loadFixture(reentrantFixture);
      // The deposit's VLT transferFrom triggers a reentrant redeem() while nonReentrant is held.
      const lastError = await armedDeposit(ctx, 0 /* MODE_REDEEM */);
      const selector = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
      expect(lastError.slice(0, 10)).to.equal(selector);
    });

    it("a hostile token calling autoCompound mid-deposit hits the self-only gate", async () => {
      const ctx = await loadFixture(reentrantFixture);
      const lastError = await armedDeposit(ctx, 1 /* MODE_AUTO_COMPOUND */);
      const errorSelector = ethers.id("Error(string)").slice(0, 10);
      expect(lastError.slice(0, 10)).to.equal(errorSelector);
      const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["string"],
        ethers.dataSlice(lastError, 4)
      );
      expect(reason).to.equal("self-only");
    });

    it("autoCompound cannot be called externally at all", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.vault.connect(ctx.alice).autoCompound(ctx.alice.address)
      ).to.be.revertedWith("self-only");
    });
  });

  describe("USDC blacklist", () => {
    it("a blacklisted holder's redeem reverts on the USDC take leg (their problem, not the vault's)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      const shares = await ctx.vault.balanceOf(ctx.alice.address);

      await (await ctx.usdc.setBlacklisted(ctx.alice.address, true)).wait();
      // V4 wraps the token's revert in an ERC-7751 error, so we assert a generic revert;
      // the unblock-then-succeeds check below confirms the blacklist is the cause.
      await expect(redeem(ctx, ctx.alice, shares)).to.be.reverted;

      // The vault and other holders are unaffected: position intact, can still be redeemed once unblocked.
      await (await ctx.usdc.setBlacklisted(ctx.alice.address, false)).wait();
      await expect(redeem(ctx, ctx.alice, shares)).to.not.be.reverted;
    });
  });

  describe("finder fee is exactly 1% of harvested fees", () => {
    it("with the vault as sole LP, the trigger depositor gets ~1% of gross fees in each currency", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      // Remove the baseline LP so 100% of subsequent swap fees accrue to the vault.
      await removeBaseLiquidity(ctx);

      // Drive known volume in both directions (enough to arm the $100 auto-compound trigger)
      // and tally gross input per currency.
      const c0Decimals = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      const c1Decimals = ctx.usdcIsCurrency0 ? ctx.cfg.vltDecimals : ctx.cfg.usdcDecimals;
      const in0 = 2000n * 10n ** BigInt(c0Decimals);
      const in1 = 2000n * 10n ** BigInt(c1Decimals);

      let gross0In = 0n;
      let gross1In = 0n;
      for (let i = 0; i < 4; i++) {
        await (await swapExact(ctx, ctx.seeder, true, in0)).wait(); // currency0 in
        gross0In += in0;
        await (await swapExact(ctx, ctx.seeder, false, in1)).wait(); // currency1 in
        gross1In += in1;
      }
      const [, , armed] = await ctx.vault.compoundClaimable();
      expect(armed).to.be.greaterThanOrEqual(USDC(100)); // the trigger will fire

      // The finder is the trigger depositor; net out the trigger deposit's own pull/refund.
      const trigUsdc = USDC(10);
      const trigVlt = balancedVlt(ctx, trigUsdc);
      const fVltBefore = await ctx.vlt.balanceOf(ctx.finder.address);
      const fUsdcBefore = await ctx.usdc.balanceOf(ctx.finder.address);
      const rc = await (await triggerCompound(ctx, ctx.finder, trigUsdc)).wait();
      const ev = { args: findEvent(ctx.vault, rc, "Compound") };
      const dep = findEvent(ctx.vault, rc, "Deposit");
      const vltGot =
        (await ctx.vlt.balanceOf(ctx.finder.address)) - fVltBefore - (trigVlt - dep.vltUsed);
      const usdcGot =
        (await ctx.usdc.balanceOf(ctx.finder.address)) - fUsdcBefore - (trigUsdc - dep.usdcUsed);
      expect(vltGot).to.equal(ev.args.vltFinder); // wallet delta matches the event exactly
      expect(usdcGot).to.equal(ev.args.usdcFinder);

      // Expectations below are computed in pool (currency0/1) order from the swap inputs;
      // the event is token-named, so map it back through the fixture's ordering.
      const [finder0, finder1] = ctx.usdcIsCurrency0
        ? [ev.args.usdcFinder, ev.args.vltFinder]
        : [ev.args.vltFinder, ev.args.usdcFinder];

      // gross fee per currency = inputs * fee / 1e6 ; finder = 1% of that.
      const feePips = BigInt(ctx.cfg.fee);
      const expFinder0 = (gross0In * feePips) / 1_000_000n / 100n;
      const expFinder1 = (gross1In * feePips) / 1_000_000n / 100n;

      // Allow a small tolerance for V4 fee-growth rounding (per-liquidity Q128 math).
      const closeTo = (actual, expected) => {
        const diff = actual > expected ? actual - expected : expected - actual;
        // within 2% relative (catches any wrong rate / denominator), and > 0.
        expect(actual).to.be.greaterThan(0n);
        expect(diff * 100n).to.be.lessThanOrEqual(expected * 2n);
      };
      closeTo(finder0, expFinder0);
      closeTo(finder1, expFinder1);
    });
  });

  describe("ownerless / immutable", () => {
    it("is fully ownerless — no owner(), no sweep, no transferOwnership", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      const fns = ctx.vault.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(fns).to.not.include("owner");
      expect(fns).to.not.include("sweep");
      expect(fns).to.not.include("transferOwnership");
    });

    it("deposit has no admin gate and carries the auto-compound — always callable (no pause)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      await accrueFeesTo(ctx, USDC(120));

      // Any depositor triggers the compound — no keeper, no role, no pause anywhere.
      await fundUsdc(ctx, ctx.bob, USDC(1000));
      const rc = await (await deposit(ctx, ctx.bob, USDC(1000))).wait();
      expect(findEvent(ctx.vault, rc, "Compound")).to.not.equal(null);

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      await expect(redeem(ctx, ctx.alice, shares / 2n)).to.not.be.reverted;
    });
  });
});
