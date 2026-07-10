-- vltUSDC · 09 — per-wallet PnL
-- Realized + unrealized PnL for every wallet that has ever held vltUSDC, from events alone.
-- Enabled by the token-named event surface: Deposit attributes cost to `recipient` (zaps
-- included — the vault mints straight to the end wallet) with vltUsed/usdcUsed the amounts
-- the pool actually CONSUMED (post-refund), and Redeem attributes proceeds to `owner`.
--
-- Method — lifetime AVERAGE COST per wallet (order-independent, dashboard-friendly):
--   acquisitions = deposits (cost = vltUsed·price + usdcUsed)
--                + incoming wallet-to-wallet share transfers, marked at that day's NAV/share
--   disposals    = redeems (proceeds = vltOut·price + usdcOut)
--                + outgoing wallet transfers, marked at that day's NAV/share
--   avg_cost/share = Σ acquisition cost / Σ acquired shares
--   realized PnL   = Σ disposal value − disposed shares × avg_cost
--   unrealized PnL = current shares × (current NAV/share − avg_cost)
-- NAV/share = (position value at pool price + retained balances) / totalSupply — same math
-- as 03/04. CONVENTIONS: share transfers realize PnL for the sender and reset basis for the
-- receiver at transfer-day NAV; zap cost basis is measured at the vault boundary (what was
-- deployed), so the zap's external swap fee (~0.5% of the swapped leg) is NOT in the basis;
-- USD values use the pool's own VLT price with USDC at $1.00.
-- Tables: vltusdc_ethereum.VltUsdcVault_evt_{Deposit,Redeem},
--         uniswap_v4_ethereum.PoolManager_evt_{Initialize,ModifyLiquidity,Swap},
--         erc20_ethereum.evt_Transfer.
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
share_transfers AS (
  SELECT CAST(t.evt_block_time AS DATE) AS day, t."from" AS from_w, t."to" AS to_w,
         CAST(t.value AS DOUBLE) AS shares
  FROM erc20_ethereum.evt_Transfer t CROSS JOIN params
  WHERE t.contract_address = params.vault
),
-- Spine from pool creation (precedes all vault activity), and the price series seeded from
-- the Initialize event itself — so deposits BEFORE the pool's first swap still get a price.
spine AS (
  SELECT t.day
  FROM (SELECT CAST(MIN(i.evt_block_time) AS DATE) AS d0
        FROM uniswap_v4_ethereum.PoolManager_evt_Initialize i
        JOIN pool ON i.id = pool.pool_id) b
  CROSS JOIN UNNEST(SEQUENCE(b.d0, CURRENT_DATE, INTERVAL '1' DAY)) AS t(day)
),
price_raw AS (
  SELECT day, MAX_BY(sqrt_px96, ts) AS sqrt_px96
  FROM (
    SELECT CAST(s.evt_block_time AS DATE) AS day, s.evt_block_time AS ts,
           CAST(s."sqrtPriceX96" AS DOUBLE) AS sqrt_px96
    FROM uniswap_v4_ethereum.PoolManager_evt_Swap s
    JOIN pool ON s.id = pool.pool_id
    UNION ALL
    SELECT CAST(i.evt_block_time AS DATE), i.evt_block_time,
           CAST(i."sqrtPriceX96" AS DOUBLE)
    FROM uniswap_v4_ethereum.PoolManager_evt_Initialize i
    JOIN pool ON i.id = pool.pool_id
  )
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
-- Supply forward-filled over the full spine so NAV/share stays current on days with no
-- vault activity (price still moves via pool swaps).
supply_daily AS (
  SELECT sp.day, SUM(COALESCE(x.minted - x.burned, 0)) OVER (ORDER BY sp.day) AS supply
  FROM spine sp
  LEFT JOIN (
    SELECT day,
           SUM(CASE WHEN from_w = 0x0000000000000000000000000000000000000000 THEN shares ELSE 0 END) AS minted,
           SUM(CASE WHEN to_w = 0x0000000000000000000000000000000000000000 THEN shares ELSE 0 END) AS burned
    FROM share_transfers GROUP BY 1
  ) x ON x.day = sp.day
),
-- Daily NAV/share (USD): position amounts at the day's pool price + retained, over supply.
nav_daily AS (
  SELECT s.day,
         POWER(sqrt_p, 2) * 1e12 AS usdc_per_vlt,
         CASE WHEN sup.supply > 0 THEN
           ((pos_l * (1 / sqrt_p - 1 / 1.8379767623686416e19) / 1e18 + ret_vlt / 1e18)
              * (POWER(sqrt_p, 2) * 1e12)
            + (pos_l * (sqrt_p - 5.440765196134894e-20) / 1e6 + ret_usdc / 1e6)) / sup.supply
         END AS nav_per_share
  FROM (
    SELECT sp.day,
           SUM(COALESCE(l.dl, 0)) OVER (ORDER BY sp.day)      AS pos_l,
           LAST_VALUE(p.sqrt_px96) IGNORE NULLS
             OVER (ORDER BY sp.day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
             / POWER(2, 96)                                   AS sqrt_p,
           SUM(COALESCE(r.vlt_net, 0)) OVER (ORDER BY sp.day) AS ret_vlt,
           SUM(COALESCE(r.usdc_net, 0)) OVER (ORDER BY sp.day) AS ret_usdc
    FROM spine sp
    LEFT JOIN liq_daily l      ON l.day = sp.day
    LEFT JOIN price_raw p      ON p.day = sp.day
    LEFT JOIN retained_daily r ON r.day = sp.day
  ) s
  JOIN supply_daily sup ON sup.day = s.day
  WHERE s.sqrt_p IS NOT NULL
),
-- Acquisitions: deposits at consumed-amount cost + incoming wallet transfers at NAV.
acquisitions AS (
  SELECT CAST(d.evt_block_time AS DATE) AS day, d.recipient AS wallet,
         CAST(d."sharesOut" AS DOUBLE) AS shares,
         CAST(d."vltUsed" AS DOUBLE) / 1e18 * n.usdc_per_vlt
           + CAST(d."usdcUsed" AS DOUBLE) / 1e6 AS cost_usd
  FROM vltusdc_ethereum.VltUsdcVault_evt_Deposit d
  CROSS JOIN params
  JOIN nav_daily n ON n.day = CAST(d.evt_block_time AS DATE)
  WHERE d.contract_address = params.vault
  UNION ALL
  SELECT t.day, t.to_w, t.shares, t.shares * n.nav_per_share
  FROM share_transfers t
  JOIN nav_daily n ON n.day = t.day
  WHERE t.from_w <> 0x0000000000000000000000000000000000000000
    AND t.to_w   <> 0x0000000000000000000000000000000000000000
),
-- Disposals: redeems at in-kind proceeds + outgoing wallet transfers at NAV.
disposals AS (
  SELECT CAST(r.evt_block_time AS DATE) AS day, r."owner" AS wallet,
         CAST(r."sharesIn" AS DOUBLE) AS shares,
         CAST(r."vltOut" AS DOUBLE) / 1e18 * n.usdc_per_vlt
           + CAST(r."usdcOut" AS DOUBLE) / 1e6 AS value_usd
  FROM vltusdc_ethereum.VltUsdcVault_evt_Redeem r
  CROSS JOIN params
  JOIN nav_daily n ON n.day = CAST(r.evt_block_time AS DATE)
  WHERE r.contract_address = params.vault
  UNION ALL
  SELECT t.day, t.from_w, t.shares, t.shares * n.nav_per_share
  FROM share_transfers t
  JOIN nav_daily n ON n.day = t.day
  WHERE t.from_w <> 0x0000000000000000000000000000000000000000
    AND t.to_w   <> 0x0000000000000000000000000000000000000000
),
per_wallet AS (
  SELECT COALESCE(a.wallet, d.wallet) AS wallet,
         COALESCE(a.shares_in, 0)  AS shares_acquired,
         COALESCE(a.cost_usd, 0)   AS total_cost_usd,
         COALESCE(d.shares_out, 0) AS shares_disposed,
         COALESCE(d.value_usd, 0)  AS total_proceeds_usd,
         COALESCE(a.first_day, d.first_day) AS first_seen
  FROM (SELECT wallet, SUM(shares) AS shares_in, SUM(cost_usd) AS cost_usd, MIN(day) AS first_day
        FROM acquisitions GROUP BY 1) a
  FULL OUTER JOIN
       (SELECT wallet, SUM(shares) AS shares_out, SUM(value_usd) AS value_usd, MIN(day) AS first_day
        FROM disposals GROUP BY 1) d
    ON a.wallet = d.wallet
),
latest AS (
  SELECT MAX_BY(nav_per_share, day) AS nav_now FROM nav_daily WHERE nav_per_share IS NOT NULL
)
SELECT
  CASE WHEN w.wallet = 0x000000000000000000000000000000000000dead
       THEN 'locked (dead shares)' ELSE CAST(w.wallet AS VARCHAR) END       AS wallet,
  w.shares_acquired - w.shares_disposed                                     AS current_shares,
  (w.shares_acquired - w.shares_disposed) * l.nav_now                       AS position_usd,
  w.total_cost_usd                                                          AS lifetime_cost_usd,
  w.total_proceeds_usd                                                      AS lifetime_proceeds_usd,
  -- lifetime average cost per share (0-acquisition wallets can't exist: every share arrives
  -- via a deposit or an incoming transfer, both counted as acquisitions)
  w.total_cost_usd / NULLIF(w.shares_acquired, 0)                           AS avg_cost_per_share,
  w.total_proceeds_usd
    - w.shares_disposed * (w.total_cost_usd / NULLIF(w.shares_acquired, 0)) AS realized_pnl_usd,
  (w.shares_acquired - w.shares_disposed)
    * (l.nav_now - w.total_cost_usd / NULLIF(w.shares_acquired, 0))         AS unrealized_pnl_usd,
  w.total_proceeds_usd
    - w.shares_disposed * (w.total_cost_usd / NULLIF(w.shares_acquired, 0))
    + (w.shares_acquired - w.shares_disposed)
    * (l.nav_now - w.total_cost_usd / NULLIF(w.shares_acquired, 0))         AS total_pnl_usd,
  100 * (w.total_proceeds_usd
    - w.shares_disposed * (w.total_cost_usd / NULLIF(w.shares_acquired, 0))
    + (w.shares_acquired - w.shares_disposed)
    * (l.nav_now - w.total_cost_usd / NULLIF(w.shares_acquired, 0)))
    / NULLIF(w.total_cost_usd, 0)                                           AS roi_pct,
  w.first_seen
FROM per_wallet w
CROSS JOIN latest l
WHERE w.shares_acquired > 0
ORDER BY total_pnl_usd DESC
