# vltUSDC — Dune dashboard

Eight DuneSQL queries forming a complete vltUSDC dashboard: fees, TVL, share metrics / fee
APR, keeper economics, depositor activity, holders, and pool price/volume. Written **before**
mainnet deployment — see the fill-in checklist at the bottom.

## Queries

| File | Shows | Needs vault decoding? |
|---|---|---|
| `01_pool_meta.sql` | Pool id + init price (base CTE every query inlines) | No |
| `02_fees_daily.sql` | Daily + cumulative realized fees (compound vs retained split), keeper cut, supply-side | **Yes** |
| `03_tvl.sql` | TVL time series: position L → token amounts at pool price + retained balances | No |
| `04_share_metrics.sql` | totalSupply, L/share, lifetime/7d/30d fee APR (bps, mirrors `feeApr()`) | No |
| `05_keeper_economics.sql` | Per-compound finder payout vs gas, keeper P&L + leaderboard | **Yes** |
| `06_depositor_activity.sql` | Daily deposits/redeems, USD flows, unique + cumulative users | **Yes** |
| `07_holders.sql` | Holder count + top-20 with % of supply | No |
| `08_vlt_price_volume.sql` | VLT price (from the pool itself) + daily volume | No |

Half the dashboard (01, 03, 04, 07, 08) runs **day one** after deploy — it needs only the
already-decoded `uniswap_v4_ethereum.PoolManager_evt_*` and `erc20_ethereum.evt_Transfer`
tables. The other half needs the vault ABI decoded (below), or the raw-log fallback.

## Suggested dashboard layout

- **Row 1 — KPI counters:** TVL (03, latest row), cumulative fees USD (02), 7d APR bps (04),
  holders (07), VLT price (08).
- **Row 2:** fees bar chart daily + cumulative line (02) · TVL stacked area, position vs
  retained (03).
- **Row 3:** L/share + APR lines (04) · price/volume combo (08).
- **Row 4:** keeper economics table + leaderboard (05).
- **Row 5:** deposits/redeems + cumulative users (06) · top holders table (07).

## Setup after mainnet deploy

1. **Submit the vault for decoding** (~24h): dune.com → Library → Contracts → *Submit
   contract* (dune.com/contracts/new). Address = the deployed vault; ABI from
   `artifacts/contracts/VltUsdcVault.sol/VltUsdcVault.json`; suggested namespace **`vltusdc`**,
   contract name **`VltUsdcVault`**; "used by many addresses" = No (single instance).
2. **Save `01_pool_meta.sql` first**, confirm it returns exactly one row with
   `pool_id = 0x6d8b638359c82df5d455985885175dee28c05c646f46facb800a1e3ffe0c1534` (the id of
   the canonical VLT/USDC 1% key — recompute if the pool was created with different params).
3. Save the rest, set the `{{vault_address}}` parameter default to the deployed address, and
   assemble the dashboard per the layout above.

## Fill-in checklist (post-deploy)

- [ ] `{{vault_address}}` parameter default on every query (lowercase 0x… text).
- [ ] Namespace: queries reference `vltusdc_ethereum.VltUsdcVault_evt_*` — find-replace if the
      decode submission used a different namespace.
- [ ] Confirm `uniswap_v4_ethereum.PoolManager_evt_{Initialize,ModifyLiquidity,Swap}` exist
      under that exact schema in Dune's data explorer (naming verified against sepolia docs;
      mainnet should match).
- [ ] `prices.usd` WETH join in 05: swap to `prices.day` if Dune retires the legacy table.
- [ ] Sanity-check 03/04 against the vault's own views (`positionLiquidity()`,
      `previewRedeem(totalSupply())`, `feeApr()`) — the SQL uses double-precision display math;
      the contract is the exact source of truth.

## Raw-log fallback (before decoding lands)

Every vault-event query can be rewritten against `ethereum.logs` with
`contract_address = {{vault_address}}` and these topic0 hashes (computed from the final ABI,
verified July 2026):

| Event | topic0 |
|---|---|
| `Deposit(address,uint256,uint256,uint256,uint128)` | `0x9cd8ced6480eb3fbc8c1110cbd3e34bd49019b580a57cf1e3a51640acd592ec9` |
| `Redeem(address,uint256,uint256,uint256)` | `0xbd5034ffbd47e4e72a94baa2cdb74c6fad73cb3bcdc13036b72ec8306f5a7646` |
| `Compound(address,uint256,uint256,uint256,uint256,uint128)` | `0xb824c165a8c590db06a9880ff2259a602e9057773daddafef70a6c1a93401b9b` |
| `FeesRetained(uint256,uint256)` | `0xbc53b087a813a8221528ece92a23d8e12b158c878f9062d121c7656fdc0a5dc2` |

Non-indexed args live ABI-packed in `data` (32 bytes each, in declaration order); e.g. for
`FeesRetained`: `fee0 = varbinary_to_uint256(substr(data, 1, 32))`,
`fee1 = varbinary_to_uint256(substr(data, 33, 32))`. `Compound.finder` is `topic1`
(right-most 20 bytes) and its `data` holds `fee0, fee1, finder0, finder1, liquidityAdded`.

## Semantics worth remembering (baked into the query comments too)

- Token ordering: `*0` = VLT (18d), `*1` = USDC (6d) everywhere.
- `Deposit.vltIn/usdcIn` are **gross pre-refund** — deposit volume is an upper bound; use
  `liquidityAdded` / PoolManager `ModifyLiquidity` for exact position accounting.
- Shares have `decimals() == 0` (raw L units): report % of supply, not raw counts.
- Position L on Dune = cumulative `liquidityDelta` from `ModifyLiquidity` where
  `sender = vault` — this exactly matches `positionLiquidity()` (redeems included).
- Fees identity: realized fees = Σ `Compound.fee` + Σ `FeesRetained.fee`; the finder cut is
  the only non-shareholder outflow; protocol take is structurally zero.
