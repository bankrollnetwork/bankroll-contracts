// DEV ONLY. Simulate N days of fee accrual + daily compounding against the running fork, so the
// vault's L/share ring buffer fills and feeApr() reports real 7d / 30d numbers. A deposit
// whose claimable value is ≥ AUTO_COMPOUND_MIN_USDC ($100) runs the compound leg itself —
// the ONLY compound path (no compound entrypoint exists). Each "day" the script:
//   1. round-trips USDC↔VLT through the pool until ≥ $110 is claimable (balanced — no drift),
//   2. makes a small zapDeposit — the trigger deposit compounds + writes one daily snapshot,
//   3. advances the EVM clock by 1 day.
//
// If the vault hasn't been funded yet (totalSupply == 0) it FIRST seeds a deposit through the
// ZapHelper from cheat-minted USDC (VLT has no storage cheat, and the V4 pool is empty until the
// vault is its LP — so the zap, which buys VLT from its external market, is the only bootstrap).
//
//   npm run fork:node        # terminal 1
//   npm run fork:setup       # terminal 2  (deploys + writes scripts/dev/.deployed.json)
//   npm run fork:simulate    # terminal 2  (default 60 days; auto-seeds if needed)
//
// Env: SIM_DAYS (60), SIM_USDC_PER_SWAP (2000), SIM_TARGET_USD (110 — claimable to hit before
//      the trigger deposit; must clear the $100 auto-compound constant), SIM_SEED_USDC (20000 —
//      first-deposit size if the vault is empty), VAULT / ZAP (addresses from .deployed.json).
const fs = require("fs");
const path = require("path");
const { AbiCoder, Interface, solidityPacked } = require("ethers");
const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("../config");
const { readSqrtPriceX96 } = require("../lib/pool");
const { MIN_SQRT_PRICE, MAX_SQRT_PRICE } = require("../../test/helpers/math");

const SETTINGS = { takeClaims: false, settleUsingBurn: false };
const DAY = 24 * 60 * 60;

// Universal Router constants for the USDC →(V3 0.05%)→ WETH →(V2)→ VLT zap route (mirrors
// scripts/dev/build_vlt_route.js — the byte-for-byte route the test client uses).
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n;
const ROUTE_DEADLINE = 4102444800n; // year 2100
const CODER = AbiCoder.defaultAbiCoder();

// Build Universal Router `execute` calldata that swaps `amountIn` USDC → VLT, output to the caller
// (the ZapHelper). Pure encoding, no network.
function buildSwapData(usdcAddr, vltAddr, amountIn) {
  const v3Path = solidityPacked(["address", "uint24", "address"], [usdcAddr, 500, WETH]);
  const v3Input = CODER.encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [ADDRESS_THIS, amountIn, 0n, v3Path, true]
  );
  const v2Input = CODER.encode(
    ["address", "uint256", "uint256", "address[]", "bool"],
    [MSG_SENDER, CONTRACT_BALANCE, 0n, [WETH, vltAddr], false]
  );
  const ur = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
  return ur.encodeFunctionData("execute", ["0x0008", [v3Input, v2Input], ROUTE_DEADLINE]);
}

// Fund `account` with `human` USDC via the FiatTokenV2_2 balanceOf slot (9) — same cheat as fork_all.
async function fundUsdc(account, usdcAddr, human) {
  const raw = ethers.parseUnits(human, 6);
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, 9])
  );
  await ethers.provider.send("hardhat_setStorageAt", [usdcAddr, slot, ethers.toBeHex(raw, 32)]);
}

// {vault, zapHelper} from .deployed.json (written by fork:setup), with env overrides.
function readDeployed() {
  const out = {};
  try {
    Object.assign(out, JSON.parse(fs.readFileSync(path.join(__dirname, ".deployed.json"), "utf8")));
  } catch (e) {}
  if (process.env.VAULT) out.vault = process.env.VAULT;
  if (process.env.ZAP) out.zapHelper = process.env.ZAP;
  if (!out.vault) {
    throw new Error(
      "vault address unknown — run `npm run fork:setup` first (writes scripts/dev/.deployed.json) or pass VAULT=0x…"
    );
  }
  return out;
}

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey, usdcIsCurrency0 } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [keeper] = await ethers.getSigners(); // account #0 drives volume + the daily trigger deposit
  const days = Number(process.env.SIM_DAYS || 60);
  const usdcPerSwap = ethers.parseUnits(process.env.SIM_USDC_PER_SWAP || "2000", 6);
  const targetRaw = ethers.parseUnits(process.env.SIM_TARGET_USD || "110", 6);
  const seedUsdc = ethers.parseUnits(process.env.SIM_SEED_USDC || "20000", 6);

  const dep = readDeployed();
  const vault = await ethers.getContractAt("VltUsdcVault", dep.vault);
  if ((await readSqrtPriceX96(cfg.poolManager, poolKey)) === 0n) {
    throw new Error("pool not initialized — run `npm run fork:setup` first.");
  }

  // Cheat-mint USDC to the keeper (covers both the seed and the round-trips) + token handles.
  await fundUsdc(keeper.address, cfg.usdc, "20000000");
  const usdc = await ethers.getContractAt("IERC20", cfg.usdc);
  const vlt = await ethers.getContractAt("IERC20", cfg.vlt);

  // The ZapHelper is required throughout: it seeds an empty vault AND makes the daily
  // trigger deposits (the only way to fire the vault's auto-compound with USDC only).
  if (!dep.zapHelper) {
    throw new Error("no ZapHelper address — run `npm run fork:setup` or pass ZAP=0x…");
  }
  const zap = await ethers.getContractAt("ZapHelper", dep.zapHelper);

  // Seed the first deposit if the vault is empty — via the ZapHelper (USDC-only; buys VLT externally).
  if ((await vault.totalSupply()) === 0n) {
    const swapAmt = seedUsdc / 2n; // ~half the value swapped to VLT; the vault refunds any dust
    console.log(
      `Vault empty — seeding first deposit via ZapHelper: ${ethers.formatUnits(seedUsdc, 6)} USDC ` +
        `(swap ${ethers.formatUnits(swapAmt, 6)} → VLT)…`
    );
    await (await usdc.approve(dep.zapHelper, seedUsdc)).wait();
    // MaxUint256 deadline: the fork's evm_increaseTime jumps make any wall-clock deadline stale.
    await (
      await zap.zapDeposit(seedUsdc, swapAmt, 0n, 0n, ethers.MaxUint256, keeper.address, buildSwapData(cfg.usdc, cfg.vlt, swapAmt))
    ).wait();
    console.log(`✓ Seeded — totalSupply now ${await vault.totalSupply()}.`);
  }

  // v4-core test router pointed at the (forked) PoolManager — for the daily fee round-trips. Deployed
  // AFTER the seed so the pool actually has the vault's liquidity to swap against.
  const router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(cfg.poolManager);
  await router.waitForDeployment();
  await (await usdc.approve(router.target, ethers.MaxUint256)).wait();
  await (await vlt.approve(router.target, ethers.MaxUint256)).wait();

  const usdcToVlt = usdcIsCurrency0; // USDC == currency0 → zeroForOne sells USDC
  const swap = (zeroForOne, amountIn) =>
    router.swap(
      poolKey,
      {
        zeroForOne,
        amountSpecified: -BigInt(amountIn),
        sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n,
      },
      SETTINGS,
      "0x"
    );
  // One balanced round-trip: USDC→VLT then sell the VLT back → price returns to ~start, fees leak.
  const roundTrip = async () => {
    const vltBefore = await vlt.balanceOf(keeper.address);
    await (await swap(usdcToVlt, usdcPerSwap)).wait();
    const gained = (await vlt.balanceOf(keeper.address)) - vltBefore;
    if (gained > 0n) await (await swap(!usdcToVlt, gained)).wait();
  };

  console.log(
    `Simulating ${days} days on ${cfg.networkName} (round-trip ${ethers.formatUnits(usdcPerSwap, 6)} USDC until ≥ $${ethers.formatUnits(targetRaw, 6)} claimable, then a trigger deposit)…`
  );
  // Daily trigger deposit: a small USDC-only zapDeposit whose vault.deposit() leg auto-compounds.
  const triggerUsdc = ethers.parseUnits("20", 6);
  await (await usdc.approve(dep.zapHelper, ethers.MaxUint256)).wait();
  const compoundTopic = vault.interface.getEvent("Compound").topicHash;
  let compounded = 0;
  for (let d = 0; d < days; d++) {
    let guard = 0;
    // accrue fees until the day clears the auto-compound trigger (cap to avoid a runaway)
    while (guard++ < 25 && (await vault.compoundClaimable()).valueUsdc < targetRaw) {
      await roundTrip();
    }
    const rcTrig = await (
      await zap.zapDeposit(
        triggerUsdc,
        triggerUsdc / 2n,
        0n,
        0n,
        ethers.MaxUint256,
        keeper.address,
        buildSwapData(cfg.usdc, cfg.vlt, triggerUsdc / 2n)
      )
    ).wait();
    const fired = rcTrig.logs.some(
      (l) => l.address.toLowerCase() === dep.vault.toLowerCase() && l.topics[0] === compoundTopic
    );
    if (fired) compounded++;
    await ethers.provider.send("evm_increaseTime", [DAY]);
    await ethers.provider.send("evm_mine", []);
    process.stdout.write(`  day ${d + 1}/${days}  (compounds: ${compounded})   \r`);
  }

  const apr = await vault.feeApr();
  const perShare = ((await vault.positionLiquidity()) * 10n ** 18n) / (await vault.totalSupply());
  const pct = (bps) => (Number(bps) / 100).toFixed(2) + "%";
  console.log(
    `\n✓ ${compounded}/${days} days compounded.  L/share=${ethers.formatUnits(perShare, 18)}` +
      `  ·  lifetime ${pct(apr.lifetimeBps)}  ·  7d ${pct(apr.d7Bps)}  ·  30d ${pct(apr.d30Bps)}`
  );
  if (compounded === 0) {
    console.log("(note) nothing compounded — raise SIM_USDC_PER_SWAP, or confirm the seed succeeded.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
