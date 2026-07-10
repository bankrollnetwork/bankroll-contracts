// On-chain pool reads + the off-chain zap quoter (TODO step 3).
//
// Reads the live pool price straight from PoolManager storage via `extsload` (no lens
// contract to deploy), mirroring StateLibrary.getSlot0:
//   POOLS_SLOT = 6 ; stateSlot = keccak256(abi.encodePacked(poolId, POOLS_SLOT))
//   slot0 (lowest 160 bits of stateSlot) = sqrtPriceX96.

const { ethers } = require("hardhat");
const { quoteDepositSwap } = require("../../test/helpers/math");

const POOLS_SLOT = 6n;
const EXTSLOAD_ABI = ["function extsload(bytes32 slot) view returns (bytes32)"];

// poolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
function poolId(poolKey) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = coder.encode(
    ["address", "address", "uint24", "int24", "address"],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
  );
  return ethers.keccak256(encoded);
}

async function readSqrtPriceX96(poolManagerAddress, poolKey, runner) {
  const pm = new ethers.Contract(poolManagerAddress, EXTSLOAD_ABI, runner ?? ethers.provider);
  const id = poolId(poolKey);
  const stateSlot = ethers.keccak256(
    ethers.solidityPacked(["bytes32", "uint256"], [id, POOLS_SLOT])
  );
  // Explicit gasLimit: against a standalone forked node, EDR otherwise applies the forked
  // block's gas limit (~60M) to eth_call, which exceeds its 16.7M call cap. Harmless elsewhere.
  const word = await pm.extsload(stateSlot, { gasLimit: 5_000_000 });
  // sqrtPriceX96 is the lowest 160 bits.
  const mask = (1n << 160n) - 1n;
  return BigInt(word) & mask;
}

// Human price as USDC per 1 VLT, derived from sqrtPriceX96 + decimals + ordering.
function priceUsdcPerVlt(sqrtPriceX96, { usdcIsCurrency0, vltDecimals, usdcDecimals }) {
  const Q96 = 2 ** 96;
  const sp = Number(sqrtPriceX96) / Q96;
  const rawPrice = sp * sp; // currency1 per currency0, in raw units
  // raw = (amount1 / amount0). Convert to human USDC-per-VLT depending on ordering.
  if (usdcIsCurrency0) {
    // currency0 = USDC, currency1 = VLT. rawPrice = VLT_raw / USDC_raw.
    // USDC per VLT = 1 / (rawPrice * 10^(usdcDec - vltDec))
    return 1 / (rawPrice * 10 ** (usdcDecimals - vltDecimals));
  } else {
    // currency0 = VLT, currency1 = USDC. rawPrice = USDC_raw / VLT_raw.
    // USDC per VLT = rawPrice * 10^(vltDec - usdcDec)
    return rawPrice * 10 ** (vltDecimals - usdcDecimals);
  }
}

function withSlippageDown(amount, slippageBps) {
  return (BigInt(amount) * (10000n - BigInt(slippageBps))) / 10000n;
}

// Quote a USDC deposit: how much USDC to swap into VLT, and a slippage-bounded minVltOut.
// `minShares` is left to the caller — a frontend should `callStatic` deposit() to set it;
// scripts default it to 0 (the entry swap is already bounded by minVltOut).
function quoteDeposit({
  usdcAmount,
  sqrtPriceX96,
  usdcIsCurrency0,
  vltDecimals = 18,
  usdcDecimals = 6,
  feeBps,
  slippageBps = 100,
}) {
  const swapUsdcToVlt = quoteDepositSwap(usdcAmount, feeBps);
  const price = priceUsdcPerVlt(sqrtPriceX96, { usdcIsCurrency0, vltDecimals, usdcDecimals });
  // VLT out (raw) ≈ (USDC_in_human / price) * (1 - fee), then scaled to VLT decimals.
  const usdcInHuman = Number(swapUsdcToVlt) / 10 ** usdcDecimals;
  const feeFrac = Number(feeBps) / 1_000_000;
  const vltOutHuman = (usdcInHuman / price) * (1 - feeFrac);
  const vltOutRaw = BigInt(Math.floor(vltOutHuman * 10 ** vltDecimals));
  return {
    swapUsdcToVlt,
    minVltOut: withSlippageDown(vltOutRaw, slippageBps),
    minShares: 0n,
    priceUsdcPerVlt: price,
  };
}

module.exports = {
  poolId,
  readSqrtPriceX96,
  priceUsdcPerVlt,
  withSlippageDown,
  quoteDeposit,
};
