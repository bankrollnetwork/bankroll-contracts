const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  fundUsdc,
  deposit,
  redeem,
  compound,
  generateFees,
  swapExact,
  removeBaseLiquidity,
  balancedVlt,
} = require("./helpers/setup");

const USDC = (n) => BigInt(Math.round(n * 1e6));

// Named fixture (loadFixture rejects anonymous functions) that swaps VLT for the
// hostile reentrant token.
const reentrantFixture = () => deployVaultFixture({ reentrantToken: true });

describe("VltUsdcVault — edge cases, abuse & admin", () => {
  describe("input validation", () => {
    it("deposit(0,0) reverts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await expect(
        ctx.vault.connect(ctx.alice).deposit(0, 0, 0, ethers.MaxUint256)
      ).to.be.revertedWith("zero-deposit");
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
    it("a direct token donation cannot inflate share price or zero out the next depositor", async () => {
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

      // Donation does NOT touch the pool position — shares track ΔL at the pool, not balances.
      expect(await ctx.vault.positionLiquidity()).to.equal(liqBefore);

      // Victim deposits; must receive fair, non-zero shares per the exact ΔL formula.
      await fundUsdc(ctx, ctx.bob, USDC(1000));
      const rc = await (await deposit(ctx, ctx.bob, USDC(1000))).wait();
      const ev = ctx.vault.interface.parseLog(
        rc.logs.find((l) => {
          try {
            return ctx.vault.interface.parseLog(l)?.name === "Deposit";
          } catch {
            return false;
          }
        })
      );
      const liquidityAdded = ev.args.liquidityAdded;
      const expectedShares = (supplyBefore * liquidityAdded) / liqBefore;

      const bobShares = await ctx.vault.balanceOf(ctx.bob.address);
      expect(bobShares).to.equal(expectedShares);
      expect(bobShares).to.be.greaterThan(0n);
    });
  });

  describe("reentrancy", () => {
    it("blocks reentry from a hostile token mid-deposit (ReentrancyGuardReentrantCall)", async () => {
      const ctx = await loadFixture(reentrantFixture);

      // Fund + approve BEFORE arming, so the first armed VLT movement is the deposit's own
      // transferFrom (inside the nonReentrant deposit), not a setup mint.
      const usdcAmt = USDC(10000);
      const vltAmt = balancedVlt(ctx, usdcAmt);
      await (await ctx.usdc.mint(ctx.alice.address, usdcAmt)).wait();
      await (await ctx.vlt.mint(ctx.alice.address, vltAmt)).wait();
      await (await ctx.usdc.connect(ctx.alice).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      await (await ctx.vlt.connect(ctx.alice).approve(ctx.vault.target, ethers.MaxUint256)).wait();

      await (await ctx.vlt.setTarget(ctx.vault.target)).wait();
      await (await ctx.vlt.arm(true)).wait();

      // The deposit's VLT transferFrom triggers a reentrant compound() while nonReentrant is held.
      await (await ctx.vault.connect(ctx.alice).deposit(vltAmt, usdcAmt, 0, ethers.MaxUint256)).wait();

      expect(await ctx.vlt.reentryAttempted()).to.equal(true);
      expect(await ctx.vlt.reentryReverted()).to.equal(true);

      const selector = ethers.id("ReentrancyGuardReentrantCall()").slice(0, 10);
      const lastError = await ctx.vlt.lastError();
      expect(lastError.slice(0, 10)).to.equal(selector);
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
    it("with the vault as sole LP, finder gets ~1% of gross fees in each currency", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      // Remove the baseline LP so 100% of subsequent swap fees accrue to the vault.
      await removeBaseLiquidity(ctx);

      // Drive known volume in both directions and tally gross input per currency.
      const c0Decimals = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      const c1Decimals = ctx.usdcIsCurrency0 ? ctx.cfg.vltDecimals : ctx.cfg.usdcDecimals;
      const in0 = 200n * 10n ** BigInt(c0Decimals); // small vs vault depth, but enough to clear the $1 gate
      const in1 = 200n * 10n ** BigInt(c1Decimals);

      let gross0In = 0n;
      let gross1In = 0n;
      for (let i = 0; i < 4; i++) {
        await (await swapExact(ctx, ctx.seeder, true, in0)).wait(); // currency0 in
        gross0In += in0;
        await (await swapExact(ctx, ctx.seeder, false, in1)).wait(); // currency1 in
        gross1In += in1;
      }

      const rc = await (await compound(ctx, ctx.finder)).wait();
      const ev = ctx.vault.interface.parseLog(
        rc.logs.find((l) => {
          try {
            return ctx.vault.interface.parseLog(l)?.name === "Compound";
          } catch {
            return false;
          }
        })
      );
      const { finder0, finder1 } = ev.args;

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

    it("deposit + compound have no admin gate — always callable (no pause)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      await generateFees(ctx, { rounds: 4 });

      await fundUsdc(ctx, ctx.bob, USDC(1000));
      await expect(deposit(ctx, ctx.bob, USDC(1000))).to.not.be.reverted;
      await expect(compound(ctx, ctx.finder)).to.not.be.reverted;

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      await expect(redeem(ctx, ctx.alice, shares / 2n)).to.not.be.reverted;
    });
  });
});
