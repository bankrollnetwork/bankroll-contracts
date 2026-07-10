const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// Deterministic coverage for the ZapHelper's PERMIT2 branch (the production path with the
// Universal Router) — without a mainnet fork. Uses a mock Permit2 + a router that pulls its
// input via Permit2, mirroring how the real Universal Router takes funds.
async function permit2Fixture() {
  const [deployer, alice] = await ethers.getSigners();

  const Mock = await ethers.getContractFactory("MockERC20");
  const tokenIn = await Mock.deploy("USD Coin", "USDC", 6);
  await tokenIn.waitForDeployment();
  const tokenOut = await Mock.deploy("Vault", "VLT", 18);
  await tokenOut.waitForDeployment();

  const Permit2 = await ethers.getContractFactory("MockPermit2");
  const permit2 = await Permit2.deploy();
  await permit2.waitForDeployment();

  const Router = await ethers.getContractFactory("MockPermit2Router");
  const router = await Router.deploy(permit2.target);
  await router.waitForDeployment();
  await (await tokenOut.mint(router.target, 10n ** 30n)).wait(); // output reserve

  // Minimal vault stub (only vlt()/usdc() are read at construction; the `zap` primitive under
  // test never calls the vault).
  const Stub = await ethers.getContractFactory("MockVaultStub");
  const stub = await Stub.deploy(tokenOut.target, tokenIn.target);
  await stub.waitForDeployment();

  // ZapHelper wired to use Permit2 (permit2 != 0 → the production branch).
  const Zap = await ethers.getContractFactory("ZapHelper");
  const zap = await Zap.deploy(router.target, permit2.target, stub.target);
  await zap.waitForDeployment();

  return { deployer, alice, tokenIn, tokenOut, permit2, router, zap };
}

function buildSwapData(ctx, tokenIn, tokenOut, amountIn, recipient) {
  return ctx.router.interface.encodeFunctionData("swap", [tokenIn, tokenOut, amountIn, recipient]);
}

describe("ZapHelper — Permit2 branch (Universal-Router-style pull)", () => {
  it("pulls input via Permit2, executes the route, and forwards the output (>= minOut)", async () => {
    const ctx = await loadFixture(permit2Fixture);
    const amountIn = 1000n * 10n ** 6n;

    await (await ctx.tokenIn.mint(ctx.alice.address, amountIn)).wait();
    await (await ctx.tokenIn.connect(ctx.alice).approve(ctx.zap.target, ethers.MaxUint256)).wait();

    // swapData routes output to the helper (it measures its own delta); helper forwards to alice.
    const swapData = buildSwapData(ctx, ctx.tokenIn.target, ctx.tokenOut.target, amountIn, ctx.zap.target);

    const out = await ctx.zap
      .connect(ctx.alice)
      .zap.staticCall(ctx.tokenIn.target, ctx.tokenOut.target, amountIn, amountIn, ctx.alice.address, swapData);
    expect(out).to.equal(amountIn); // mock router is 1:1 raw

    await (
      await ctx.zap
        .connect(ctx.alice)
        .zap(ctx.tokenIn.target, ctx.tokenOut.target, amountIn, amountIn, ctx.alice.address, swapData)
    ).wait();

    // Alice received the output; the helper kept nothing (stateless) and the Permit2 allowance
    // it set for the router was consumed.
    expect(await ctx.tokenOut.balanceOf(ctx.alice.address)).to.equal(amountIn);
    expect(await ctx.tokenOut.balanceOf(ctx.zap.target)).to.equal(0n);
    expect(await ctx.tokenIn.balanceOf(ctx.zap.target)).to.equal(0n);
    expect(await ctx.permit2.allowanceOf(ctx.zap.target, ctx.tokenIn.target, ctx.router.target)).to.equal(0n);
  });

  it("refunds unspent input to the CALLER, not the recipient", async () => {
    const ctx = await loadFixture(permit2Fixture);
    const amountIn = 1000n * 10n ** 6n;
    const consumed = 400n * 10n ** 6n;
    await (await ctx.tokenIn.mint(ctx.alice.address, amountIn)).wait();
    await (await ctx.tokenIn.connect(ctx.alice).approve(ctx.zap.target, ethers.MaxUint256)).wait();

    // The route consumes only 400 of the 1000 pulled; the output goes to a THIRD-PARTY recipient.
    // The 600 refund belongs to the payer (alice), not to the output recipient.
    const swapData = buildSwapData(ctx, ctx.tokenIn.target, ctx.tokenOut.target, consumed, ctx.zap.target);
    await (
      await ctx.zap
        .connect(ctx.alice)
        .zap(ctx.tokenIn.target, ctx.tokenOut.target, amountIn, consumed, ctx.deployer.address, swapData)
    ).wait();

    expect(await ctx.tokenOut.balanceOf(ctx.deployer.address)).to.equal(consumed); // output → recipient
    expect(await ctx.tokenIn.balanceOf(ctx.alice.address)).to.equal(amountIn - consumed); // refund → caller
    expect(await ctx.tokenIn.balanceOf(ctx.zap.target)).to.equal(0n); // helper stays stateless
    expect(await ctx.tokenOut.balanceOf(ctx.zap.target)).to.equal(0n);
  });

  it("enforces minOut on the Permit2 path", async () => {
    const ctx = await loadFixture(permit2Fixture);
    const amountIn = 1000n * 10n ** 6n;
    await (await ctx.tokenIn.mint(ctx.alice.address, amountIn)).wait();
    await (await ctx.tokenIn.connect(ctx.alice).approve(ctx.zap.target, ethers.MaxUint256)).wait();
    const swapData = buildSwapData(ctx, ctx.tokenIn.target, ctx.tokenOut.target, amountIn, ctx.zap.target);

    await expect(
      ctx.zap
        .connect(ctx.alice)
        .zap(ctx.tokenIn.target, ctx.tokenOut.target, amountIn, amountIn + 1n, ctx.alice.address, swapData)
    ).to.be.revertedWith("zap-slippage");
  });
});
