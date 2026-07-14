# Gas notes: deposit-triggered auto-compound (branch-only notes)

Final design on this branch: **deposit-triggered compounding with no fee of any kind** —
`deposit()` (external, `nonReentrant`) checks `compoundClaimable()` and, at
`AUTO_COMPOUND_MIN_USDC` ($100, ungoverned constant), calls the internal `_compound()` directly.
`compound()` (external, `nonReentrant`, UNINCENTIVIZED) wraps the same leg — anyone may call it
(quiet-market safety valve) but earns nothing; 100% of every harvest reinvests for holders.
Guards live only on the external entrypoints. Deposit and compound share fate by design: a
reverting compound leg reverts the triggering deposit (the leg is argument-free with hard
internal bounds, and the public compound() reproduces any revert loudly for diagnosis).

Measured with `test/gas.autocompound.test.js` (local PoolManager, solc 0.8.26 viaIR, cancun):

| Scenario | pre-branch baseline | this design | Δ |
|---|---|---|---|
| Quiet direct deposit (below trigger) | 221,489 | 237,891 | **+16.4k** standing view-check tax |
| Direct deposit, ≥$100 claimable (compound fires) | 315,428 | 481,504 | +165k on the triggering deposit |
| Deposit right after a trigger | 221,538 | 237,943 | +16.4k (back to quiet cost) |
| Quiet zapDeposit | 382,816 | 395,920 | +13.1k |
| zapDeposit, ≥$100 claimable (compound fires) | 426,099 | 572,731 | +147k |

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
  holders). Anyone can call the public compound() as a gas donation to close the gap.
- Event change: `Compound(uint256 vltFees, uint256 usdcFees, uint128 liquidityAdded)` — topic0
  `0x9bc6dc46…`; DefiLlama/Dune adapters updated (supply-side == fees, keeper query deleted).
