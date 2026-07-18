# Gas notes: deposit-triggered auto-compound (branch-only notes)

Final design on this branch: **deposit-triggered compounding with no fee of any kind and NO
compound entrypoint** — the external write surface is `deposit` + `redeem`, full stop.
`deposit()` (external, `nonReentrant`) checks `compoundClaimable()` and, at
`AUTO_COMPOUND_MIN_USDC` ($100, ungoverned constant) with the position existing (the pre-seed
gate — see AUDIT.MD §7d M-01), calls the internal `_compound()` directly. 100% of every
harvest reinvests for holders; a small deposit is the manual compound in a quiet market.
The rebalance swaps ~half the value-imbalance of the WHOLE loose balance, bounded only by
the ≤5% `sqrtPriceLimitX96` (the fresh-fee `REBALANCE_CAP_MULT` was removed — see AUDIT.MD
§7d — so trigger and action share the same value base and one-sided value never idles).
Guards live only on the external entrypoints. Deposit and compound share fate by design: a
reverting compound leg reverts the triggering deposit (the leg is argument-free).

Measured with `test/gas.autocompound.test.js` (local PoolManager, solc 0.8.26 viaIR, cancun):

| Scenario | pre-branch baseline | this design | Δ |
|---|---|---|---|
| Quiet direct deposit (below trigger) | 221,489 | 237,463 | **+16.0k** standing view-check tax |
| Direct deposit, ≥$100 claimable (compound fires) | 315,428 | 526,809 | +211k on the triggering deposit (incl. two cold totalFees SSTOREs; ~+10k warm) |
| Deposit right after a trigger | 221,538 | 237,515 | +16.0k (back to quiet cost) |
| Quiet zapDeposit | 382,816 | 399,773 | +17.0k |
| zapDeposit, ≥$100 claimable (compound fires) | 426,099 | 620,497 | +194k |

Post-Shieldify-hardening numbers (immutable positionKey caching nets out the new deposit
requires, −0.5k on vault paths; the ZapHelper rows absorb its new ReentrancyGuard + deadline,
+3.8k / +1.6k).

(The removed keeper path used to cost 418k for `compound()` + 222k for the deposit = 640k across
two txs; dropping the finder payout then shaved another ~15k off the triggering deposit.)

Correctness observations:
- Compound fires inside the deposit; claimable drops $131 → ~$0.50; the depositor's leftovers
  are pure deposit refunds (no payout of any kind — asserted by the suite).
- Full suite green (61 passing). Donation-inertness was rewritten to socialization semantics
  (donations reinvest for pre-existing holders at the next trigger; the depositor still gets
  fair, non-zero, `minShares`-guarded shares; inflation griefing stays a money-loser thanks to
  MINIMUM_LIQUIDITY).
- Known tradeoff: with no incentive, compounding normally rides on deposit flow — quiet
  markets defer reinvestment (value-neutral: deposit/redeem retain accrued fees for all
  holders). Anyone can force a compound with a small deposit in a quiet market.
- Event change: `Compound(uint256 vltFees, uint256 usdcFees, uint128 liquidityAdded)` — topic0
  `0x9bc6dc46…`; DefiLlama/Dune adapters updated (supply-side == fees, keeper query deleted).
