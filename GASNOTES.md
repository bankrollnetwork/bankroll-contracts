# Gas notes: deposit-triggered auto-compound (branch-only notes)

Final design on this branch: **no public `compound()`** — `deposit()` checks `compoundClaimable()`
and, at `AUTO_COMPOUND_MIN_USDC` ($100, ungoverned constant), runs the compound leg via
`try this.autoCompound(msg.sender) {} catch { emit AutoCompoundFailed(); }`. `autoCompound` is
self-call-only and carries no reentrancy guard (deposit holds it). The triggering depositor earns
the 1% finder fee on the fresh harvest as a gas rebate.

Measured with `test/gas.autocompound.test.js` (local PoolManager, solc 0.8.26 viaIR, cancun):

| Scenario | pre-branch baseline | this design | Δ |
|---|---|---|---|
| Quiet direct deposit (below trigger) | 221,489 | 238,765 | **+17.3k** standing view-check tax |
| Direct deposit, ≥$100 claimable (compound fires) | 315,428 | 497,922 | +182k on the triggering deposit |
| Deposit right after a trigger | 221,538 | 238,817 | +17.3k (back to quiet cost) |
| Quiet zapDeposit | 382,816 | 396,620 | +13.8k |
| zapDeposit, ≥$100 claimable (compound fires) | 426,099 | 592,739 | +167k |

(The removed keeper path used to cost 418k for `compound()` + 222k for the deposit = 640k across
two txs; the in-deposit compound does the same work in one 498k tx.)

Correctness observations:
- Compound fires inside the deposit; claimable drops $131 → ~$0.50; finder rebate reaches the
  depositor directly and, via the ZapHelper, is swept to the end user (helper residue == 0).
- Full suite green (61 passing): the donation-inertness test was rewritten to the new semantics
  (donations are socialized to pre-existing holders by the next trigger deposit; the depositor
  still receives fair, non-zero, `minShares`-guarded shares; inflation griefing stays a
  money-loser thanks to MINIMUM_LIQUIDITY).
- Known tradeoff: with no public compound, fees only reinvest on deposit flow — quiet markets
  defer reinvestment (value-neutral: deposit/redeem retain accrued fees for all holders), and the
  trailing-APR ring only snapshots on triggering deposits. `AutoCompoundFailed` is the monitoring
  signal for a persistently reverting compound leg.
