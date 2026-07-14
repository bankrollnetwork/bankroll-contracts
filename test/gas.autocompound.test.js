// Gas measurements for the deposit-triggered auto-compound (threshold-gated internal
// _compound() call at the top of deposit(); public compound() wraps the same leg).
// It prints "GAS <label> <gasUsed>" lines for comparison and logs whether a
// Compound event fired inside each measured call, plus the caller's leftover
// balances (which must now be pure deposit refunds — no fee is paid to anyone).
//
// No hard gas assertions — this is a measurement harness, not a regression test.

const { expect } = require("chai");
const {
  deployVaultFixture,
  deposit,
  zapDeposit,
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
    // Leftover visibility: what the depositor holds after refunds (must be refund
    // dust only — no fee of any kind).
    console.log(
      `      LEFTOVER carol vlt=${await ctx.vlt.balanceOf(ctx.carol.address)} usdc=${await ctx.usdc.balanceOf(ctx.carol.address)}`
    );
    expect(await ctx.vault.balanceOf(ctx.carol.address)).to.be.gt(0n);
  });

  it("S3: deposit right after a trigger (nothing left to compound)", async function () {
    const ctx = await deployVaultFixture();
    await (await deposit(ctx, ctx.alice, USDC(10_000))).wait();
    await removeBaseLiquidity(ctx);
    await accrueFeesTo(ctx, USDC(120));
    const rcptT = await (await deposit(ctx, ctx.finder, USDC(5_000))).wait();
    logGas("trigger_deposit_2", rcptT, `compound=${compoundFired(ctx, rcptT)}`);
    const rcptD = await (await deposit(ctx, ctx.carol, USDC(5_000))).wait();
    logGas("post_trigger_deposit", rcptD, `compound=${compoundFired(ctx, rcptD)}`);
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
    // The helper must hold nothing afterwards.
    console.log(
      `      LEFTOVER bob vlt=${await ctx.vlt.balanceOf(ctx.bob.address)} usdc=${(await ctx.usdc.balanceOf(ctx.bob.address)) - usdcBefore + USDC(5_000)}` // eslint-disable-line
    );
    expect(await ctx.vlt.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    expect(await ctx.usdc.balanceOf(ctx.zapHelper.target)).to.equal(0n);
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.gt(0n);
  });
});
