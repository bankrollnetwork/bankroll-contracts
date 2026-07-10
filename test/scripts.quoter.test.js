const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployVaultFixture, zapDeposit } = require("./helpers/setup");
const { readSqrtPriceX96, priceUsdcPerVlt, quoteDeposit, poolId } = require("../scripts/lib/pool");

const USDC = (n) => BigInt(Math.round(n * 1e6));

// Medium-depth pool: a normal deposit's self-impact stays under the 1% slippage bound,
// but a fat sandwich swap can still push price past it.
const mediumFixture = () => deployVaultFixture({ baseLiquidity: 10n ** 18n });

describe("scripts/lib/pool — on-chain reads + off-chain quoter", () => {
  it("reads the live sqrtPriceX96 and decodes ~the initial USDC/VLT price", async () => {
    const ctx = await loadFixture(mediumFixture);

    const sqrtP = await readSqrtPriceX96(ctx.poolManager.target, ctx.poolKey);
    expect(sqrtP).to.equal(ctx.sqrtPriceX96); // matches what we initialized with

    const price = priceUsdcPerVlt(sqrtP, {
      usdcIsCurrency0: ctx.usdcIsCurrency0,
      vltDecimals: ctx.cfg.vltDecimals,
      usdcDecimals: ctx.cfg.usdcDecimals,
    });
    expect(price).to.be.closeTo(ctx.cfg.usdcPerVlt, ctx.cfg.usdcPerVlt * 0.01);
  });

  it("poolId matches keccak of the abi-encoded PoolKey", async () => {
    const ctx = await loadFixture(mediumFixture);
    const id = poolId(ctx.poolKey);
    // Re-encode independently as a cross-check.
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const expected = ethers.keccak256(
      coder.encode(
        ["address", "address", "uint24", "int24", "address"],
        [
          ctx.poolKey.currency0,
          ctx.poolKey.currency1,
          ctx.poolKey.fee,
          ctx.poolKey.tickSpacing,
          ctx.poolKey.hooks,
        ]
      )
    );
    expect(id).to.equal(expected);
  });

  it("the deposit quote drives a ZapHelper deposit with negligible dust", async () => {
    const ctx = await loadFixture(mediumFixture);
    const usdcAmount = USDC(10000);

    const sqrtP = await readSqrtPriceX96(ctx.poolManager.target, ctx.poolKey);
    const q = quoteDeposit({
      usdcAmount,
      sqrtPriceX96: sqrtP,
      usdcIsCurrency0: ctx.usdcIsCurrency0,
      vltDecimals: ctx.cfg.vltDecimals,
      usdcDecimals: ctx.cfg.usdcDecimals,
      feeBps: ctx.cfg.fee,
      slippageBps: 100,
    });

    // Deposit USDC through the periphery ZapHelper (buys VLT externally, LPs into the vault).
    await (
      await zapDeposit(ctx, ctx.alice, usdcAmount, {
        swapUsdcToVlt: q.swapUsdcToVlt,
        minVltOut: q.minVltOut,
        minShares: q.minShares,
      })
    ).wait();

    // Dust forwarded back to alice (vault refund + swap residual), valued in USDC.
    const dustUsdc = await ctx.usdc.balanceOf(ctx.alice.address);
    const dustVlt = await ctx.vlt.balanceOf(ctx.alice.address);
    const dustVltValue = (dustVlt * BigInt(ctx.cfg.usdcPerVlt) * 10n ** 6n) / 10n ** 18n;
    expect(dustUsdc + dustVltValue).to.be.lessThan(USDC(200)); // < 2% of 10k
    expect(await ctx.vault.balanceOf(ctx.alice.address)).to.be.greaterThan(0n);
  });

  it("zapDeposit mints shares DIRECTLY to `recipient` — no forwarding hop; dust to the caller", async () => {
    const ctx = await loadFixture(mediumFixture);
    const rc = await (
      await zapDeposit(ctx, ctx.alice, USDC(10000), { recipient: ctx.bob.address })
    ).wait();

    // Shares land on the recipient in one hop: caller and helper never hold any.
    expect(await ctx.vault.balanceOf(ctx.bob.address)).to.be.greaterThan(0n);
    expect(await ctx.vault.balanceOf(ctx.alice.address)).to.equal(0n);
    expect(await ctx.vault.balanceOf(ctx.zapHelper.target)).to.equal(0n);

    // The vault's Deposit event attributes the zap to the end wallet, with the helper as payer.
    const ev = ctx.vault.interface.parseLog(
      rc.logs.find((l) => {
        try {
          return ctx.vault.interface.parseLog(l)?.name === "Deposit";
        } catch {
          return false;
        }
      })
    );
    expect(ev.args.sender).to.equal(ctx.zapHelper.target);
    expect(ev.args.recipient).to.equal(ctx.bob.address);

    // Dust (vault refund / swap residual) sweeps to the CALLER, who paid.
    expect(await ctx.vlt.balanceOf(ctx.bob.address)).to.equal(0n);
    expect(await ctx.usdc.balanceOf(ctx.bob.address)).to.equal(0n);
  });

  it("zapDeposit rejects a bad split (swapUsdcToVlt >= usdcAmount)", async () => {
    const ctx = await loadFixture(mediumFixture);
    const usdcAmount = USDC(10000);
    await (await ctx.usdc.mint(ctx.alice.address, usdcAmount)).wait();
    await (await ctx.usdc.connect(ctx.alice).approve(ctx.zapHelper.target, ethers.MaxUint256)).wait();
    await expect(
      ctx.zapHelper
        .connect(ctx.alice)
        .zapDeposit(usdcAmount, usdcAmount, 0, 0, ethers.MaxUint256, ctx.alice.address, "0x")
    ).to.be.revertedWith("bad-split");
  });

  it("zapDeposit past its deadline reverts before the swap leg runs", async () => {
    const ctx = await loadFixture(mediumFixture);
    const vltReserveBefore = await ctx.mockRouter.vltReserve();
    await expect(zapDeposit(ctx, ctx.alice, USDC(10000), { deadline: 1n })).to.be.revertedWith(
      "expired"
    );
    // The external-market swap never executed (deadline is checked first).
    expect(await ctx.mockRouter.vltReserve()).to.equal(vltReserveBefore);
  });

  it("a zap deposit sources VLT from the external market (buy pressure: VLT reserve drops)", async () => {
    const ctx = await loadFixture(mediumFixture);
    const vltReserveBefore = await ctx.mockRouter.vltReserve();
    const lBefore = await ctx.vault.positionLiquidity();

    await (await zapDeposit(ctx, ctx.alice, USDC(10000))).wait();

    // VLT was bought out of the external market (the price-lifting buy pressure)...
    expect(await ctx.mockRouter.vltReserve()).to.be.lessThan(vltReserveBefore);
    // ...and shifted into the vault's V4 position.
    expect(await ctx.vault.positionLiquidity()).to.be.greaterThan(lBefore);
  });

  it("minVltOut bound holds under a sandwich on the external market (zap reverts)", async () => {
    const ctx = await loadFixture(mediumFixture);
    const usdcAmount = USDC(10000);

    // Quote minVltOut at the clean price.
    const sqrtP = await readSqrtPriceX96(ctx.poolManager.target, ctx.poolKey);
    const q = quoteDeposit({
      usdcAmount,
      sqrtPriceX96: sqrtP,
      usdcIsCurrency0: ctx.usdcIsCurrency0,
      vltDecimals: ctx.cfg.vltDecimals,
      usdcDecimals: ctx.cfg.usdcDecimals,
      feeBps: ctx.cfg.fee,
      slippageBps: 100,
    });

    // Attacker front-runs by buying VLT from the SAME external market the zap routes through,
    // spiking its price so alice's USDC sources far less VLT than her quoted minVltOut.
    await (await ctx.usdc.mint(ctx.bob.address, USDC(5_000_000))).wait();
    await (await ctx.usdc.connect(ctx.bob).approve(ctx.mockRouter.target, ethers.MaxUint256)).wait();
    await (await ctx.mockRouter.connect(ctx.bob).swapUsdcForVlt(USDC(5_000_000), ctx.bob.address)).wait();

    await expect(
      zapDeposit(ctx, ctx.alice, usdcAmount, {
        swapUsdcToVlt: q.swapUsdcToVlt,
        minVltOut: q.minVltOut,
        minShares: q.minShares,
      })
    ).to.be.revertedWith("zap-slippage");
  });
});
