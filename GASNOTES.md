# Gas experiment: deposit-triggered auto-compound (branch-only notes)

Prototype: `AUTO_COMPOUND_MIN_USDC = 100e6`; `deposit()` checks `compoundClaimable()` and runs
`try this.autoCompound(msg.sender) {} catch {}` (self-only entrypoint, no `nonReentrant`) before
the retained-balance snapshot. Measured with `test/gas.autocompound.test.js` on the local
PoolManager fixture (hardhat, solc 0.8.26 viaIR, cancun).

| Scenario | Baseline (main) | Prototype | Δ |
|---|---|---|---|
| Quiet direct deposit (no fees pending) | 221,489 | 238,787 | **+17,298** standing view-check tax |
| Direct deposit, ~$131 claimable | 315,428 (fees stay pending) | 497,918 (compound fires) | +182,490 on the triggering deposit |
| Standalone `compound()` (keeper) | 418,028 | 418,127 | ~0 |
| Keeper path total (compound tx + deposit tx) | 639,566 | — | prototype single-tx is **−141,648 (−22%)** |
| Quiet zapDeposit | 382,816 | 396,657 | +13,841 |
| zapDeposit, ~$131 claimable | 426,099 | 592,735 (compound fires) | +166,636 |

Correctness observations (prototype run):
- `Compound` event fires inside deposit; claimable drops $131 → ~$0.50; ΔL includes reinvested fees.
- Finder rebate works: direct depositor received $1.00 USDC (1% of harvest); via ZapHelper the
  rebate is swept to the end user (helper residue == 0).
- Full suite: **58/59 pass.** Sole failure: `vault.edge.test.js` "a direct token donation cannot
  inflate share price or zero out the next depositor" — auto-compound reinvests a ≥$100 donation
  at the next deposit, so exact ΔL-share issuance changes (depositor still enters at fair NAV;
  `minShares` + MINIMUM_LIQUIDITY still make inflation griefing unprofitable; same end-state is
  reachable on main via permissionless `compound()`). The pinned donation-inertness property and
  the first-deposit inflation analysis would need re-derivation + re-audit if this ships.
