// Step 0 (testnet / first-time): create + initialize the VLT/USDC 1% pool.
// On mainnet the canonical pool likely already exists — this script is idempotent and
// will skip initialization if the pool already has a price.
//
//   INIT_SQRT_PRICE_X96   raw sqrtPriceX96 (takes precedence), OR
//   INIT_USDC_PER_VLT     human price (USDC per 1 VLT), encoded using token decimals.

const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("./config");
const { readSqrtPriceX96 } = require("./lib/pool");
const { encodeSqrtRatioX96 } = require("../test/helpers/math");

async function erc20Decimals(addr) {
  const t = new ethers.Contract(addr, ["function decimals() view returns (uint8)"], ethers.provider);
  return Number(await t.decimals());
}

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey, usdcIsCurrency0 } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);

  console.log(`Network: ${cfg.networkName}`);
  console.log(`PoolManager: ${cfg.poolManager}`);
  console.log(`PoolKey: c0=${poolKey.currency0} c1=${poolKey.currency1} fee=${cfg.fee} spacing=${cfg.tickSpacing}`);

  const existing = await readSqrtPriceX96(cfg.poolManager, poolKey);
  if (existing > 0n) {
    console.log(`✓ Pool already initialized (sqrtPriceX96=${existing}). Nothing to do.`);
    return;
  }

  // Resolve the initial price.
  let sqrtPriceX96;
  if (process.env.INIT_SQRT_PRICE_X96 && process.env.INIT_SQRT_PRICE_X96.trim() !== "") {
    sqrtPriceX96 = BigInt(process.env.INIT_SQRT_PRICE_X96.trim());
  } else if (process.env.INIT_USDC_PER_VLT && process.env.INIT_USDC_PER_VLT.trim() !== "") {
    const usdcPerVlt = Number(process.env.INIT_USDC_PER_VLT.trim());
    const vltDec = await erc20Decimals(cfg.vlt);
    const usdcDec = await erc20Decimals(cfg.usdc);
    // Reference raw amounts at the target price: 1 VLT == usdcPerVlt USDC.
    const vltRef = 10n ** BigInt(vltDec);
    // scale usdcPerVlt to integer raw USDC (handle fractional prices via 1e9 micro-scaling).
    const SCALE = 1_000_000_000n;
    const usdcRef = (BigInt(Math.round(usdcPerVlt * 1e9)) * 10n ** BigInt(usdcDec)) / SCALE;
    const amount0 = usdcIsCurrency0 ? usdcRef : vltRef;
    const amount1 = usdcIsCurrency0 ? vltRef : usdcRef;
    sqrtPriceX96 = encodeSqrtRatioX96(amount1, amount0);
  } else {
    throw new Error("Set INIT_SQRT_PRICE_X96 or INIT_USDC_PER_VLT to initialize the pool.");
  }

  console.log(`Initializing pool at sqrtPriceX96=${sqrtPriceX96} ...`);
  const pm = await ethers.getContractAt("IPoolManager", cfg.poolManager);
  const tx = await pm.initialize(poolKey, sqrtPriceX96);
  const rc = await tx.wait();
  console.log(`✓ Pool initialized in tx ${rc.hash}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
