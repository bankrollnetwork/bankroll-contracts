-- vltUSDC · 08 — pool price & volume
-- Daily VLT price (USDC per VLT, from the pool's own sqrtPriceX96) and swap volume through the
-- vault's V4 pool. The `pool` / `price_filled` CTEs here are the canonical price source the
-- other queries inline (02/03/04/05/06) — keep them identical if edited.
--   price: usdc_per_vlt = (sqrtPriceX96 / 2^96)^2 × 1e12   (VLT=currency0 18d, USDC=currency1 6d)
--   volume: Σ |amount1| / 1e6 — the USDC leg, so each swap is counted once regardless of direction.
-- Tables: uniswap_v4_ethereum.PoolManager_evt_{Initialize,Swap}
-- Params: none.

WITH pool AS (
  SELECT id AS pool_id
  FROM uniswap_v4_ethereum.PoolManager_evt_Initialize
  WHERE currency0 = 0x6b785a0322126826d8226d77e173d75dafb84d11
    AND currency1 = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
    AND fee = 10000 AND "tickSpacing" = 200
    AND hooks = 0x0000000000000000000000000000000000000000
),
swaps AS (
  SELECT s.evt_block_time, s."sqrtPriceX96", s.amount0, s.amount1
  FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
  JOIN pool ON s.id = pool.pool_id
),
spine AS (
  SELECT t.day
  FROM (SELECT CAST(MIN(evt_block_time) AS DATE) AS d0 FROM swaps) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
),
price_daily AS (
  SELECT CAST(evt_block_time AS DATE) AS day,
         MAX_BY(CAST("sqrtPriceX96" AS DOUBLE), evt_block_time) AS sqrt_px96,
         SUM(ABS(CAST(amount1 AS DOUBLE))) / 1e6 AS volume_usdc,
         COUNT(*) AS swap_count
  FROM swaps
  GROUP BY 1
),
price_filled AS (
  SELECT s.day,
         LAST_VALUE(p.sqrt_px96) IGNORE NULLS
           OVER (ORDER BY s.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS sqrt_px96,
         COALESCE(p.volume_usdc, 0) AS volume_usdc,
         COALESCE(p.swap_count, 0) AS swap_count
  FROM spine s
  LEFT JOIN price_daily p ON p.day = s.day
)
SELECT
  day,
  POWER(sqrt_px96 / POWER(2, 96), 2) * 1e12 AS usdc_per_vlt,
  volume_usdc,
  swap_count,
  SUM(volume_usdc) OVER (ORDER BY day) AS cumulative_volume_usdc
FROM price_filled
ORDER BY day
