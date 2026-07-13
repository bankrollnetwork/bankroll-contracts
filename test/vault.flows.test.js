const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  balancedVlt,
  fundUsdc,
  deposit,
  redeem,
  triggerCompound,
  accrueFeesTo,
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

// Non-throwing presence check (getEvent throws when absent).
function hasEvent(vault, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = vault.interface.parseLog(log);
      if (parsed && parsed.name === name) return true;
    } catch (_) {}
  }
  return false;
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

  describe("auto-compound (deposit-triggered)", () => {
    it("a threshold-crossing deposit compounds: 100% reinvests (no fee), shares mint only for the deposit", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      await accrueFeesTo(ctx, USDC(120));

      const supplyBefore = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();
      const trigVltBefore = await ctx.vlt.balanceOf(ctx.finder.address);
      const trigUsdcBefore = await ctx.usdc.balanceOf(ctx.finder.address);

      // A small deposit runs the compound leg first.
      const trigUsdc = USDC(10);
      const trigVlt = balancedVlt(ctx, trigUsdc);
      const rc = await (await triggerCompound(ctx, ctx.finder, trigUsdc)).wait();
      const cmp = await getEvent(ctx.vault, rc, "Compound");
      const dep = await getEvent(ctx.vault, rc, "Deposit");

      // The compound leg minted NO shares — supply grew only by the deposit's own mint.
      expect(await ctx.vault.totalSupply()).to.equal(supplyBefore + dep.sharesOut);
      // Liquidity grew by exactly the two legs: fees reinvested + the deposit's own add.
      expect(cmp.liquidityAdded).to.be.greaterThan(0n);
      expect(await ctx.vault.positionLiquidity()).to.equal(
        lBefore + cmp.liquidityAdded + dep.liquidityAdded
      );
      expect(cmp.vltFees + cmp.usdcFees).to.be.greaterThan(0n); // a real harvest happened

      // NO fee of any kind: the trigger depositor's wallet delta is EXACTLY the deposit refund.
      // (The helper mints exactly what the vault pulls, so delta = refund + any payout — and the
      // payout must be zero.)
      const vltDelta = (await ctx.vlt.balanceOf(ctx.finder.address)) - trigVltBefore;
      const usdcDelta = (await ctx.usdc.balanceOf(ctx.finder.address)) - trigUsdcBefore;
      expect(vltDelta).to.equal(trigVlt - dep.vltUsed);
      expect(usdcDelta).to.equal(trigUsdc - dep.usdcUsed);
    });

    it("a deposit below the threshold does NOT compound (no event, claimable value carries over)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      // A little volume: claimable lands between the $0 floor and the $100 trigger.
      await generateFees(ctx, { rounds: 2, usdcPerSwap: USDC(500) });
      const [, , before] = await ctx.vault.compoundClaimable();
      expect(before).to.be.greaterThan(0n);
      expect(before).to.be.lessThan(USDC(100));

      const rc = await (await deposit(ctx, ctx.bob, USDC(5000))).wait();
      expect(hasEvent(ctx.vault, rc, "Compound")).to.equal(false);

      // The deposit converts pending fees to retained balance but the total claimable value
      // is preserved (same amounts, same spot price) — nothing was reinvested or paid out.
      const [, , after] = await ctx.vault.compoundClaimable();
      const diff = after > before ? after - before : before - after;
      expect(diff).to.be.lessThanOrEqual(2n);
    });

    it("auto-rebalances ONE-SIDED fees into liquidity with no caller args", async () => {
      // Fees accrue almost entirely on currency0 (one-direction volume). WITHOUT the internal
      // rebalance swap, getLiquidityForAmounts(amount0, ~0) = 0 → a one-sided harvest adds ZERO
      // liquidity. So the Compound leg's liquidityAdded > 0 is direct proof the rebalance ran.
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      for (let k = 0; k < 20; k++) {
        const [, , v] = await ctx.vault.compoundClaimable();
        if (v >= USDC(120)) break;
        await (await swapExact(ctx, ctx.seeder, true, 2000n * 10n ** BigInt(c0Dec))).wait();
      }

      const lBefore = await ctx.vault.positionLiquidity();
      const rc = await (await triggerCompound(ctx, ctx.finder)).wait();
      const { liquidityAdded } = await getEvent(ctx.vault, rc, "Compound");
      expect(liquidityAdded).to.be.greaterThan(0n);
      expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
    });

    it("rebalance swap is capped by fresh fees: a one-sided donation alone is never swapped", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(10000));
      await (await deposit(ctx, ctx.alice, USDC(10000))).wait();

      // Donate one-sided USDC straight to the vault (over the $100 trigger) with NO fresh fees.
      const donation = USDC(150);
      await (await ctx.usdc.mint(ctx.vault.target, donation)).wait();

      // The next deposit triggers the compound leg, but this harvest collects ~0 fees, so the
      // rebalance cap (REBALANCE_CAP_MULT × fresh fees) is 0: the vault must never trade held
      // balances at spot without freshly-accrued fees sizing the swap. One-sided → nothing can
      // be placed either, so the leg runs but reinvests nothing and the donation folds forward.
      const rc = await (await triggerCompound(ctx, ctx.bob)).wait();
      const cmp = await getEvent(ctx.vault, rc, "Compound");
      expect(cmp.liquidityAdded).to.equal(0n);
      expect(await ctx.usdc.balanceOf(ctx.vault.target)).to.equal(donation); // untouched
      expect(await ctx.vlt.balanceOf(ctx.vault.target)).to.equal(0n); // no swap happened

      // Once fresh fees exist the (fee-scaled) rebalance runs and the donation starts folding in.
      await generateFees(ctx, { rounds: 4 });
      const lBefore = await ctx.vault.positionLiquidity();
      await (await triggerCompound(ctx, ctx.bob)).wait();
      expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
      expect(await ctx.usdc.balanceOf(ctx.vault.target)).to.be.lessThan(donation);
    });

    it("trigger threshold is a fixed $100 constant, no setter, and no public compound exists", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      expect(await ctx.vault.AUTO_COMPOUND_MIN_USDC()).to.equal(USDC(100));
      const fns = ctx.vault.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      // No public compound entrypoint — compounding rides exclusively on deposits.
      expect(fns).to.not.include("compound");
      // No setter of any kind — the trigger can never be moved (no DoS / governance lever).
      expect(fns.some((n) => n.startsWith("set"))).to.equal(false);
    });

    it("keeps NAV/share monotonic even when the price is pushed before the trigger", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
      await accrueFeesTo(ctx, USDC(120));

      const aliceShares = await ctx.vault.balanceOf(ctx.alice.address);
      const supplyBefore = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();
      const navBefore = (lBefore * aliceShares) / supplyBefore;

      // Attacker front-runs with a large one-way swap to push the pool price hard.
      const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
      await (await swapExact(ctx, ctx.seeder, true, 200000n * 10n ** BigInt(c0Dec))).wait();

      const rc = await (await triggerCompound(ctx, ctx.finder)).wait();
      expect(hasEvent(ctx.vault, rc, "Compound")).to.equal(true);

      // Existing-holder NAV (liquidity claim) never drops: the compound leg only adds L against
      // a flat supply, and the trigger deposit mints pro-rata (rounded down, in holders' favor).
      const lAfter = await ctx.vault.positionLiquidity();
      const supplyAfter = await ctx.vault.totalSupply();
      const navAfter = (lAfter * aliceShares) / supplyAfter;
      expect(navAfter).to.be.greaterThanOrEqual(navBefore);
    });

    it("auto-compound never decreases a holder's redemption value (NAV/share monotonic)", async () => {
      const ctx = await loadFixture(deployVaultFixture);
      await fundUsdc(ctx, ctx.alice, USDC(50000));
      await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

      const aliceShares = await ctx.vault.balanceOf(ctx.alice.address);
      const supplyBefore = await ctx.vault.totalSupply();
      const lBefore = await ctx.vault.positionLiquidity();
      const navBefore = (lBefore * aliceShares) / supplyBefore;

      await accrueFeesTo(ctx, USDC(120));
      const rc = await (await triggerCompound(ctx, ctx.finder)).wait();
      expect(hasEvent(ctx.vault, rc, "Compound")).to.equal(true);

      const lAfter = await ctx.vault.positionLiquidity();
      const supplyAfter = await ctx.vault.totalSupply();
      const navAfter = (lAfter * aliceShares) / supplyAfter;
      expect(navAfter).to.be.greaterThan(navBefore); // fees reinvested → strictly richer claim
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

        // 4. Auto-compound: one-sided USDC volume must surface as token-named usdcFees, and the
        //    trigger depositor receives nothing beyond the deposit's own refund (no fee).
        for (let k = 0; k < 20; k++) {
          const [, , v] = await ctx.vault.compoundClaimable();
          if (v >= USDC(120)) break;
          await (await swapExact(ctx, ctx.seeder, ctx.usdcIsCurrency0, USDC(2000))).wait();
        }
        const fVlt = await ctx.vlt.balanceOf(ctx.finder.address);
        const fUsdc = await ctx.usdc.balanceOf(ctx.finder.address);
        const trigUsdc = USDC(10);
        const trigVlt = balancedVlt(ctx, trigUsdc);
        const rcCmp = await (await triggerCompound(ctx, ctx.finder, trigUsdc)).wait();
        const cmp = await getEvent(ctx.vault, rcCmp, "Compound");
        const dep4 = await getEvent(ctx.vault, rcCmp, "Deposit");
        expect(cmp.usdcFees).to.be.greaterThan(0n);
        const vltDelta = (await ctx.vlt.balanceOf(ctx.finder.address)) - fVlt;
        const usdcDelta = (await ctx.usdc.balanceOf(ctx.finder.address)) - fUsdc;
        expect(vltDelta).to.equal(trigVlt - dep4.vltUsed);
        expect(usdcDelta).to.equal(trigUsdc - dep4.usdcUsed);
      });
    }
  });
});

describe("VltUsdcVault — fee-growth ring + trailing APR", () => {
  const WAD = 10n ** 18n;

  // Price-neutral fee accrual to the auto-compound trigger: round-trip bursts until claimable
  // crosses `targetUsdc` (feeBurst returns the price to ~start, so multi-day loops don't drift).
  async function feeBurstTo(ctx, targetUsdc) {
    for (let i = 0; i < 15; i++) {
      const [, , v] = await ctx.vault.compoundClaimable();
      if (v >= targetUsdc) return;
      await feeBurst(ctx, 2);
    }
    throw new Error("feeBurstTo: could not accrue enough fees");
  }

  // Arm the threshold and fire it with a small trigger deposit (carol is the daily depositor).
  async function dailyCompound(ctx) {
    await feeBurstTo(ctx, USDC(120));
    await (await triggerCompound(ctx, ctx.carol)).wait();
  }

  it("snapshots L/share at most once per UTC day, into the ring", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    expect(await ctx.vault.lastSnapshotDay()).to.equal(0n); // nothing recorded before any compound

    // First triggering deposit → writes slot 0 with a post-compound L/share > 1.0. (The snapshot
    // runs inside the compound leg, BEFORE the trigger deposit's own liquidity add.)
    await dailyCompound(ctx);
    const day1 = await ctx.vault.lastSnapshotDay();
    expect(day1).to.be.greaterThan(0n);
    expect(await ctx.vault.feeHistoryHead()).to.equal(0n);
    const s0 = await ctx.vault.feeHistory(0);
    expect(s0.timestamp).to.be.greaterThan(0n);
    expect(s0.perShareWad).to.be.greaterThan(WAD);

    // Second triggering deposit the SAME day → no new slot, head and day unchanged.
    await dailyCompound(ctx);
    expect(await ctx.vault.feeHistoryHead()).to.equal(0n);
    expect(await ctx.vault.lastSnapshotDay()).to.equal(day1);

    // A new day → the next triggering deposit advances the head to slot 1.
    await time.increase(DAY);
    await dailyCompound(ctx);
    expect(await ctx.vault.feeHistoryHead()).to.equal(1n);
    expect(await ctx.vault.lastSnapshotDay()).to.be.greaterThan(day1);
  });

  it("wraps the 35-slot ring, overwriting the oldest snapshot", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    // 37 daily triggering deposits: head walks 0..34 then wraps → (37-1) % 35 = 1.
    for (let d = 0; d < 37; d++) {
      await dailyCompound(ctx);
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

    // ~10 days, one triggering deposit per day.
    for (let d = 0; d < 10; d++) {
      await dailyCompound(ctx);
      await time.increase(DAY);
    }

    apr = await ctx.vault.feeApr();
    expect(apr.lifetimeBps).to.be.greaterThan(0n); // L/share grew since inception
    expect(apr.d7Bps).to.be.greaterThan(0n); // ≥ 7 days of history exists
    expect(apr.d30Bps).to.equal(0n); // < 30 days of history → no snapshot that old yet
  });

  it("30d window stays serviceable under daily compounding (ring headroom)", async () => {
    // 33 daily triggering deposits, then query WITHOUT a trailing time bump (now ≈ the newest
    // snapshot). The ≥30-day-old snapshot the 30d window needs must still be retained — this
    // fails at LEN == 30 (the boundary slot is evicted) and passes only with headroom (LEN = 35).
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();

    for (let d = 0; d < 33; d++) {
      if (d > 0) await time.increase(DAY); // advance BEFORE compounding so no trailing time bump
      await dailyCompound(ctx);
    }
    const apr = await ctx.vault.feeApr();
    expect(apr.d30Bps).to.be.greaterThan(0n);
  });
});
