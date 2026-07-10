-- vltUSDC · 01 — pool metadata
-- Derives the VLT/USDC 1% V4 pool id from PoolManager Initialize (no pool-id parameter needed
-- anywhere in the dashboard: every query re-derives it with this exact CTE).
-- Expected pool_id for the canonical mainnet key
--   (VLT 0x6b78…, USDC 0xa0b8…, fee 10000, tickSpacing 200, hooks 0x0):
--   0x6d8b638359c82df5d455985885175dee28c05c646f46facb800a1e3ffe0c1534
-- Tables: uniswap_v4_ethereum.PoolManager_evt_Initialize
--   (confirm the mainnet schema name in Dune's data explorer — naming verified on sepolia).
-- Params: none.

SELECT
  evt_block_time          AS initialized_at,
  id                      AS pool_id,
  "sqrtPriceX96"          AS init_sqrt_price_x96,
  tick                    AS init_tick,
  POWER(CAST("sqrtPriceX96" AS DOUBLE) / POWER(2, 96), 2) * 1e12 AS init_usdc_per_vlt
FROM uniswap_v4_ethereum.PoolManager_evt_Initialize
WHERE currency0 = 0x6b785a0322126826d8226d77e173d75dafb84d11  -- VLT  (18d)
  AND currency1 = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48  -- USDC (6d)
  AND fee = 10000
  AND "tickSpacing" = 200
  AND hooks = 0x0000000000000000000000000000000000000000
