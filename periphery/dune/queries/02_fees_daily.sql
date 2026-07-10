-- vltUSDC · 02 — realized fees, daily + cumulative
-- The complete realized-fee picture from the vault's own events (AUDIT.MD §7a identity):
--   realized fees = Σ Compound.vltFees/usdcFees  +  Σ FeesRetained.vltFees/usdcFees
--   keeper cut    = Σ Compound.vltFinder/usdcFinder (1% of each fresh harvest)
--   supply-side   = fees − keeper cut (auto-compounded to shareholders); protocol take = 0.
-- Event amounts are token-named (vlt* 18d / usdc* 6d) — no currency0/1 mapping needed.
-- USD: VLT leg valued at the pool's own daily price; USDC leg at $1.00 (swap in prices.usd
-- if exactness beyond the peg is wanted).
-- Tables: vltusdc_ethereum.VltUsdcVault_evt_{Compound,FeesRetained}   ← namespace chosen at
--   decode-submission time; find-replace `vltusdc_ethereum` if it differs.
--   uniswap_v4_ethereum.PoolManager_evt_{Initialize,Swap} (price).
-- Params: {{vault_address}} (text, 0x-prefixed).
-- Pre-decoding fallback: the same events can be read from ethereum.logs via topic0 — see the
--   topic table in ../README.md (Compound 0xb824c165…, FeesRetained 0xbc53b087…).

WITH params AS (
  SELECT FROM_HEX(SUBSTR(LOWER('{{vault_address}}'), 3)) AS vault
),
pool AS (
  SELECT id AS pool_id
  FROM uniswap_v4_ethereum.PoolManager_evt_Initialize
  WHERE currency0 = 0x6b785a0322126826d8226d77e173d75dafb84d11
    AND currency1 = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
    AND fee = 10000 AND "tickSpacing" = 200
    AND hooks = 0x0000000000000000000000000000000000000000
),
all_fees AS (
  SELECT evt_block_time,
         CAST("vltFees" AS DOUBLE) AS fee_vlt_raw, CAST("usdcFees" AS DOUBLE) AS fee_usdc_raw,
         CAST("vltFinder" AS DOUBLE) AS finder_vlt_raw, CAST("usdcFinder" AS DOUBLE) AS finder_usdc_raw,
         'compound' AS source
  FROM vltusdc_ethereum.VltUsdcVault_evt_Compound, params
  WHERE contract_address = params.vault
  UNION ALL
  SELECT evt_block_time,
         CAST("vltFees" AS DOUBLE), CAST("usdcFees" AS DOUBLE),
         0e0, 0e0,
         'retained'                    -- harvested by deposit/redeem: reinvests 100%, no finder cut
  FROM vltusdc_ethereum.VltUsdcVault_evt_FeesRetained, params
  WHERE contract_address = params.vault
),
spine AS (
  SELECT t.day
  FROM (SELECT CAST(MIN(evt_block_time) AS DATE) AS d0 FROM all_fees) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
),
price_daily AS (
  SELECT CAST(s.evt_block_time AS DATE) AS day,
         MAX_BY(CAST(s."sqrtPriceX96" AS DOUBLE), s.evt_block_time) AS sqrt_px96
  FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
  JOIN pool ON s.id = pool.pool_id
  GROUP BY 1
),
price_filled AS (
  SELECT s.day,
         POWER(LAST_VALUE(p.sqrt_px96) IGNORE NULLS
                 OVER (ORDER BY s.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
               / POWER(2, 96), 2) * 1e12 AS usdc_per_vlt
  FROM spine s
  LEFT JOIN price_daily p ON p.day = s.day
),
daily AS (
  SELECT CAST(evt_block_time AS DATE) AS day,
         SUM(fee_vlt_raw) / 1e18                                        AS fee_vlt,
         SUM(fee_usdc_raw) / 1e6                                        AS fee_usdc,
         SUM(CASE WHEN source = 'compound' THEN fee_vlt_raw ELSE 0 END) / 1e18 AS fee_vlt_compound,
         SUM(CASE WHEN source = 'retained' THEN fee_vlt_raw ELSE 0 END) / 1e18 AS fee_vlt_retained,
         SUM(CASE WHEN source = 'compound' THEN fee_usdc_raw ELSE 0 END) / 1e6  AS fee_usdc_compound,
         SUM(CASE WHEN source = 'retained' THEN fee_usdc_raw ELSE 0 END) / 1e6  AS fee_usdc_retained,
         SUM(finder_vlt_raw) / 1e18                                     AS finder_vlt,
         SUM(finder_usdc_raw) / 1e6                                     AS finder_usdc
  FROM all_fees
  GROUP BY 1
)
SELECT
  p.day,
  COALESCE(d.fee_vlt, 0)  AS fee_vlt,
  COALESCE(d.fee_usdc, 0) AS fee_usdc,
  COALESCE(d.fee_vlt, 0) * p.usdc_per_vlt + COALESCE(d.fee_usdc, 0)                    AS fees_usd,
  COALESCE(d.fee_vlt_compound, 0) * p.usdc_per_vlt + COALESCE(d.fee_usdc_compound, 0)  AS fees_usd_via_compound,
  COALESCE(d.fee_vlt_retained, 0) * p.usdc_per_vlt + COALESCE(d.fee_usdc_retained, 0)  AS fees_usd_via_retained,
  COALESCE(d.finder_vlt, 0) * p.usdc_per_vlt + COALESCE(d.finder_usdc, 0)              AS keeper_usd,
  (COALESCE(d.fee_vlt, 0) - COALESCE(d.finder_vlt, 0)) * p.usdc_per_vlt
    + (COALESCE(d.fee_usdc, 0) - COALESCE(d.finder_usdc, 0))                           AS supply_side_usd,
  SUM(COALESCE(d.fee_vlt, 0) * p.usdc_per_vlt + COALESCE(d.fee_usdc, 0))
    OVER (ORDER BY p.day)                                                              AS cumulative_fees_usd
FROM price_filled p
LEFT JOIN daily d ON d.day = p.day
ORDER BY p.day
