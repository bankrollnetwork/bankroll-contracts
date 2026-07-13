// Gas experiment for the proposed deposit-triggered auto-compound.
//
// Runs unchanged on BOTH the unmodified vault (baseline) and the prototype
// (threshold-gated `try this.autoCompound(msg.sender)` at the top of deposit()).
// It prints "GAS <label> <gasUsed>" lines for comparison and logs whether a
// Compound event fired inside each measured call, plus the caller's leftover
// balances (which surface the 1% finder rebate on the prototype).
//
// No hard gas assertions — this is a measurement harness, not a regression test.

const { expect } = require("chai");
const {
  deployVaultFixture,
  deposit,
  zapDeposit,
  compound,
  generateFees,
  removeBaseLiquidity,
} = require("./helpers/setup");

const USDC = (n) => BigInt(n) * 10n ** 6n;

// Push volume until compoundClaimable() reports at least `targetUsdc` of value.
async function accrueFeesTo(ctx, targetUsdc) {
  for (let i = 0; i < 8; i++) {
    const [, , valueUsdc] = await ctx.vault.compoundClaimable();
    if (valueUsdc >= targetUsdc) return valueUsdc;
    await generateFees(ctx, { rounds: 5, usdcPerSwap: USDC(2000) });
  }
  const [, , valueUsdc] = await ctx.vault.compoundClaimable();
  if (valueUsdc < targetUsdc) throw new Error(`could not accrue ${targetUsdc}, got ${valueUsdc}`);
  return valueUsdc;
}

// Did the vault emit Compound inside this receipt?
function compoundFired(ctx, receipt) {
  const topic = ctx.vault.interface.getEvent("Compound").topicHash;
  return receipt.logs.some(
    (l) => l.address.toLowerCase() === ctx.vault.target.toLowerCase() && l.topics[0] === topic
  );
}

function logGas(label, receipt, extra = "") {
  console.log(`      GAS ${label} ${receipt.gasUsed}${extra ? " " + extra : ""}`);
}

describe("gas: deposit-triggered auto-compound experiment", function () {
  it("S1: quiet direct deposit (no pending fees)", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait(); // seed
    const [, , claimable] = await ctx.vault.compoundClaimable();
    const rcpt = await (await deposit(ctx, ctx.bob, USDC(5_000))).wait();
    logGas("quiet_deposit", rcpt, `claimable=${claimable} compound=${compoundFired(ctx, rcpt)}`);
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.gt(0n);
  });

  it("S2: direct deposit with >= $100 claimable (auto-compound trigger case)", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
    await removeBaseLiquidity(ctx); // vault becomes sole LP: all pool fees are the vault's
    const claimable = await accrueFeesTo(ctx, USDC(120));
    const liqBefore = await ctx.vault.positionLiquidity();
    const rcpt = await (await deposit(ctx, ctx.carol, USDC(5_000))).wait();
    const liqAfter = await ctx.vault.positionLiquidity();
    const [, , claimAfter] = await ctx.vault.compoundClaimable();
    logGas(
      "trigger_deposit",
      rcpt,
      `claimableBefore=${claimable} claimableAfter=${claimAfter} compound=${compoundFired(ctx, rcpt)} dLiq=${liqAfter - liqBefore}`
    );
    // Finder-rebate visibility: leftovers the depositor holds after refunds (baseline: refund
    // dust only; prototype: refund dust + 1% finder fee in kind).
    console.log(
      `      LEFTOVER carol vlt=${await ctx.vlt.balanceOf(ctx.carol.address)} usdc=${await ctx.usdc.balanceOf(ctx.carol.address)}`
    );
    expect(await ctx.vault.balanceOf(ctx.carol.address)).to.be.gt(0n);
  });

  it("S3: keeper path — standalone compound(), then the same deposit", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
    await removeBaseLiquidity(ctx);
    await accrueFeesTo(ctx, USDC(120));
    const rcptC = await (await compound(ctx, ctx.finder)).wait();
    logGas("keeper_compound", rcptC, `compound=${compoundFired(ctx, rcptC)}`);
    const rcptD = await (await deposit(ctx, ctx.carol, USDC(5_000))).wait();
    logGas("post_compound_deposit", rcptD, `compound=${compoundFired(ctx, rcptD)}`);
    console.log(`      GAS keeper_path_total ${rcptC.gasUsed + rcptD.gasUsed}`);
  });

  it("S4: quiet zapDeposit (no pending fees)", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
    const rcpt = await (await zapDeposit(ctx, ctx.bob, USDC(5_000))).wait();
    logGas("quiet_zap", rcpt, `compound=${compoundFired(ctx, rcpt)}`);
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.gt(0n);
  });

  it("S5: zapDeposit with >= $100 claimable (trigger via periphery)", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
    await removeBaseLiquidity(ctx);
    const claimable = await accrueFeesTo(ctx, USDC(120));
    const usdcBefore = await ctx.usdc.balanceOf(ctx.bob.address);
    const rcpt = await (await zapDeposit(ctx, ctx.bob, USDC(5_000))).wait();
    logGas("trigger_zap", rcpt, `claimableBefore=${claimable} compound=${compoundFired(ctx, rcpt)}`);
    // The helper must hold nothing afterwards; any finder rebate must have been swept to bob.
    console.log(
      `      LEFTOVER bob vlt=${await ctx.vlt.balanceOf(ctx.bob.address)} usdc=${(await ctx.usdc.balanceOf(ctx.bob.address)) - usdcBefore + USDC(5_000)}` // eslint-disable-line
    );
    expect(await ctx.vlt.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    expect(await ctx.usdc.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.gt(0n);
  });
});
