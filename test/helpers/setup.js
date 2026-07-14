// Shared fixture + action helpers for the vltUSDC vault tests.
//
// Deploys a REAL Uniswap V4 PoolManager (v4-core), two mock tokens standing in for
// VLT (18d) / USDC (6d), the official v4-core test routers, seeds baseline pool
// liquidity (the vault's deposit swap needs a counterparty), and the vault itself.

const { ethers } = require("hardhat");
const {
  encodeSqrtRatioX96,
  fullRangeTicks,
  quoteDepositSwap,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} = require("./math");

const ZERO = ethers.ZeroAddress;

const DEFAULTS = {
  vltDecimals: 18,
  usdcDecimals: 6,
  fee: 10000, // 1% in hundredths-of-a-bip
  tickSpacing: 200,
  usdcPerVlt: 2, // initial pool price: 2 USDC per 1 VLT
  baseLiquidity: 10n ** 16n, // baseline LP depth seeded by an external LP
  reentrantToken: false, // use ReentrantToken in place of VLT (reentrancy test)
  // Force which token sorts as currency0 (mock addresses are nonce-dependent, so ordering is
  // otherwise a coin flip per run context). Set true/false for the token-naming mapping tests;
  // undefined = take whatever ordering the deploy produced.
  forceUsdcIsCurrency0: undefined,
};

function sortTokens(a, b) {
  // currency0 < currency1 by address (the ordering the vault enforces).
  return BigInt(a.target ?? a) < BigInt(b.target ?? b) ? [a, b] : [b, a];
}

async function deployVaultFixture(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  const signers = await ethers.getSigners();
  const [deployer, alice, bob, carol, finder, seeder] = signers;

  // 1. Real PoolManager.
  const PoolManager = await ethers.getContractFactory("PoolManager");
  const poolManager = await PoolManager.deploy(deployer.address);
  await poolManager.waitForDeployment();

  // 2. Tokens. VLT optionally swapped for the reentrancy attacker.
  const Mock = await ethers.getContractFactory("MockERC20");
  let usdc = await Mock.deploy("USD Coin", "USDC", cfg.usdcDecimals);
  await usdc.waitForDeployment();

  let vlt;
  const VltFactory = cfg.reentrantToken
    ? await ethers.getContractFactory("ReentrantToken")
    : Mock;
  vlt = await VltFactory.deploy("Vault", "VLT", cfg.vltDecimals);
  await vlt.waitForDeployment();

  // Deterministic ordering on request: each redeploy takes a fresh (nonce-derived) address,
  // so a few tries land on the requested side of USDC. Bounded to keep failure loud.
  if (cfg.forceUsdcIsCurrency0 !== undefined) {
    let tries = 0;
    while ((BigInt(usdc.target) < BigInt(vlt.target)) !== cfg.forceUsdcIsCurrency0) {
      if (++tries > 80) throw new Error("could not force currency ordering after 80 redeploys");
      // An extreme USDC address can strand the loop (nearly every fresh address sorts on one
      // side of it) — periodically redeploy USDC too, moving the reference point.
      if (tries % 8 === 0) {
        usdc = await Mock.deploy("USD Coin", "USDC", cfg.usdcDecimals);
        await usdc.waitForDeployment();
      }
      vlt = await VltFactory.deploy("Vault", "VLT", cfg.vltDecimals);
      await vlt.waitForDeployment();
    }
  }

  // 3. Order currencies + build the PoolKey.
  const [c0, c1] = sortTokens(vlt, usdc);
  const currency0 = c0.target;
  const currency1 = c1.target;
  const usdcIsCurrency0 = BigInt(usdc.target) === BigInt(currency0);

  const poolKey = {
    currency0,
    currency1,
    fee: cfg.fee,
    tickSpacing: cfg.tickSpacing,
    hooks: ZERO,
  };

  // 4. Initial price encoded for whichever ordering we got. Reference raw amounts at
  //    `usdcPerVlt`: 1 VLT (10^vltDec) is worth `usdcPerVlt` USDC (usdcPerVlt * 10^usdcDec).
  const vltRef = 10n ** BigInt(cfg.vltDecimals);
  const usdcRef = BigInt(cfg.usdcPerVlt) * 10n ** BigInt(cfg.usdcDecimals);
  const amount0Ref = usdcIsCurrency0 ? usdcRef : vltRef;
  const amount1Ref = usdcIsCurrency0 ? vltRef : usdcRef;
  const sqrtPriceX96 = encodeSqrtRatioX96(amount1Ref, amount0Ref);

  await (await poolManager.initialize(poolKey, sqrtPriceX96)).wait();

  // 5. Test routers.
  const ModifyRouter = await ethers.getContractFactory("PoolModifyLiquidityTest");
  const modifyRouter = await ModifyRouter.deploy(poolManager.target);
  await modifyRouter.waitForDeployment();
  const SwapRouter = await ethers.getContractFactory("PoolSwapTest");
  const swapRouter = await SwapRouter.deploy(poolManager.target);
  await swapRouter.waitForDeployment();

  // 6. Seed baseline liquidity from an external LP across the same full range.
  const { tickLower, tickUpper } = fullRangeTicks(cfg.tickSpacing);
  const seedAmount = 10n ** 36n;
  await (await vlt.mint(seeder.address, seedAmount)).wait();
  await (await usdc.mint(seeder.address, seedAmount)).wait();
  await (await vlt.connect(seeder).approve(modifyRouter.target, ethers.MaxUint256)).wait();
  await (await usdc.connect(seeder).approve(modifyRouter.target, ethers.MaxUint256)).wait();
  await (await vlt.connect(seeder).approve(swapRouter.target, ethers.MaxUint256)).wait();
  await (await usdc.connect(seeder).approve(swapRouter.target, ethers.MaxUint256)).wait();

  await (
    await modifyRouter.connect(seeder).modifyLiquidity(
      poolKey,
      { tickLower, tickUpper, liquidityDelta: cfg.baseLiquidity, salt: ethers.ZeroHash },
      "0x"
    )
  ).wait();

  // 7. The vault — takes a balanced VLT + USDC pair, no external dependency.
  const Vault = await ethers.getContractFactory("VltUsdcVault");
  const vault = await Vault.deploy(poolManager.target, poolKey, usdc.target);
  await vault.waitForDeployment();
  // compound()'s min-value gate is a fixed $1 constant (no setter). Fee-generating compound tests
  // accrue well past $1; the below-gate path is covered by the "nothing accrued" no-op test.

  // 8. PERIPHERY: external VLT market (mock) + the ZapHelper that converts a USDC-only deposit
  //    into the balanced pair by buying VLT from that market (the buy-pressure flywheel). The
  //    vault does NOT reference the helper. ZapHelper uses permit2=0 (mock pulls via plain allowance).
  const MockRouter = await ethers.getContractFactory("MockSwapRouter");
  const mockRouter = await MockRouter.deploy(usdc.target, vlt.target);
  await mockRouter.waitForDeployment();
  const vltReserve = 5_000_000n * 10n ** BigInt(cfg.vltDecimals);
  const usdcReserve = BigInt(cfg.usdcPerVlt) * 5_000_000n * 10n ** BigInt(cfg.usdcDecimals);
  await (await vlt.mint(mockRouter.target, vltReserve)).wait();
  await (await usdc.mint(mockRouter.target, usdcReserve)).wait();

  const Zap = await ethers.getContractFactory("ZapHelper");
  const zapHelper = await Zap.deploy(mockRouter.target, ethers.ZeroAddress, vault.target);
  await zapHelper.waitForDeployment();

  return {
    cfg,
    signers,
    deployer,
    alice,
    bob,
    carol,
    finder,
    seeder,
    poolManager,
    vlt,
    usdc,
    currency0,
    currency1,
    usdcIsCurrency0,
    poolKey,
    sqrtPriceX96,
    tickLower,
    tickUpper,
    modifyRouter,
    swapRouter,
    mockRouter,
    zapHelper,
    vault,
  };
}

// Build the off-chain "route" calldata for the zapper's USDC->VLT swap. In production this is the
// Uniswap Routing API result; here it targets the mock router and directs output to the helper
// (the helper measures its own balance delta).
function buildZapData(ctx, swapUsdcToVlt) {
  return ctx.mockRouter.interface.encodeFunctionData("swapUsdcForVlt", [
    BigInt(swapUsdcToVlt),
    ctx.zapHelper.target,
  ]);
}

// VLT (raw 18d) of equal value to `usdcAmount` (raw 6d) at the configured price.
function balancedVlt(ctx, usdcAmount) {
  return (BigInt(usdcAmount) * 10n ** BigInt(ctx.cfg.vltDecimals)) /
    (BigInt(ctx.cfg.usdcPerVlt) * 10n ** BigInt(ctx.cfg.usdcDecimals));
}

// ── action helpers ──────────────────────────────────────────────────────────

// Give `user` USDC and approve the vault to pull it.
async function fundUsdc(ctx, user, amount) {
  await (await ctx.usdc.mint(user.address, amount)).wait();
  await (await ctx.usdc.connect(user).approve(ctx.vault.target, ethers.MaxUint256)).wait();
}

// Direct vault deposit of a balanced pair: `usdcAmount` USDC + an equal-value amount of VLT.
// Self-funds + approves both tokens (override vltAmount via opts). minShares defaults loose.
async function deposit(ctx, user, usdcAmount, opts = {}) {
  const usdcAmt = BigInt(usdcAmount);
  const vltAmt = opts.vltAmount ?? balancedVlt(ctx, usdcAmt);
  await (await ctx.usdc.mint(user.address, usdcAmt)).wait();
  await (await ctx.vlt.mint(user.address, vltAmt)).wait();
  await (await ctx.usdc.connect(user).approve(ctx.vault.target, ethers.MaxUint256)).wait();
  await (await ctx.vlt.connect(user).approve(ctx.vault.target, ethers.MaxUint256)).wait();
  return ctx.vault
    .connect(user)
    .deposit(vltAmt, usdcAmt, opts.minShares ?? 0n, opts.deadline ?? ethers.MaxUint256, opts.recipient ?? user.address);
}

// Periphery path: deposit `usdcAmount` USDC through the ZapHelper (buys VLT externally, then
// deposits the balanced pair into the vault, which mints shares directly to the recipient).
async function zapDeposit(ctx, user, usdcAmount, opts = {}) {
  const usdcAmt = BigInt(usdcAmount);
  const swapUsdcToVlt = opts.swapUsdcToVlt ?? quoteDepositSwap(usdcAmt, ctx.cfg.fee);
  const minVltOut = opts.minVltOut ?? 0n;
  const minShares = opts.minShares ?? 0n;
  const swapData = opts.swapData ?? buildZapData(ctx, swapUsdcToVlt);
  const deadline = opts.deadline ?? ethers.MaxUint256;
  const recipient = opts.recipient ?? user.address;
  await (await ctx.usdc.mint(user.address, usdcAmt)).wait();
  await (await ctx.usdc.connect(user).approve(ctx.zapHelper.target, ethers.MaxUint256)).wait();
  return ctx.zapHelper
    .connect(user)
    .zapDeposit(usdcAmt, swapUsdcToVlt, minVltOut, minShares, deadline, recipient, swapData);
}

// redeem() takes shares + receiver (in-kind, no slippage bounds).
async function redeem(ctx, user, shares, receiver) {
  return ctx.vault.connect(user).redeem(BigInt(shares), receiver ?? user.address);
}

// Once compoundClaimable() reaches AUTO_COMPOUND_MIN_USDC ($100), ANY deposit runs the vault's
// internal _compound() leg before its own liquidity add — the primary compound path. A small
// deposit by `user` is the canonical trigger; 100% of the harvest reinvests (no fee). The
// public compound() wraps the same leg (unincentivized safety valve).
async function triggerCompound(ctx, user, usdcAmount) {
  const amt = usdcAmount ?? 10n * 10n ** BigInt(ctx.cfg.usdcDecimals);
  return deposit(ctx, user, amt);
}

// Push balanced volume until compoundClaimable() reports at least `targetUsdc` (raw 6d) — the
// robust way to arm the auto-compound threshold without hand-tuning swap counts per fixture.
async function accrueFeesTo(ctx, targetUsdc, { rounds = 5, usdcPerSwap } = {}) {
  const per = usdcPerSwap ?? 2000n * 10n ** BigInt(ctx.cfg.usdcDecimals);
  for (let i = 0; i < 10; i++) {
    const [, , valueUsdc] = await ctx.vault.compoundClaimable();
    if (valueUsdc >= targetUsdc) return valueUsdc;
    await generateFees(ctx, { rounds, usdcPerSwap: per });
  }
  const [, , valueUsdc] = await ctx.vault.compoundClaimable();
  if (valueUsdc < targetUsdc) {
    throw new Error(`accrueFeesTo: wanted ${targetUsdc}, got ${valueUsdc}`);
  }
  return valueUsdc;
}

// Push trade volume through the pool so fees accrue to the vault's position.
// Alternates direction; uses the seeder's funds via the swap router.
async function generateFees(ctx, { rounds = 4, usdcPerSwap } = {}) {
  const usdcSwap = usdcPerSwap ?? 1000n * 10n ** BigInt(ctx.cfg.usdcDecimals);
  const vltSwap = 100n * 10n ** BigInt(ctx.cfg.vltDecimals);
  const settings = { takeClaims: false, settleUsingBurn: false };
  for (let i = 0; i < rounds; i++) {
    // sell USDC -> VLT
    const sellUsdcZeroForOne = ctx.usdcIsCurrency0;
    await (
      await ctx.swapRouter.connect(ctx.seeder).swap(
        ctx.poolKey,
        {
          zeroForOne: sellUsdcZeroForOne,
          amountSpecified: -usdcSwap,
          sqrtPriceLimitX96: sellUsdcZeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
        },
        settings,
        "0x"
      )
    ).wait();
    // sell VLT -> USDC
    const sellVltZeroForOne = !ctx.usdcIsCurrency0;
    await (
      await ctx.swapRouter.connect(ctx.seeder).swap(
        ctx.poolKey,
        {
          zeroForOne: sellVltZeroForOne,
          amountSpecified: -vltSwap,
          sqrtPriceLimitX96: sellVltZeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
        },
        settings,
        "0x"
      )
    ).wait();
  }
}

// Exact-input swap of `amountIn` (raw units of the INPUT currency) by `signer`.
// zeroForOne === true spends currency0, false spends currency1.
async function swapExact(ctx, signer, zeroForOne, amountIn) {
  await (await ctx.vlt.connect(signer).approve(ctx.swapRouter.target, ethers.MaxUint256)).wait();
  await (await ctx.usdc.connect(signer).approve(ctx.swapRouter.target, ethers.MaxUint256)).wait();
  return ctx.swapRouter.connect(signer).swap(
    ctx.poolKey,
    {
      zeroForOne,
      amountSpecified: -BigInt(amountIn),
      sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
    },
    { takeClaims: false, settleUsingBurn: false },
    "0x"
  );
}

// Remove the externally-seeded baseline liquidity so the vault becomes the sole LP
// (lets a test attribute 100% of swap fees to the vault's position).
async function removeBaseLiquidity(ctx) {
  await (
    await ctx.modifyRouter.connect(ctx.seeder).modifyLiquidity(
      ctx.poolKey,
      {
        tickLower: ctx.tickLower,
        tickUpper: ctx.tickUpper,
        liquidityDelta: -ctx.cfg.baseLiquidity,
        salt: ethers.ZeroHash,
      },
      "0x"
    )
  ).wait();
}

module.exports = {
  deployVaultFixture,
  buildZapData,
  balancedVlt,
  fundUsdc,
  deposit,
  zapDeposit,
  redeem,
  triggerCompound,
  accrueFeesTo,
  generateFees,
  swapExact,
  removeBaseLiquidity,
  DEFAULTS,
};
