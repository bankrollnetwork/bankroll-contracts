-- vltUSDC · 03 — TVL time series
-- TVL = the vault's full-range V4 position, decomposed into token amounts at each day's pool
-- price, PLUS the retained VLT/USDC balances sitting on the vault (fees awaiting compound).
--   position L  : cumulative liquidityDelta from PoolManager ModifyLiquidity where sender = vault
--                 (captures deposits, redeems AND compounds exactly — matches positionLiquidity()).
--   amounts     : amount0 = L·(1/√P − 1/√P_max), amount1 = L·(√P − √P_min), √P = sqrtPriceX96/2^96.
--                 Full-range bounds at ticks ±887200: √P_max = 1.8379767623686416e19,
--                 √P_min = 5.440765196134894e-20 (double-precision display math; the exact
--                 on-chain truth is vault.previewRedeem(totalSupply())).
--   retained    : Σ ERC-20 Transfers to-vault − from-vault per token (== balanceOf(vault) for
--                 standard tokens; cross-check tokens_ethereum.balances_daily if desired).
-- Tables: uniswap_v4_ethereum.PoolManager_evt_{Initialize,ModifyLiquidity,Swap},
--         erc20_ethereum.evt_Transfer.  (No decoded vault tables needed — runs day one.)
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
  FROM (SELECT CAST(MIN(day) AS DATE) AS d0 FROM liq_daily) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
),
price_daily AS (
  SELECT CAST(s.evt_block_time AS DATE) AS day,
         MAX_BY(CAST(s."sqrtPriceX96" AS DOUBLE), s.evt_block_time) AS sqrt_px96
  FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
  JOIN pool ON s.id = pool.pool_id
  GROUP BY 1
),
retained_daily AS (
  SELECT CAST(t.evt_block_time AS DATE) AS day,
         SUM(CASE WHEN t.contract_address = 0x6b785a0322126826d8226d77e173d75dafb84d11
                  THEN (CASE WHEN t."to" = params.vault THEN CAST(t.value AS DOUBLE)
                             ELSE -CAST(t.value AS DOUBLE) END) ELSE 0 END) AS vlt_net,
         SUM(CASE WHEN t.contract_address = 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
                  THEN (CASE WHEN t."to" = params.vault THEN CAST(t.value AS DOUBLE)
                             ELSE -CAST(t.value AS DOUBLE) END) ELSE 0 END) AS usdc_net
  FROM erc20_ethereum.evt_Transfer t
  CROSS JOIN params
  WHERE t.contract_address IN (0x6b785a0322126826d8226d77e173d75dafb84d11,
                               0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48)
    AND (t."to" = params.vault OR t."from" = params.vault)
  GROUP BY 1
),
series AS (
  SELECT s.day,
         SUM(COALESCE(l.dl, 0)) OVER (ORDER BY s.day)        AS position_l,
         LAST_VALUE(p.sqrt_px96) IGNORE NULLS
           OVER (ORDER BY s.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
           / POWER(2, 96)                                    AS sqrt_p,
         SUM(COALESCE(r.vlt_net, 0)) OVER (ORDER BY s.day)   AS retained_vlt_raw,
         SUM(COALESCE(r.usdc_net, 0)) OVER (ORDER BY s.day)  AS retained_usdc_raw
  FROM spine s
  LEFT JOIN liq_daily l      ON l.day = s.day
  LEFT JOIN price_daily p    ON p.day = s.day
  LEFT JOIN retained_daily r ON r.day = s.day
)
SELECT
  day,
  position_l,
  -- position token amounts (raw → human decimals)
  position_l * (1 / sqrt_p - 1 / 1.8379767623686416e19) / 1e18 AS position_vlt,
  position_l * (sqrt_p - 5.440765196134894e-20) / 1e6          AS position_usdc,
  retained_vlt_raw / 1e18                                       AS retained_vlt,
  retained_usdc_raw / 1e6                                       AS retained_usdc,
  POWER(sqrt_p, 2) * 1e12                                       AS usdc_per_vlt,
  -- TVL in USD (USDC at $1.00; VLT at the pool's own price)
  (position_l * (1 / sqrt_p - 1 / 1.8379767623686416e19) / 1e18 + retained_vlt_raw / 1e18)
    * (POWER(sqrt_p, 2) * 1e12)
  + (position_l * (sqrt_p - 5.440765196134894e-20) / 1e6 + retained_usdc_raw / 1e6)
                                                                AS tvl_usd
FROM series
WHERE sqrt_p IS NOT NULL
ORDER BY day
