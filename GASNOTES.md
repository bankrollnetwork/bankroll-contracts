# Gas notes: deposit-triggered auto-compound (branch-only notes)

Final design on this branch: **no public `compound()` and no fee of any kind** — `deposit()`
checks `compoundClaimable()` and, at `AUTO_COMPOUND_MIN_USDC` ($100, ungoverned constant), runs
the compound leg via `try this.autoCompound() {} catch { emit AutoCompoundFailed(); }`.
`autoCompound()` is self-call-only (external only so try/catch works) and carries no reentrancy
guard (deposit holds it). 100% of every harvest reinvests for holders; the triggering depositor
just pays the gas.

Measured with `test/gas.autocompound.test.js` (local PoolManager, solc 0.8.26 viaIR, cancun):

| Scenario | pre-branch baseline | this design | Δ |
|---|---|---|---|
| Quiet direct deposit (below trigger) | 221,489 | 237,913 | **+16.4k** standing view-check tax |
| Direct deposit, ≥$100 claimable (compound fires) | 315,428 | 482,617 | +167k on the triggering deposit |
| Deposit right after a trigger | 221,538 | 237,965 | +16.4k (back to quiet cost) |
| Quiet zapDeposit | 382,816 | 395,938 | +13.1k |
| zapDeposit, ≥$100 claimable (compound fires) | 426,099 | 573,844 | +148k |

(The removed keeper path used to cost 418k for `compound()` + 222k for the deposit = 640k across
two txs; dropping the finder payout then shaved another ~15k off the triggering deposit.)

Correctness observations:
- Compound fires inside the deposit; claimable drops $131 → ~$0.50; the depositor's leftovers
  are pure deposit refunds (no payout of any kind — asserted by the suite).
- Full suite green (61 passing). Donation-inertness was rewritten to socialization semantics
  (donations reinvest for pre-existing holders at the next trigger; the depositor still gets
  fair, non-zero, `minShares`-guarded shares; inflation griefing stays a money-loser thanks to
  MINIMUM_LIQUIDITY).
- Known tradeoff: with no public compound, fees only reinvest on deposit flow — quiet markets
  defer reinvestment (value-neutral: deposit/redeem retain accrued fees for all holders), and
  the trailing-APR ring only snapshots on triggering deposits. `AutoCompoundFailed` is the
  monitoring signal for a persistently reverting compound leg.
- Event change: `Compound(uint256 vltFees, uint256 usdcFees, uint128 liquidityAdded)` — topic0
  `0x9bc6dc46…`; DefiLlama/Dune adapters updated (supply-side == fees, keeper query deleted).
