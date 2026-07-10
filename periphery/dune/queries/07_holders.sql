-- vltUSDC · 07 — share holders
-- Current vltUSDC holders from the share token's own Transfer events (the share token IS the
-- vault contract). Shares have decimals() == 0 — balances are raw integer liquidity (L) units,
-- so "share of supply" (pct) is the meaningful column, not the raw count.
-- Runs DAY ONE after deploy: needs only erc20_ethereum.evt_Transfer, no custom decoding.
-- The 1,000 dead shares at 0xdEaD are the permanently locked first-deposit inflation guard.
-- Tables: erc20_ethereum.evt_Transfer.
-- Params: {{vault_address}} (text, 0x-prefixed).

WITH params AS (
  SELECT FROM_HEX(SUBSTR(LOWER('{{vault_address}}'), 3)) AS vault
),
flows AS (
  SELECT t."to" AS holder, CAST(t.value AS DOUBLE) AS amt
  FROM erc20_ethereum.evt_Transfer t CROSS JOIN params
  WHERE t.contract_address = params.vault
  UNION ALL
  SELECT t."from" AS holder, -CAST(t.value AS DOUBLE) AS amt
  FROM erc20_ethereum.evt_Transfer t CROSS JOIN params
  WHERE t.contract_address = params.vault
),
balances AS (
  SELECT holder, SUM(amt) AS shares
  FROM flows
  WHERE holder <> 0x0000000000000000000000000000000000000000
  GROUP BY 1
  HAVING SUM(amt) > 0
),
supply AS (
  SELECT SUM(shares) AS total FROM balances
)
SELECT
  ROW_NUMBER() OVER (ORDER BY b.shares DESC) AS rank,
  CASE WHEN b.holder = 0x000000000000000000000000000000000000dead
       THEN 'locked (dead shares)' ELSE CAST(b.holder AS VARCHAR) END AS holder,
  b.shares,
  b.shares / s.total * 100 AS pct_of_supply,
  (SELECT COUNT(*) FROM balances) AS holder_count
FROM balances b
CROSS JOIN supply s
ORDER BY b.shares DESC
LIMIT 20
