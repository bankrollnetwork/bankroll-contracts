-- vltUSDC · 04 — share supply, L/share, fee APR
-- Shares ARE the vault's ERC-20 (decimals() == 0: raw integer liquidity units), so supply comes
-- straight from its Transfer events (mint = from 0x0, burn = to 0x0; the 1,000 dead shares at
-- 0xdEaD stay in supply, matching totalSupply()). L/share starts at exactly 1.0 on the first
-- deposit and rises ONLY on compound — so its growth is the price-neutral, IL-free fee return
-- (mirrors the on-chain feeApr()). APRs are simple-annualized in bps, like feeApr():
--   lifetime = (L/share − 1) / years_since_inception × 10000
--   7d / 30d = (L/share ÷ L/share_n_days_ago − 1) × (365/n) × 10000
-- Double-precision display math; exact figures come from vault.feeApr().
-- Tables: erc20_ethereum.evt_Transfer (share token = the vault address — works pre-decoding),
--         uniswap_v4_ethereum.PoolManager_evt_{Initialize,ModifyLiquidity}.
-- Params: {{vault_address}} (text, 0x-prefixed).

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
supply_daily AS (
  SELECT CAST(t.evt_block_time AS DATE) AS day,
         SUM(CASE WHEN t."from" = 0x0000000000000000000000000000000000000000 THEN CAST(t.value AS DOUBLE)
                  WHEN t."to"   = 0x0000000000000000000000000000000000000000 THEN -CAST(t.value AS DOUBLE)
                  ELSE 0 END) AS d_supply
  FROM erc20_ethereum.evt_Transfer t
  CROSS JOIN params
  WHERE t.contract_address = params.vault
  GROUP BY 1
),
liq_daily AS (
  SELECT CAST(ml.evt_block_time AS DATE) AS day,
         SUM(CAST(ml."liquidityDelta" AS DOUBLE)) AS dl
  FROM uniswap_v4_ethereum.PoolManager_evt_ModifyLiquidity ml
  JOIN pool ON ml.id = pool.pool_id
  CROSS JOIN params
  WHERE ml.sender = params.vault
  GROUP BY 1
),
spine AS (
  SELECT t.day
  FROM (SELECT CAST(MIN(day) AS DATE) AS d0 FROM supply_daily) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
),
series AS (
  SELECT s.day,
         SUM(COALESCE(sd.d_supply, 0)) OVER (ORDER BY s.day) AS total_supply,
         SUM(COALESCE(l.dl, 0)) OVER (ORDER BY s.day)        AS position_l,
         MIN(s.day) OVER ()                                  AS inception_day
  FROM spine s
  LEFT JOIN supply_daily sd ON sd.day = s.day
  LEFT JOIN liq_daily l     ON l.day = s.day
),
ratio AS (
  SELECT day, total_supply, position_l, inception_day,
         position_l / NULLIF(total_supply, 0) AS l_per_share
  FROM series
)
SELECT
  day,
  total_supply,
  position_l,
  l_per_share,
  -- lifetime fee APR (bps): L/share == 1.0 at inception by construction
  CASE WHEN day > inception_day
       THEN (l_per_share - 1) / (DATE_DIFF('day', inception_day, day) / 365.0) * 10000
       ELSE 0 END AS lifetime_apr_bps,
  CASE WHEN LAG(l_per_share, 7) OVER (ORDER BY day) IS NOT NULL
       THEN (l_per_share / LAG(l_per_share, 7) OVER (ORDER BY day) - 1) * (365.0 / 7) * 10000
       ELSE 0 END AS d7_apr_bps,
  CASE WHEN LAG(l_per_share, 30) OVER (ORDER BY day) IS NOT NULL
       THEN (l_per_share / LAG(l_per_share, 30) OVER (ORDER BY day) - 1) * (365.0 / 30) * 10000
       ELSE 0 END AS d30_apr_bps
FROM ratio
WHERE total_supply > 0
ORDER BY day
