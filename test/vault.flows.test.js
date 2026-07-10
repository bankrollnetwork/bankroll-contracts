const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  balancedVlt,
  fundUsdc,
  deposit,
  redeem,
  compound,
  generateFees,
  swapExact,
} = require("./helpers/setup");

const USDC = (n) => BigInt(Math.round(n * 1e6)); // 6-decimal USDC raw
const MINIMUM_LIQUIDITY = 1000n;

// A deep pool so a single deposit's entry swap has negligible price impact —
// isolates the ~0.5% entry-swap fee for the round-trip value check.
const deepFixture = () => deployVaultFixture({ baseLiquidity: 10n ** 20n });

// Resolve the Compound event from a receipt.
async function getEvent(vault, receipt, name) {
  const frag = vault.interface.getEvent(name);
  for (const log of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch (_) {}
  }
  throw new Error(`event ${name} not found`);
}

const DAY = 24 * 60 * 60;

// Balanced fee burst: round-trip USDC→VLT→USDC so the price returns to ~start (no directional drift
// over many days) while fees leak on both legs. Used by the ring/APR tests, which compound daily.
async function feeBurst(ctx, n = 3) {
  const usdcIn = 2000n * 10n ** BigInt(ctx.cfg.usdcDecimals);
  for (let i = 0; i < n; i++) {
    const vltBefore = await ctx.vlt.balanceOf(ctx.seeder.address);
    await (await swapExact(ctx, ctx.seeder, ctx.usdcIsCurrency0, usdcIn)).wait(); // USDC → VLT
    const vltGained = (await ctx.vlt.balanceOf(ctx.seeder.address)) - vltBefore;
    if (vltGained > 0n) {
      await (await swapExact(ctx, ctx.seeder, !ctx.usdcIsCurrency0, vltGained)).wait(); // VLT → USDC back
    }
  }
}

describe("VltUsdcVault — core flows", () => {
  describe("deposit", () => {
    it("first deposit locks MINIMUM_LIQUIDITY and mints ΔL-minus-lock shares", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));

      const tx = await deposit(ctx, ctx.alice, USDC(10000));
      const rc = await tx.wait();
      const { liquidityAdded, sharesOut } = await getEvent(ctx.vault, rc, "Deposit");

      const L = await ctx.vault.positionLiquidity();
      expect(L).to.equal(liquidityAdded); // vault position == liquidity just added
      expect(liquidityAdded).to.be.greaterThan(MINIMUM_LIQUIDITY);

      // dead-address lock + alice's shares == total supply == ΔL.
      expect(await ctx.vault.balanceOf("0x000000000000000000000000000000000000dEaD")).to.equal(
        MINIMUM_LIQUIDITY
      );
      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(sharesOut);
      expect(sharesOut).to.equal(liquidityAdded - MINIMUM_LIQUIDITY);
      expect(await ctx.vault.totalSupply()).to.equal(liquidityAdded);
    });

    it("refunds zap dust — the vault holds no token balance after a deposit", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      expect(await ctx.vlt.balanceOf(ctx.vault.target)).to.equal(0n);
      expect(await ctx.usdc.balanceOf(ctx.vault.target)).to.equal(0n);
    });

    it("mints the second depositor shares pro-rata to the liquidity they add", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await fundUsdc(ctx, ctx.bob, USDC(10000));

      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      const supplyBefore = await ctx.vault.totalSupply();
      const liqBefore = await ctx.vault.positionLiquidity();

      const rc = await (await deposit(ctx, ctx.bob, USDC(10000))).wait();
      const { liquidityAdded, sharesOut } = await getEvent(ctx.vault, rc, "Deposit");

      // shares == supplyBefore * ΔL / liqBefore (exact integer formula in the contract).
      const expected = (supplyBefore * liquidityAdded) / liqBefore;
      expect(sharesOut).to.equal(expected);
      expect(await ctx.vault.balanceOf(ctx.bob.address)).to.equal(expected);
    });

    it("sets inceptionTime once, on the first deposit only", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await fundUsdc(ctx, ctx.bob, USDC(10000));

      expect(await ctx.vault.inceptionTime()).to.equal(0n); // unset before any deposit

      const rc1 = await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      const t1 = BigInt((await ethers.provider.getBlock(rc1.blockNumber)).timestamp);
      expect(await ctx.vault.inceptionTime()).to.equal(t1);

      await (await deposit(ctx, ctx.bob, USDC(10000))).wait(); // a later deposit must NOT move it
      expect(await ctx.vault.inceptionTime()).to.equal(t1);
    });

    it("mints shares to `recipient`, refunds the payer, and the event carries CONSUMED amounts", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      const usdcAmt = USDC(10000);
      // Over-supply VLT 2x so the deposit is imbalanced: the excess must return to the payer
      // (alice), never the recipient, and must NOT appear in the event's used amounts.
      const vltAmt = balancedVlt(ctx, usdcAmt) * 2n;

      const aVltBefore = await ctx.vlt.balanceOf(ctx.alice.address);
      const aUsdcBefore = await ctx.usdc.balanceOf(ctx.alice.address);

      const rc = await (
        await deposit(ctx, ctx.alice, usdcAmt, { vltAmount: vltAmt, recipient: ctx.bob.address })
      ).wait();
      const ev = await getEvent(ctx.vault, rc, "Deposit");

      // Attribution: payer (sender) vs share owner (recipient).
      expect(ev.sender).to.equal(ctx.alice.address);
      expect(ev.recipient).to.equal(ctx.bob.address);

      // Shares mint to the recipient only; the payer gets none.
      expect(await ctx.vault.balanceOf(ctx.bob.address)).to.equal(ev.sharesOut);
      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);

      // The imbalanced excess refunds to the payer; consumed == pulled − refunded (conservation).
      // (deposit() mints alice exactly vltAmt/usdcAmt, so her balance delta IS the refund.)
      const vltRefund = (await ctx.vlt.balanceOf(ctx.alice.address)) - aVltBefore;
      const usdcRefund = (await ctx.usdc.balanceOf(ctx.alice.address)) - aUsdcBefore;
      expect(vltRefund).to.be.greaterThan(0n);
      expect(ev.vltUsed).to.equal(vltAmt - vltRefund);
      expect(ev.usdcUsed).to.equal(usdcAmt - usdcRefund);
      expect(ev.vltUsed).to.be.lessThan(vltAmt); // gross-pulled semantics would fail here
    });

    it("reverts a deposit whose minShares bound is not met", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await expect(
        deposit(ctx, ctx.alice, USDC(10000), { minShares: 10n ** 30n })
      ).to.be.revertedWith("slippage-shares");
    });
  });

  describe("redeem", () => {
    it("returns BOTH tokens in kind, pro-rata, and burns the shares", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const vltBefore = await ctx.vlt.balanceOf(ctx.alice.address);
      const usdcBefore = await ctx.usdc.balanceOf(ctx.alice.address);
      const lBefore = await ctx.vault.positionLiquidity();

      const rc = await (await redeem(ctx, ctx.alice, shares)).wait();
      const { vltOut, usdcOut } = await getEvent(ctx.vault, rc, "Redeem");

      expect(vltOut).to.be.greaterThan(0n);
      expect(usdcOut).to.be.greaterThan(0n); // in-kind: both sides returned
      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);

      // Alice's wallet received both tokens; vault position shrank.
      expect(await ctx.vlt.balanceOf(ctx.alice.address)).to.be.greaterThan(vltBefore);
      expect(await ctx.usdc.balanceOf(ctx.alice.address)).to.be.greaterThan(usdcBefore);
      expect(await ctx.vault.positionLiquidity()).to.be.lessThan(lBefore);
    });

    it("pays a designated receiver; the owner's shares burn and their wallet is untouched", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      const shares = await ctx.vault.balanceOf(ctx.alice.address);

      const aVlt = await ctx.vlt.balanceOf(ctx.alice.address);
      const aUsdc = await ctx.usdc.balanceOf(ctx.alice.address);
      const bVlt = await ctx.vlt.balanceOf(ctx.bob.address);
      const bUsdc = await ctx.usdc.balanceOf(ctx.bob.address);

      const rc = await (await redeem(ctx, ctx.alice, shares, ctx.bob.address)).wait();
      const ev = await getEvent(ctx.vault, rc, "Redeem");
      expect(ev.owner).to.equal(ctx.alice.address);
      expect(ev.receiver).to.equal(ctx.bob.address);
      expect(ev.sharesIn).to.equal(shares);

      // Both tokens land on the receiver, exactly per the event; the owner only loses shares.
      expect((await ctx.vlt.balanceOf(ctx.bob.address)) - bVlt).to.equal(ev.vltOut);
      expect((await ctx.usdc.balanceOf(ctx.bob.address)) - bUsdc).to.equal(ev.usdcOut);
      expect(await ctx.vlt.balanceOf(ctx.alice.address)).to.equal(aVlt);
      expect(await ctx.usdc.balanceOf(ctx.alice.address)).to.equal(aUsdc);
      expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);
    });

    it("previewRedeem matches the actual in-kind redeem amounts (minus V4 rounding)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const [pVlt, pUsdc] = await ctx.vault.previewRedeem(shares);
      expect(pVlt).to.be.greaterThan(0n);
      expect(pUsdc).to.be.greaterThan(0n);

      const rc = await (await redeem(ctx, ctx.alice, shares)).wait();
      const { vltOut, usdcOut } = await getEvent(ctx.vault, rc, "Redeem");

      // Same price, same liquidity, same rounding (SqrtPriceMath roundUp=false) → match to ~1 wei.
      const near = (a, b) => expect(a > b ? a - b : b - a).to.be.lessThanOrEqual(2n);
      near(pVlt, vltOut);
      near(pUsdc, usdcOut);

      // The production guard holds: a 1%-slippage floor off the preview never trips the real redeem.
      expect(vltOut).to.be.greaterThanOrEqual((pVlt * 99n) / 100n);
      expect(usdcOut).to.be.greaterThanOrEqual((pUsdc * 99n) / 100n);
    });

    it("round-trips: deposit then immediate redeem returns ~the deposit, minus the entry swap fee", async () => {
      const ctx = await loadFixture(deepFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      const usdcStart = await ctx.usdc.balanceOf(ctx.alice.address);

      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      await (await redeem(ctx, ctx.alice, shares)).wait();

      // Alice now holds USDC + VLT. Value back in USDC terms should be close to 10k,
      // lost only to the 1% entry swap on ~half the deposit (~0.5%) + tiny price impact.
      const usdcEnd = await ctx.usdc.balanceOf(ctx.alice.address);
      const vltEnd = await ctx.vlt.balanceOf(ctx.alice.address);
      // Convert VLT back to USDC at the ~2 USDC/VLT reference for a rough value check.
      const vltValueUsdc = (vltEnd * 2n * 10n ** 6n) / 10n ** 18n;
      const totalValue = usdcEnd + vltValueUsdc;
      // within 3% of the original 10k deposit
      expect(totalValue).to.be.greaterThan((usdcStart * 97n) / 100n);
    });
  });

  describe("compound", () => {
    it("pays the finder, mints NO shares, and grows liquidity", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      await generateFees(ctx, { rounds: 6 });

      const supplyBefore = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();
      const finderVltBefore = await ctx.vlt.balanceOf(ctx.finder.address);
      const finderUsdcBefore = await ctx.usdc.balanceOf(ctx.finder.address);

      const rc = await (await compound(ctx, ctx.finder)).wait();
      const { vltFinder, usdcFinder, liquidityAdded } = await getEvent(ctx.vault, rc, "Compound");

      // No new shares — the whole point: NAV/share rises.
      expect(await ctx.vault.totalSupply()).to.equal(supplyBefore);
      // Liquidity grew.
      expect(liquidityAdded).to.be.greaterThan(0n);
      expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);

      // Finder actually received the event-reported cut in each token.
      expect((await ctx.vlt.balanceOf(ctx.finder.address)) - finderVltBefore).to.equal(vltFinder);
      expect((await ctx.usdc.balanceOf(ctx.finder.address)) - finderUsdcBefore).to.equal(usdcFinder);
      expect(vltFinder + usdcFinder).to.be.greaterThan(0n);
    });

    it("is a no-op (returns 0, no state change) when nothing has accrued", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();
      // No fees generated → nothing claimable → compound returns 0 without reverting or changing state.
      const lBefore = await ctx.vault.positionLiquidity();
      const supplyBefore = await ctx.vault.totalSupply();
      expect(await ctx.vault.connect(ctx.finder).compound.staticCall()).to.equal(0n);
      await (await compound(ctx, ctx.finder)).wait();
      expect(await ctx.vault.positionLiquidity()).to.equal(lBefore);
      expect(await ctx.vault.totalSupply()).to.equal(supplyBefore);
    });

    it("auto-rebalances ONE-SIDED fees into liquidity with no caller args", async () => {
      // Fees accrue almost entirely on currency0 (one-direction volume). WITHOUT the internal
      // rebalance swap, getLiquidityForAmounts(amount0, ~0) = 0 → a one-sided harvest adds ZERO
      // liquidity. So liquidityAdded > 0 here is direct proof the internal rebalance ran.
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      for (let k = 0; k < 6; k++) {
        await (await swapExact(ctx, ctx.seeder, true, 2000n * 10n ** BigInt(c0Dec))).wait();
      }

      const lBefore = await ctx.vault.positionLiquidity();
      const rc = await (await compound(ctx, ctx.finder)).wait();
      const { liquidityAdded } = await getEvent(ctx.vault, rc, "Compound");
      expect(liquidityAdded).to.be.greaterThan(0n);
      expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
    });

    it("rebalance swap is capped by fresh fees: a one-sided donation alone is never swapped", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      // Donate one-sided USDC straight to the vault (over the $1 gate) with NO fresh pool fees.
      const donation = USDC(50);
      await (await ctx.usdc.mint(ctx.vault.target, donation)).wait();

      // The gate passes (claimable ≥ $1) but this harvest collects ~0 fees, so the rebalance cap
      // (REBALANCE_CAP_MULT × fresh fees) is 0: the vault must never trade held balances at spot
      // without freshly-accrued fees sizing the swap. One-sided → nothing can be placed either.
      expect(await ctx.vault.connect(ctx.finder).compound.staticCall()).to.equal(0n);
      await (await compound(ctx, ctx.finder)).wait();
      expect(await ctx.usdc.balanceOf(ctx.vault.target)).to.equal(donation); // untouched, folds forward
      expect(await ctx.vlt.balanceOf(ctx.vault.target)).to.equal(0n); // no swap happened

      // Once fresh fees exist the (fee-scaled) rebalance runs and the donation starts folding in.
      await generateFees(ctx, { rounds: 4 });
      const lBefore = await ctx.vault.positionLiquidity();
      await (await compound(ctx, ctx.finder)).wait();
      expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
    });

    it("min-value gate is a fixed $1 constant with no setter (ungoverned)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      expect(await ctx.vault.MIN_COMPOUND_VALUE_USDC()).to.equal(USDC(1));
      // No setter exists — the gate can never be changed (immutable, no DoS lever).
      const hasSetter = ctx.vault.interface.fragments.some(
        (f) => f.type === "function" && f.name === "setMinCompoundValue"
      );
      expect(hasSetter).to.equal(false);
    });

    it("keeps NAV/share monotonic even when the price is pushed before compound", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      await generateFees(ctx, { rounds: 4 });

      const supply = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();

      // Attacker front-runs with a large one-way swap to push the pool price hard.
      const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      await (await swapExact(ctx, ctx.seeder, true, 200000n * 10n ** BigInt(c0Dec))).wait();

      await (await compound(ctx, ctx.finder)).wait();

      const lAfter = await ctx.vault.positionLiquidity();
      expect(await ctx.vault.totalSupply()).to.equal(supply); // no shares minted
      expect(lAfter).to.be.greaterThanOrEqual(lBefore); // compound only adds — NAV/share never drops
    });

    it("compound never decreases a holder's redemption value (NAV/share monotonic)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      const shares = await ctx.vault.balanceOf(ctx.alice.address);
      const supply = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();
      const navBefore = (lBefore * shares) / supply; // liquidity claim per holder

      await generateFees(ctx, { rounds: 6 });
      await (await compound(ctx, ctx.finder)).wait();

      const lAfter = await ctx.vault.positionLiquidity();
      const navAfter = (lAfter * shares) / supply;
      expect(navAfter).to.be.greaterThanOrEqual(navBefore);
      expect(lAfter).to.be.greaterThan(lBefore);
    });
  });

  // The vault maps its internal currency0/1 pool ordering to token-named (vlt*/usdc*) event
  // and view fields via `_toVltUsdc`. That ordering is an address-sort accident (in these
  // tests it varies with deploy nonces!), so a missed or inverted mapping is invisible in
  // one ordering and catastrophic in the other. Pin the mapping under BOTH, deterministically.
  describe("token-named events/views hold under BOTH currency orderings", () => {
    const usdc0Fixture = () => deployVaultFixture({ forceUsdcIsCurrency0: true });
    const vlt0Fixture = () => deployVaultFixture({ forceUsdcIsCurrency0: false });

    for (const usdcIs0 of [true, false]) {
      it(`usdcIsCurrency0 == ${usdcIs0}: vlt*/usdc* fields carry the right token`, async () => {
        const ctx = await loadFixture(usdcIs0 ? usdc0Fixture : vlt0Fixture);
        expect(ctx.usdcIsCurrency0).to.equal(usdcIs0);
        expect(await ctx.vault.usdcIsCurrency0()).to.equal(usdcIs0);

        // 1. Balanced deposit: each consumed amount sits on its own token's scale (1e12 apart),
        //    so a swapped mapping fails by twelve orders of magnitude.
        const usdcAmt = USDC(10000);
        const vltAmt = balancedVlt(ctx, usdcAmt);
        const rcDep = await (await deposit(ctx, ctx.alice, usdcAmt)).wait();
        const dep = await getEvent(ctx.vault, rcDep, "Deposit");
        expect(dep.usdcUsed).to.be.greaterThan((usdcAmt * 9n) / 10n);
        expect(dep.usdcUsed).to.be.lessThanOrEqual(usdcAmt);
        expect(dep.vltUsed).to.be.greaterThan((vltAmt * 9n) / 10n);
        expect(dep.vltUsed).to.be.lessThanOrEqual(vltAmt);

        // 2. One-sided USDC-in volume → pool fees accrue in USDC ONLY. FeesRetained must say so.
        await (await swapExact(ctx, ctx.seeder, ctx.usdcIsCurrency0, USDC(500))).wait();
        const shares = await ctx.vault.balanceOf(ctx.alice.address);
        const aVlt = await ctx.vlt.balanceOf(ctx.alice.address);
        const aUsdc = await ctx.usdc.balanceOf(ctx.alice.address);
        const [pVlt, pUsdc] = await ctx.vault.previewRedeem(shares / 10n);
        const rcRed = await (await redeem(ctx, ctx.alice, shares / 10n)).wait();
        const fr = await getEvent(ctx.vault, rcRed, "FeesRetained");
        expect(fr.usdcFees).to.be.greaterThan(0n);
        expect(fr.vltFees).to.equal(0n);

        // 3. Redeem event + previewRedeem match the actual per-token wallet deltas.
        const red = await getEvent(ctx.vault, rcRed, "Redeem");
        expect((await ctx.vlt.balanceOf(ctx.alice.address)) - aVlt).to.equal(red.vltOut);
        expect((await ctx.usdc.balanceOf(ctx.alice.address)) - aUsdc).to.equal(red.usdcOut);
        const near2 = (a, b) => expect(a > b ? a - b : b - a).to.be.lessThanOrEqual(2n);
        near2(pVlt, red.vltOut);
        near2(pUsdc, red.usdcOut);

        // 4. Compound: the finder's per-token wallet deltas match the token-named finder cut.
        await (await swapExact(ctx, ctx.seeder, ctx.usdcIsCurrency0, USDC(500))).wait();
        const fVlt = await ctx.vlt.balanceOf(ctx.finder.address);
        const fUsdc = await ctx.usdc.balanceOf(ctx.finder.address);
        const rcCmp = await (await compound(ctx, ctx.finder)).wait();
        const cmp = await getEvent(ctx.vault, rcCmp, "Compound");
        expect(cmp.usdcFees).to.be.greaterThan(0n);
        expect((await ctx.vlt.balanceOf(ctx.finder.address)) - fVlt).to.equal(cmp.vltFinder);
        expect((await ctx.usdc.balanceOf(ctx.finder.address)) - fUsdc).to.equal(cmp.usdcFinder);
      });
    }
  });
});

describe("VltUsdcVault — fee-growth ring + trailing APR", () => {
  const WAD = 10n ** 18n;

  it("snapshots L/share at most once per UTC day, into the ring", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    expect(await ctx.vault.lastSnapshotDay()).to.equal(0n); // nothing recorded before any compound

    // First compound → writes slot 0 with a post-compound L/share > 1.0.
    await feeBurst(ctx, 4);
    await (await compound(ctx, ctx.finder)).wait();
    const day1 = await ctx.vault.lastSnapshotDay();
    expect(day1).to.be.greaterThan(0n);
    expect(await ctx.vault.feeHistoryHead()).to.equal(0n);
    const s0 = await ctx.vault.feeHistory(0);
    expect(s0.timestamp).to.be.greaterThan(0n);
    expect(s0.perShareWad).to.be.greaterThan(WAD);

    // Second compound the SAME day → no new slot, head and day unchanged.
    await feeBurst(ctx, 4);
    await (await compound(ctx, ctx.finder)).wait();
    expect(await ctx.vault.feeHistoryHead()).to.equal(0n);
    expect(await ctx.vault.lastSnapshotDay()).to.equal(day1);

    // A new day → next compound advances the head to slot 1.
    await time.increase(DAY);
    await feeBurst(ctx, 4);
    await (await compound(ctx, ctx.finder)).wait();
    expect(await ctx.vault.feeHistoryHead()).to.equal(1n);
    expect(await ctx.vault.lastSnapshotDay()).to.be.greaterThan(day1);
  });

  it("wraps the 35-slot ring, overwriting the oldest snapshot", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    // 37 daily compounds: head walks 0..34 then wraps → (37-1) % 35 = 1.
    for (let d = 0; d < 37; d++) {
      await feeBurst(ctx, 3);
      await (await compound(ctx, ctx.finder)).wait();
      await time.increase(DAY);
    }
    expect(await ctx.vault.feeHistoryHead()).to.equal(1n);
    for (let i = 0; i < 35; i++) {
      expect((await ctx.vault.feeHistory(i)).timestamp).to.be.greaterThan(0n); // every slot filled
    }
  });

  it("feeApr(): zero before history, positive once enough days accrue", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    let apr = await ctx.vault.feeApr();
    expect(apr.lifetimeBps).to.equal(0n); // no growth yet
    expect(apr.d7Bps).to.equal(0n);
    expect(apr.d30Bps).to.equal(0n);

    // ~10 days, one compound per day.
    for (let d = 0; d < 10; d++) {
      await feeBurst(ctx, 4);
      await (await compound(ctx, ctx.finder)).wait();
      await time.increase(DAY);
    }

    apr = await ctx.vault.feeApr();
    expect(apr.lifetimeBps).to.be.greaterThan(0n); // L/share grew since inception
    expect(apr.d7Bps).to.be.greaterThan(0n); // ≥ 7 days of history exists
    expect(apr.d30Bps).to.equal(0n); // < 30 days of history → no snapshot that old yet
  });

  it("30d window stays serviceable under daily compounding (ring headroom)", async () => {
    // 33 daily compounds, then query WITHOUT a trailing time bump (now ≈ the newest snapshot). The
    // ≥30-day-old snapshot the 30d window needs must still be retained — this fails at LEN == 30
    // (the boundary slot is evicted) and passes only with the headroom (LEN = 35).
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    for (let d = 0; d < 33; d++) {
      if (d > 0) await time.increase(DAY); // advance BEFORE compounding so no trailing time bump
      await feeBurst(ctx, 3);
      await (await compound(ctx, ctx.finder)).wait();
    }
    const apr = await ctx.vault.feeApr();
    expect(apr.d30Bps).to.be.greaterThan(0n);
  });
});
