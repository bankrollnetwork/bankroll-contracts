-- vltUSDC · 06 — depositor activity & flows
-- Daily deposit/redeem counts, USD volumes, unique + cumulative-new users, and net flow.
-- Event semantics: Deposit.vltUsed/usdcUsed are the amounts the pool actually CONSUMED
-- (post-refund) and Redeem.vltOut/usdcOut are exact, so volumes and net flow here are
-- exact — no dust caveat. All vault event amounts are token-named (vlt* 18d / usdc* 6d);
-- no currency0/1 mapping is ever needed.
-- Attribution: Deposit.recipient is the SHARE OWNER (zaps included — the vault mints
-- straight to the end wallet); Deposit.sender is the payer, so sender != recipient flags a
-- zapped/on-behalf entry. Redeem.owner is whose shares burned (receiver only got the tokens).
-- Tables: vltusdc_ethereum.VltUsdcVault_evt_{Deposit,Redeem} (namespace: find-replace if
--   different), uniswap_v4_ethereum.PoolManager_evt_{Initialize,Swap} (price).
-- Params: {{vault_address}} (text, 0x-prefixed).
-- Pre-decoding fallback: ethereum.logs with topic0 Deposit 0xae7fb4f0…, Redeem 0x215abfcd…
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
  SELECT CAST(evt_block_time AS DATE) AS day, "recipient" AS "user",
         CAST("vltUsed" AS DOUBLE) / 1e18 AS vlt_in,
         CAST("usdcUsed" AS DOUBLE) / 1e6 AS usdc_in
  FROM vltusdc_ethereum.VltUsdcVault_evt_Deposit, params
  WHERE contract_address = params.vault
),
redeems AS (
  SELECT CAST(evt_block_time AS DATE) AS day, "owner" AS "user",
         CAST("vltOut" AS DOUBLE) / 1e18 AS vlt_out,
         CAST("usdcOut" AS DOUBLE) / 1e6 AS usdc_out
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
  COALESCE(d.vlt_in, 0) * p.usdc_per_vlt + COALESCE(d.usdc_in, 0)   AS deposit_usd,
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
