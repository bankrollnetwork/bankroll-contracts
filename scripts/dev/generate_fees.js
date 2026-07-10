// DEV ONLY. Generate Uniswap V4 swap fees in the VLT/USDC pool so compound() has something to
// harvest. V4 charges the pool fee on each swap's INPUT; that accrues to the vault's full-range
// position. The vault must already hold liquidity (i.e. you've deposited via the test client).
//
//   npm run fork:node       # terminal 1  (FORK=1 hardhat node)
//   npm run fork:setup      # terminal 2  (deploy pool + vault + zaphelper)
//   ... deposit/zapDeposit from the browser so the vault has liquidity ...
//   npm run fork:fees       # terminal 2  (this script — swaps to accrue fees)
//   ... then hit Compound in the browser ...
//
// Knobs: GEN_ROUNDS (round-trips, default 10), GEN_USDC_PER_SWAP (default 100),
//        GEN_FUND_USDC (USDC minted to the swapper via the slot-9 cheat, default 2000000).
const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("../config");
const { readSqrtPriceX96 } = require("../lib/pool");
const { MIN_SQRT_PRICE, MAX_SQRT_PRICE } = require("../../test/helpers/math");

const SETTINGS = { takeClaims: false, settleUsingBurn: false };

// Fund `account` with `human` USDC via the FiatTokenV2_2 balanceOf slot (9) — same cheat as fork_all.
async function fundUsdc(account, usdcAddr, human) {
  const raw = ethers.parseUnits(human, 6);
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, 9])
  );
  await ethers.provider.send("hardhat_setStorageAt", [usdcAddr, slot, ethers.toBeHex(raw, 32)]);
}

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey, usdcIsCurrency0 } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [swapper] = await ethers.getSigners(); // hardhat account #0 — a signer, no key import
  const rounds = Number(process.env.GEN_ROUNDS || 10);
  const usdcPerSwap = ethers.parseUnits(process.env.GEN_USDC_PER_SWAP || "100", 6);

  const price = await readSqrtPriceX96(cfg.poolManager, poolKey);
  if (price === 0n) throw new Error("Pool not initialized — run `npm run fork:setup` first.");

  // Swapper funding: it already has ETH on the fork; give it USDC to push through the pool.
  await fundUsdc(swapper.address, cfg.usdc, process.env.GEN_FUND_USDC || "2000000");

  // v4-core's test swap router, pointed at the (real, forked) PoolManager — does the unlock/settle.
  const router = await (await ethers.getContractFactory("PoolSwapTest")).deploy(cfg.poolManager);
  await router.waitForDeployment();

  const usdc = await ethers.getContractAt("IERC20", cfg.usdc);
  const vlt = await ethers.getContractAt("IERC20", cfg.vlt);
  await (await usdc.approve(router.target, ethers.MaxUint256)).wait();
  await (await vlt.approve(router.target, ethers.MaxUint256)).wait();

  const usdcToVlt = usdcIsCurrency0; // USDC == currency0 → zeroForOne; else oneForZero
  const swap = (zeroForOne, amountIn) =>
    router.swap(
      poolKey,
      { zeroForOne, amountSpecified: -BigInt(amountIn), sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE + 1n : MAX_SQRT_PRICE - 1n },
      SETTINGS,
      "0x"
    );

  console.log(`Network: ${cfg.networkName}  swapper: ${swapper.address}`);
  console.log(`Round-tripping ${ethers.formatUnits(usdcPerSwap, 6)} USDC ×${rounds} through the VLT/USDC pool…`);
  for (let i = 0; i < rounds; i++) {
    const vltBefore = await vlt.balanceOf(swapper.address);
    try {
      await (await swap(usdcToVlt, usdcPerSwap)).wait(); // USDC → VLT (fee on USDC)
    } catch (e) {
      throw new Error(
        "swap reverted at round " + i + ". The pool likely has no liquidity yet — deposit/zapDeposit " +
        "from the test client first (the vault is the pool's LP). Root cause: " + (e.shortMessage || e.message)
      );
    }
    const vltGained = (await vlt.balanceOf(swapper.address)) - vltBefore;
    if (vltGained > 0n) await (await swap(!usdcToVlt, vltGained)).wait(); // VLT → USDC, back ~to start (fee on VLT)
    process.stdout.write(`  round ${i + 1}/${rounds} ✓   \r`);
  }
  console.log(`\n✓ Fees accrued to the vault's position (both currencies). Hit Compound in the test client`);
  console.log(`  (or read compoundClaimable()) — they should now exceed the $1 gate.`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
