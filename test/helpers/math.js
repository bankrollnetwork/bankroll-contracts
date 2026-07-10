// Shared V4 price/tick math used by both tests and deploy scripts.
// Everything is BigInt; convert at the numeral boundary only.

const Q96 = 1n << 96n;
const Q192 = 1n << 192n;

const MIN_TICK = -887272n;
const MAX_TICK = 887272n;
// MIN/MAX sqrt prices from v4-core TickMath.
const MIN_SQRT_PRICE = 4295128739n;
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;

// Integer square root (floor) for BigInt.
function isqrt(value) {
  if (value < 0n) throw new Error("isqrt of negative");
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }
  return x0;
}

// sqrtPriceX96 = floor(sqrt(amount1/amount0) * 2^96), the V4 price encoding.
// amount1/amount0 are RAW token amounts (currency1 per currency0) at the target price.
function encodeSqrtRatioX96(amount1, amount0) {
  amount1 = BigInt(amount1);
  amount0 = BigInt(amount0);
  if (amount0 <= 0n) throw new Error("amount0 must be > 0");
  return isqrt((amount1 * Q192) / amount0);
}

// Full-range ticks snapped to spacing, matching the contract's constructor exactly:
//   (MIN_TICK / spacing) * spacing  with truncation toward zero.
function fullRangeTicks(tickSpacing) {
  const s = BigInt(tickSpacing);
  const lower = (MIN_TICK / s) * s; // BigInt division truncates toward zero
  const upper = (MAX_TICK / s) * s;
  return { tickLower: Number(lower), tickUpper: Number(upper) };
}

// price = (sqrtPriceX96 / 2^96)^2, returned as a float for logging/quotes only.
function sqrtX96ToPrice(sqrtPriceX96) {
  const sp = Number(sqrtPriceX96) / Number(Q96);
  return sp * sp;
}

// Split a USDC deposit for a balanced full-range zap: swap x = D / (2 - fee) so the
// post-swap USDC remainder and the swapped-out value are ~equal. feeBps is the pool
// fee in hundredths of a bip (10000 = 1%).
function quoteDepositSwap(usdcAmount, feeBps) {
  const D = BigInt(usdcAmount);
  const fee = BigInt(feeBps); // out of 1_000_000
  // x = D * 1e6 / (2e6 - fee)
  const num = D * 1_000_000n;
  const den = 2_000_000n - fee;
  return num / den;
}

module.exports = {
  Q96,
  Q192,
  MIN_TICK,
  MAX_TICK,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
  isqrt,
  encodeSqrtRatioX96,
  fullRangeTicks,
  sqrtX96ToPrice,
  quoteDepositSwap,
};
