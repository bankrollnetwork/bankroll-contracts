const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVaultFixture, deposit, redeem, triggerCompound, accrueFeesTo } = require("./helpers/setup");

// Deterministic PRNG (mulberry32) so failures reproduce. No Date/Math.random reliance
// for the *sequence* — the seed fully determines the op stream.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USDC1 = 10n ** 6n;
const DEAD = "0x000000000000000000000000000000000000dEaD";

// NOTE: Foundry's invariant engine runs thousands of randomized sequences; this is a
// hand-rolled Hardhat stand-in (a few deterministic seeds, ~40 ops each). It exercises
// the same four invariants but at smaller scale — see README for the tradeoff.
describe("VltUsdcVault — stateful invariants", () => {
  const SEEDS = [1, 1337, 90210];
  const STEPS = 40;

  for (const seed of SEEDS) {
    it(`holds all invariants over a random op sequence (seed ${seed})`, async () => {
      const ctx = await loadFixture(deployVaultFixture);
      const rng = mulberry32(seed);
      const actors = [ctx.alice, ctx.bob, ctx.carol];

      // Pre-fund actors generously and approve the vault.
      for (const a of actors) {
        await (await ctx.usdc.mint(a.address, 10_000_000n * USDC1)).wait();
        await (await ctx.usdc.connect(a).approve(ctx.vault.target, ethers.MaxUint256)).wait();
      }

      // Bootstrap so there is a position + supply to reason about.
      await (await deposit(ctx, ctx.alice, 20_000n * USDC1)).wait();

      let prevLiq = await ctx.vault.positionLiquidity();
      let prevSupply = await ctx.vault.totalSupply();

      const checkInvariants = async (label) => {
        const liq = await ctx.vault.positionLiquidity();
        const supply = await ctx.vault.totalSupply();

        // (1) No free shares: supply can only rise when liquidity rose (deposits);
        //     compound raises liq with supply flat; redeem lowers both.
        if (supply > prevSupply) {
          expect(liq, `${label}: supply up without liq up`).to.be.greaterThan(prevLiq);
        }

        // (2) Compound/NAV monotonicity: liq/supply (redemption value per share) never
        //     decreases across ANY op. Cross-multiplied to stay in integers.
        expect(liq * prevSupply, `${label}: NAV/share decreased`).to.be.greaterThanOrEqual(
          prevLiq * supply
        );

        // (3) Solvency: the sum of every holder's redeemable liquidity never exceeds the
        //     position. (Dead shares are unredeemable, so the real claim is even smaller.)
        let userShares = 0n;
        for (const a of actors) userShares += await ctx.vault.balanceOf(a.address);
        const redeemable = (liq * userShares) / supply;
        expect(redeemable, `${label}: insolvent`).to.be.lessThanOrEqual(liq);

        prevLiq = liq;
        prevSupply = supply;
      };

      let deposits = 0;
      let redeems = 0;
      let compounds = 0;

      for (let i = 0; i < STEPS; i++) {
        const actor = actors[Math.floor(rng() * actors.length)];
        const roll = rng();

        if (roll < 0.45) {
          // deposit 500..5000 USDC
          const amt = BigInt(500 + Math.floor(rng() * 4500)) * USDC1;
          await (await deposit(ctx, actor, amt)).wait();
          deposits++;
          await checkInvariants(`deposit#${i}`);
        } else if (roll < 0.8) {
          // redeem 25..75% of the actor's shares, if any
          const bal = await ctx.vault.balanceOf(actor.address);
          if (bal === 0n) continue;
          const pct = 25n + BigInt(Math.floor(rng() * 50));
          const shares = (bal * pct) / 100n;
          if (shares === 0n) continue;
          await (await redeem(ctx, actor, shares)).wait();
          redeems++;
          await checkInvariants(`redeem#${i}`);
        } else {
          // compound: accrue fees past the $100 auto-compound trigger, then fire it with a
          // small deposit by the actor (the only compound path — no public entrypoint exists).
          await accrueFeesTo(ctx, 120n * USDC1);
          await (await triggerCompound(ctx, actor)).wait();
          compounds++;
          await checkInvariants(`compound#${i}`);
        }
      }

      // End-to-end solvency: every actor can fully exit, and the position drains down to
      // (at most) the locked dead-share remainder — never reverting for insolvency.
      for (const a of actors) {
        const bal = await ctx.vault.balanceOf(a.address);
        if (bal > 0n) await (await redeem(ctx, a, bal)).wait();
      }
      const finalUserShares =
        (await ctx.vault.balanceOf(ctx.alice.address)) +
        (await ctx.vault.balanceOf(ctx.bob.address)) +
        (await ctx.vault.balanceOf(ctx.carol.address));
      expect(finalUserShares).to.equal(0n);
      // Only the permanently-locked dead shares remain.
      expect(await ctx.vault.totalSupply()).to.equal(await ctx.vault.balanceOf(DEAD));

      // Sanity: the sequence actually exercised all three flows.
      expect(deposits, "no deposits ran").to.be.greaterThan(0);
      expect(redeems, "no redeems ran").to.be.greaterThan(0);
      expect(compounds, "no compounds ran").to.be.greaterThan(0);
    });
  }
});
