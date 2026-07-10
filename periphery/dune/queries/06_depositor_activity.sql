-- vltUSDC · 06 — depositor activity & flows
-- Daily deposit/redeem counts, USD volumes, unique + cumulative-new users, and net flow.
-- CAVEAT (event semantics): Deposit.vltIn/usdcIn are the GROSS amounts pulled BEFORE the
-- vault refunds unused dust, so deposit volume is slightly overstated (typically <2% zap
-- dust); Redeem.amount0Out/amount1Out are exact. Net flow is therefore an upper bound.
-- NOTE on `user`: for zap deposits the vault's msg.sender is the ZapHelper contract, so
-- Deposit.user = the helper, not the end wallet. Split direct-vs-zap flow by comparing user
-- to the ZapHelper address; attribute zapped end-wallets via the tx sender if needed.
-- Tables: vltusdc_ethereum.VltUsdcVault_evt_{Deposit,Redeem} (namespace: find-replace if
--   different), uniswap_v4_ethereum.PoolManager_evt_{Initialize,Swap} (price).
-- Params: {{vault_address}} (text, 0x-prefixed).
-- Pre-decoding fallback: ethereum.logs with topic0 Deposit 0x9cd8ced6…, Redeem 0xbd5034ff…
--   (full table in ../README.md).

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
price_daily AS (
  SELECT CAST(s.evt_block_time AS DATE) AS day,
         POWER(MAX_BY(CAST(s."sqrtPriceX96" AS DOUBLE), s.evt_block_time) / POWER(2, 96), 2) * 1e12
           AS usdc_per_vlt
  FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
  JOIN pool ON s.id = pool.pool_id
  GROUP BY 1
),
deposits AS (
  SELECT CAST(evt_block_time AS DATE) AS day, "user",
         CAST("vltIn" AS DOUBLE) / 1e18 AS vlt_in,
         CAST("usdcIn" AS DOUBLE) / 1e6 AS usdc_in
  FROM vltusdc_ethereum.VltUsdcVault_evt_Deposit, params
  WHERE contract_address = params.vault
),
redeems AS (
  SELECT CAST(evt_block_time AS DATE) AS day, "user",
         CAST("amount0Out" AS DOUBLE) / 1e18 AS vlt_out,   -- amount0 = VLT (currency0)
         CAST("amount1Out" AS DOUBLE) / 1e6  AS usdc_out   -- amount1 = USDC (currency1)
  FROM vltusdc_ethereum.VltUsdcVault_evt_Redeem, params
  WHERE contract_address = params.vault
),
first_seen AS (
  SELECT "user", MIN(day) AS first_day FROM deposits GROUP BY 1
),
dep_daily AS (
  SELECT day, COUNT(*) AS deposit_count, COUNT(DISTINCT "user") AS depositors,
         SUM(vlt_in) AS vlt_in, SUM(usdc_in) AS usdc_in
  FROM deposits GROUP BY 1
),
red_daily AS (
  SELECT day, COUNT(*) AS redeem_count, COUNT(DISTINCT "user") AS redeemers,
         SUM(vlt_out) AS vlt_out, SUM(usdc_out) AS usdc_out
  FROM redeems GROUP BY 1
),
new_daily AS (
  SELECT first_day AS day, COUNT(*) AS new_users FROM first_seen GROUP BY 1
),
spine AS (
  SELECT t.day
  FROM (SELECT CAST(MIN(day) AS DATE) AS d0 FROM deposits) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
)
SELECT
  s.day,
  COALESCE(d.deposit_count, 0) AS deposit_count,
  COALESCE(d.depositors, 0)    AS depositors,
  COALESCE(r.redeem_count, 0)  AS redeem_count,
  COALESCE(r.redeemers, 0)     AS redeemers,
  COALESCE(d.vlt_in, 0) * p.usdc_per_vlt + COALESCE(d.usdc_in, 0)   AS deposit_usd_gross,
  COALESCE(r.vlt_out, 0) * p.usdc_per_vlt + COALESCE(r.usdc_out, 0) AS redeem_usd,
  (COALESCE(d.vlt_in, 0) - COALESCE(r.vlt_out, 0)) * p.usdc_per_vlt
    + COALESCE(d.usdc_in, 0) - COALESCE(r.usdc_out, 0)              AS net_flow_usd,
  SUM(COALESCE(n.new_users, 0)) OVER (ORDER BY s.day)               AS cumulative_users
FROM spine s
LEFT JOIN dep_daily d ON d.day = s.day
LEFT JOIN red_daily r ON r.day = s.day
LEFT JOIN new_daily n ON n.day = s.day
LEFT JOIN price_daily p ON p.day = s.day
ORDER BY s.day
