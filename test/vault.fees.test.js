const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployVaultFixture,
  fundUsdc,
  deposit,
  redeem,
  compound,
  swapExact,
  removeBaseLiquidity,
} = require("./helpers/setup");

const USDC = (n) => BigInt(Math.round(n * 1e6));

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

// Within `bps` relative tolerance (V4 fee-growth uses per-liquidity Q128 rounding).
function near(actual, expected, bps, label) {
  const diff = actual > expected ? actual - expected : expected - actual;
  expect(actual, `${label}: expected > 0`).to.be.greaterThan(0n);
  expect(diff * 10000n, `${label}: ${actual} vs ${expected}`).to.be.lessThanOrEqual(expected * BigInt(bps));
}

// BUG-1 fix: in V4 every modifyLiquidity realizes the position's FULL accrued fees into
// callerDelta. The vault must hand the caller only their PRINCIPAL and retain the fees at
// address(this) for all holders (folding forward into the next compound). These tests pin
// that: a deposit/redeem after fees accrue leaves the gross fees in the vault, not the user.
describe("VltUsdcVault — fees stay with the vault on deposit/redeem (BUG-1 fix)", () => {
  // Sole-LP fixture + known volume so gross fees are computable.
  async function setupWithFees(ctx) {
    await removeBaseLiquidity(ctx); // vault becomes the sole LP
    const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
    const c1Dec = ctx.usdcIsCurrency0 ? ctx.cfg.vltDecimals : ctx.cfg.usdcDecimals;
    let gross0 = 0n;
    let gross1 = 0n;
    for (let i = 0; i < 6; i++) {
      const in0 = 50n * 10n ** BigInt(c0Dec);
      const in1 = 50n * 10n ** BigInt(c1Dec);
      await (await swapExact(ctx, ctx.seeder, true, in0)).wait();
      gross0 += (in0 * BigInt(ctx.cfg.fee)) / 1_000_000n;
      await (await swapExact(ctx, ctx.seeder, false, in1)).wait();
      gross1 += (in1 * BigInt(ctx.cfg.fee)) / 1_000_000n;
    }
    const c0Token = ctx.usdcIsCurrency0 ? ctx.usdc : ctx.vlt;
    const c1Token = ctx.usdcIsCurrency0 ? ctx.vlt : ctx.usdc;
    return { gross0, gross1, c0Token, c1Token };
  }

  it("redeem retains the position's uncompounded fees at the vault (caller gets principal only)", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
    const { gross0, gross1, c0Token, c1Token } = await setupWithFees(ctx);

    // Vault holds no loose tokens before the redeem (fees are unrealized in the pool).
    expect(await c0Token.balanceOf(ctx.vault.target)).to.equal(0n);
    expect(await c1Token.balanceOf(ctx.vault.target)).to.equal(0n);

    const shares = await ctx.vault.balanceOf(ctx.alice.address);
    await (await redeem(ctx, ctx.alice, shares / 100n)).wait(); // redeem ~1%

    // The full gross fees are now retained at the vault — NOT swept by the 1% redeemer.
    near(await c0Token.balanceOf(ctx.vault.target), gross0, 200, "vault retained currency0 fees");
    near(await c1Token.balanceOf(ctx.vault.target), gross1, 200, "vault retained currency1 fees");
  });

  it("deposit retains pre-existing fees at the vault (depositor cannot grab them)", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
    const { gross0, gross1, c0Token, c1Token } = await setupWithFees(ctx);

    // Bob deposits while fees are pending; they must be harvested to the vault, not captured.
    await fundUsdc(ctx, ctx.bob, USDC(10000));
    await (await deposit(ctx, ctx.bob, USDC(10000))).wait();

    near(await c0Token.balanceOf(ctx.vault.target), gross0, 300, "vault retained currency0 fees");
    near(await c1Token.balanceOf(ctx.vault.target), gross1, 300, "vault retained currency1 fees");
    // Bob still received fair, non-zero shares for his own contribution.
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.greaterThan(0n);
  });

  it("retained fees fold forward: a later compound reinvests them into liquidity", async () => {
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
    const { c0Token, c1Token } = await setupWithFees(ctx);

    // Loose vault value in USDC terms (VLT marked at the ~2 USDC reference).
    const vaultValue = async () => {
      const v = await ctx.vlt.balanceOf(ctx.vault.target);
      const u = await ctx.usdc.balanceOf(ctx.vault.target);
      return u + (v * 2n * 10n ** 6n) / 10n ** 18n;
    };

    // Redeem retains the fees at the vault.
    const shares = await ctx.vault.balanceOf(ctx.alice.address);
    await (await redeem(ctx, ctx.alice, shares / 100n)).wait();
    const valueBefore = await vaultValue();
    expect(valueBefore).to.be.greaterThan(0n);

    const lBefore = await ctx.vault.positionLiquidity();
    // Generate a little more volume so compound has fresh fees to harvest, then compound.
    const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
    await (await swapExact(ctx, ctx.seeder, true, 50n * 10n ** BigInt(c0Dec))).wait();
    await (await compound(ctx, ctx.finder)).wait();

    // The retained fees were reinvested: loose vault value drops sharply and liquidity grew.
    // (Reinvest is ratio-limited so a dust remainder of the heavy side folds to next time.)
    expect(await vaultValue()).to.be.lessThan(valueBefore);
    expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
  });

  it("emits complete fee-accounting events for log-based adapters (FeesRetained + full Compound fees)", async () => {
    // Realized-fee accounting from logs alone: Σ FeesRetained + Σ Compound.fee must cover every
    // path that harvests pool fees (redeem, deposit, compound) — the DefiLlama-adapter contract.
    const ctx = await loadFixture(deployVaultFixture);
    await fundUsdc(ctx, ctx.alice, USDC(50000));
    await (await deposit(ctx, ctx.alice, USDC(50000))).wait();
    const { gross0, gross1 } = await setupWithFees(ctx);

    // 1. A redeem harvests the pending fees to the vault and reports the amounts.
    const shares = await ctx.vault.balanceOf(ctx.alice.address);
    const rcRedeem = await (await redeem(ctx, ctx.alice, shares / 100n)).wait();
    const evRedeem = await getEvent(ctx.vault, rcRedeem, "FeesRetained");
    near(evRedeem.fee0, gross0, 200, "redeem FeesRetained.fee0");
    near(evRedeem.fee1, gross1, 200, "redeem FeesRetained.fee1");

    // 2. Fresh one-sided volume, then a deposit harvests + reports it too.
    const c0Dec = ctx.usdcIsCurrency0 ? ctx.cfg.usdcDecimals : ctx.cfg.vltDecimals;
    const in0 = 200n * 10n ** BigInt(c0Dec);
    await (await swapExact(ctx, ctx.seeder, true, in0)).wait();
    const freshDep0 = (in0 * BigInt(ctx.cfg.fee)) / 1_000_000n;
    await fundUsdc(ctx, ctx.bob, USDC(10000));
    const rcDep = await (await deposit(ctx, ctx.bob, USDC(10000))).wait();
    const evDep = await getEvent(ctx.vault, rcDep, "FeesRetained");
    near(evDep.fee0, freshDep0, 300, "deposit FeesRetained.fee0");
    expect(evDep.fee1).to.equal(0n); // one-directional volume: no currency1 fees accrued

    // 3. More volume, then Compound reports the FULL fresh harvest with the 1% cut carved from it.
    await (await swapExact(ctx, ctx.seeder, true, in0)).wait();
    const freshCmp0 = (in0 * BigInt(ctx.cfg.fee)) / 1_000_000n;
    const rcCmp = await (await compound(ctx, ctx.finder)).wait();
    const evCmp = await getEvent(ctx.vault, rcCmp, "Compound");
    near(evCmp.fee0, freshCmp0, 300, "Compound.fee0 (full fresh harvest, not just the finder cut)");
    expect(evCmp.finder0).to.equal(evCmp.fee0 / 100n); // FINDER_FEE_BPS = 1% of the emitted fee
    expect(evCmp.finder1).to.equal(evCmp.fee1 / 100n);
  });
});
