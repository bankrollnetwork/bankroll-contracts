-- vltUSDC · 05 — keeper (finder) economics
-- Per-compound: what the keeper earned (the 1% in-kind finder cut) vs what the transaction
-- cost in gas — the self-regulating economics the vault's design relies on — plus a keeper
-- leaderboard. VLT leg valued at the pool's own price on the day; ETH gas via prices.usd
-- (WETH, minute table averaged per day — swap to prices.day if preferred).
-- Tables: vltusdc_ethereum.VltUsdcVault_evt_Compound (namespace: find-replace if different),
--         uniswap_v4_ethereum.PoolManager_evt_{Initialize,Swap}, ethereum.transactions,
--         prices.usd (WETH).
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
price_daily AS (
  SELECT CAST(s.evt_block_time AS DATE) AS day,
         POWER(MAX_BY(CAST(s."sqrtPriceX96" AS DOUBLE), s.evt_block_time) / POWER(2, 96), 2) * 1e12
           AS usdc_per_vlt
  FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
  JOIN pool ON s.id = pool.pool_id
  GROUP BY 1
),
eth_daily AS (
  SELECT CAST(minute AS DATE) AS day, AVG(price) AS eth_usd
  FROM prices.usd
  WHERE blockchain = 'ethereum'
    AND contract_address = 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2  -- WETH
  GROUP BY 1
),
compounds AS (
  SELECT c.evt_block_time,
         CAST(c.evt_block_time AS DATE) AS day,
         c.finder,
         c.evt_tx_hash,
         CAST(c.fee0 AS DOUBLE) / 1e18     AS fee_vlt,
         CAST(c.fee1 AS DOUBLE) / 1e6      AS fee_usdc,
         CAST(c.finder0 AS DOUBLE) / 1e18  AS finder_vlt,
         CAST(c.finder1 AS DOUBLE) / 1e6   AS finder_usdc,
         CAST(c."liquidityAdded" AS DOUBLE) AS liquidity_added,
         CAST(t.gas_used AS DOUBLE) * CAST(t.gas_price AS DOUBLE) / 1e18 AS gas_eth,
         t."from" AS tx_sender
  FROM vltusdc_ethereum.VltUsdcVault_evt_Compound c
  CROSS JOIN params
  JOIN ethereum.transactions t
    ON t.hash = c.evt_tx_hash AND t.block_number = c.evt_block_number
  WHERE c.contract_address = params.vault
),
per_compound AS (
  SELECT c.*,
         c.finder_vlt * p.usdc_per_vlt + c.finder_usdc AS finder_usd,
         c.fee_vlt * p.usdc_per_vlt + c.fee_usdc       AS harvest_usd,
         c.gas_eth * e.eth_usd                          AS gas_usd
  FROM compounds c
  LEFT JOIN price_daily p ON p.day = c.day
  LEFT JOIN eth_daily e   ON e.day = c.day
)
-- Output A: per-compound detail (switch the final SELECT for the leaderboard below).
SELECT
  evt_block_time,
  finder,
  harvest_usd,
  finder_usd,
  gas_usd,
  finder_usd - gas_usd AS keeper_profit_usd,
  liquidity_added,
  evt_tx_hash
FROM per_compound
ORDER BY evt_block_time DESC

-- Output B (leaderboard) — save as a second query with the same CTEs, final SELECT:
-- SELECT finder,
--        COUNT(*)                       AS compounds,
--        SUM(finder_usd)                AS total_earned_usd,
--        SUM(finder_usd - gas_usd)      AS total_profit_usd,
--        AVG(finder_usd - gas_usd)      AS avg_profit_usd
-- FROM per_compound
-- GROUP BY finder
-- ORDER BY total_earned_usd DESC
