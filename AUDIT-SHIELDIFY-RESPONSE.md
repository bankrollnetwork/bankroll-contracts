# Shieldify Security Review — Response Plan (RECONCILED — FINAL REPORT IN)

Review commit: `4dae465` · Draft report 2026-07-17 (1 Medium / 3 Low / 8 Info) ·
**Final report 2026-07-19: 11 Informational, 0 Medium/Low** · Fixes reviewed at `ce44c31`

## Final report reconciliation (2026-07-19)

Every ask below was accepted in the final report:

- **M-01 severity dispute accepted** — downgraded past Low straight to Informational
  (new **I-01**, Acknowledged: the bounded-socialization design model).
- **Old I-02 withdrawn** — the gas-taxed-no-op finding premised on `REBALANCE_CAP_MULT`
  (removed pre-review) is gone; the report now has 11 findings, not 12.
- **L-03 re-anchored and downgraded** — new **I-04** (Info, Acknowledged) quotes the capless
  `_rebalance(r0, r1)` with our re-anchored line numbers. Its substance is CLOSED on our side:
  the binding no-`PoolManager.donate()` routing constraint plus the sanctioned
  `vault.donate()`/`zapDonate` path (added post-fixes-review at `6a938e3`/`2006f11`) mean the
  donation-created fee state cannot arise from protocol operations.
- **All eight accepted fixes verified FIXED** at fixes hash `ce44c31`.

Old → new ID map (final statuses):

| Draft ID | Final ID | Status | Notes |
|---|---|---|---|
| M-01 | I-01 | Acknowledged | design model; dispute accepted |
| L-01 | I-02 | Fixed | `require(shares > 0)` |
| L-02 | I-03 | Acknowledged | socialization / exit purity |
| L-03 | I-04 | Acknowledged | substance closed by `donate()` + routing constraint |
| I-01 | I-05 | Fixed | feeApr NatSpec |
| I-02 | — | **Withdrawn** | premised on removed code |
| I-03 | I-06 | Fixed | ZapHelper ReentrancyGuard |
| I-04 | I-07 | Fixed | `zap()` deadline |
| I-05 | I-08 | Fixed | previewRedeem (clamp variant) |
| I-06 | I-09 | Fixed | immutable positionKey |
| I-07 | I-10 | Fixed | self-recipient guard |
| I-08 | I-11 | Fixed | constructor asserts |

**Still open on the audit track:** the five post-review entrypoints (`donate`, `zapDonate`,
ERC20Permit surface, `previewDeposit`, `zapRedeem`/`WithPermit` — Addenda 1–2 below) postdate
the fixes hash and need their own review pass before mainnet. The delivered PDF is kept
locally (gitignored), not committed.

---

Historical draft below (superseded by the reconciliation above).

This document is the working plan for the fix round: per-finding verdicts checked against the
actual source at the review hash, paste-ready Team Responses, the fix batch, and the corrections
Shieldify needs before the report is finalized.

## Verdict summary

| ID | Verdict | Action |
|---|---|---|
| M-01 | Design-intent; **severity disputed** (capture bounded < $100 by construction) | Acknowledge + dispute to Low + docs |
| L-01 | **Valid** | Fix: `require(shares > 0)` |
| L-02 | Design-intent (documented socialization; exit-path purity) | Acknowledge + docs |
| L-03 | Substance valid only in donation states; **cap analysis cites removed code** | Acknowledge w/ correction + operational constraint |
| I-01 | Valid doc nit | Fix NatSpec (+ client label) |
| I-02 | **Not applicable — premised entirely on code removed before the review commit** | Dispute (stale code) |
| I-03 | Valid hardening | Fix: ReentrancyGuard on ZapHelper |
| I-04 | Valid | Fix: `zap()` deadline (ABI change; 2 client call sites) |
| I-05 | Valid (view-only) | Fix: clamp `shares` in previewRedeem (never reverts) |
| I-06 | Valid gas nit | Fix: immutable positionKey |
| I-07 | Valid footgun | Fix: `require(recipient != address(this))` |
| I-08 | Partially valid | Fix: cheap constructor asserts |

## The design model (send as preamble to all Team Responses)

Several findings (M-01, L-02, and the framing of I-01) describe the same deliberate design fact
from different angles, so we state the model once:

> **Value outside `L` is a common pool that folds forward at the next compound.** Shares enter
> and exit priced on position liquidity only. Compounding is lazy by design: it fires inside
> `deposit()` once claimable value reaches $100 (`AUTO_COMPOUND_MIN_USDC`), and **it runs before
> the depositor's shares are priced** — so no entrant can ever buy into more than <$100 of
> uncompounded common-pool value, and no exit can forfeit more than the holder's pro-rata slice
> of that same bounded pool (an exiting holder can first fold it in themselves with a dust
> deposit whenever the gate is open). Transfers of fee *timing* between participants are
> accepted, bounded (< $100 per event), bidirectional, and socialized across all holders.
>
> The alternative — pricing shares against the full inventory (L + pending fees + retained
> balances) — requires valuing VLT and USDC amounts in a common unit **at spot** inside every
> permissionless deposit and redeem. That reintroduces exactly the manipulation surface this
> report's own L-03 demonstrates is dangerous. The design deliberately chooses a ≤$100 bounded,
> symmetric socialization error over an unbounded spot-valuation attack surface. The 1% fee
> tier is part of the same economics: it prices manipulation (2% round trip on every attack
> leg) and captures profit that is distributed to all holders, realizable only via the
> in-kind, zero-price-impact `redeem()`.

## Per-finding

### M-01 — New depositors capture pre-entry fees (Medium)

**Verdict: design-intent; dispute severity to Low.** The report's own impact section concedes
the pending-fee capture "is bounded by the $100 auto-compound threshold." What the analysis
underweights is that the bound is **structural, not incidental**: `deposit()` checks the gate
and runs `_compound()` *before* the retain snapshot and *before* minting
(`VltUsdcVault.sol:412-413` → mint at `:457`), so any claimable ≥ $100 is folded into `L` for
existing holders first, at every entry. The gate is live whenever holders exist
(`supply > 0` ⇒ dead-share liquidity ⇒ `positionLiquidity() > 0`). Maximum capture per event is
therefore strictly `< $100 × attacker share fraction` plus compound-residue dust; the PoC needed
$1M of capital to capture ~$45, before mainnet gas on two large transactions and LP price
exposure during the wait. Enlarging the residue via price manipulation costs more in 1% pool
fees than the bounded capture. It is also symmetric — the deposit-side gain is the mirror of the
L-02 exit-side forfeit — so the expected transfer across the holder population is ~zero. By the
report's own matrix (limited, bearable, griefing-scale) this is Low impact / Low likelihood.

**Draft Team Response:** Acknowledged as designed; severity disputed. The capture is bounded
below the $100 trigger by construction — `deposit()` compounds before minting whenever
claimable ≥ $100, so the exploitable window never contains ≥$100 of common-pool value. See the
design-model preamble: we accept a bounded, bidirectional socialization of fee timing in
exchange for keeping spot-price valuation out of the permissionless paths (per your L-03).
No code change. We will document the bound explicitly in the vault NatSpec and README.

### L-01 — Zero-share deposits (Low)

**Verdict: valid.** Confirmed at `VltUsdcVault.sol:448-457`: the initialized branch floors and
only `minShares` protects. UniswapV2 precedent applies.

**Draft Team Response:** Fixed. `require(shares > 0, "zero-shares-minted")` added after both
share branches, with a regression test mirroring the PoC.

### L-02 — Redeemers forfeit pending fees (Low)

**Verdict: design-intent.** Documented in `previewRedeem` NatSpec and AUDIT.MD §7d (shared
fate / socialization). Two additional deliberate properties the report doesn't weigh:

- **Exit-path purity is a safety property.** `redeem()` never swaps and never depends on a
  compound succeeding — exit works even when the pool state would make a compound revert or be
  unfavorable. Folding `_compound()` into `redeem()` (the report's first suggestion) would make
  exits carry the same permissionless-swap exposure the report criticizes in L-03, and gas-tax
  every exit.
- **The forfeiture is holder-timed and bounded.** Whenever claimable ≥ $100 the holder can
  trigger the fold with a dust deposit before exiting (the report concedes this); below $100
  the forfeit is < the holder's pro-rata slice of $100.

**Draft Team Response:** Acknowledged as designed (see design-model preamble). Redemption is
kept swap-free and dependency-free on purpose — exit must never inherit the compound's market
exposure. Pro-rata fee payout on redeem would add a fee-collect to every exit and reintroduce
per-exit dust accounting for < $100 of bounded, holder-avoidable value. No code change;
documented in NatSpec/README.

### L-03 — Donation-inflated compound sandwich (Low)

**Verdict: substance valid for donation-decoupled states only; the cap analysis must be
re-anchored.** Two parts:

1. **Correction (factual):** the section "Fresh-fee cap does not prevent the attack" and the
   quoted `_rebalance(uint256 r0, uint256 r1, uint256 fee0, uint256 fee1)` with
   `REBALANCE_CAP_MULT` do not exist at the review commit. The cap was removed in `435d940`
   (five commits before `4dae465`); at the review hash `_rebalance(r0, r1)` swaps half the
   value-imbalance of the loose balances bounded by the ±5% `sqrtPriceLimitX96`. The PoC
   numbers likely still hold (in donation states the old cap never bound: 4× a $100k donation
   is far above imbalance/2), but the report text analyzes a superseded revision and I-02
   (below) inherits this entirely.
2. **Substance:** we accept the finding's own boundary: ordinary fee volume was shown *not*
   profitably sandwichable (their controls: a $500k-swap fee state lost the attacker $1,852;
   one-way volume to $25M never went positive). Profit requires an unrelated party first making
   a ≥$10–25k *one-sided* `PoolManager.donate()` to the pool. The vault never donates; no
   in-scope component donates; hooks are banned by design so an on-chain TWAP is not available,
   and every oracle-free "minOut" is circular against spot (the report agrees). The mitigation
   that fits the design is **operational**: ecosystem fee routing (out of scope, not yet built)
   will be specified to never make large one-sided donations — value-balanced donation pairs
   restore the trades-against-manipulation property of the imbalance-direction logic, and/or
   tranches below the demonstrated profitability floor. The report's Option 1 (add only the
   balanced portion, retain one-sided excess) is rejected: in a trending market fees accrue
   one-sided indefinitely, so holder value would idle unboundedly — that trade-off is exactly
   why the cap was removed.

**Draft Team Response:** Acknowledged for donation-created states, with a correction: the
REBALANCE_CAP_MULT passage analyzes code removed in `435d940`, before the review commit —
please re-anchor the finding to the `_rebalance(r0, r1)` implementation at `4dae465` and
re-run the PoC against it. Design position: **we confirm `PoolManager.donate()` is not and
will not be part of protocol operations** — the vault performs no donations, no in-scope
component donates, and ecosystem fee routing will not use `donate()` (this is now a documented
binding constraint: any future routing mechanism must not make large one-sided donations to
the pool). Ordinary fee states were shown unprofitable by your own controls. Per the finding's
own severity condition, the issue remains Low under the confirmed deployment model.

### I-01 — feeApr provenance (Info)

**Verdict: valid documentation nit.** `VltUsdcVault.sol:560` does say "Reflects compounded fees
only" and the metric is provenance-blind L/share growth.

**Draft Team Response:** Fixed in documentation. NatSpec corrected to describe the metric as
L-per-share growth (includes donations, forfeiture concentration, and rounding dust; all accrue
to holders). ABI unchanged; the UI label is updated to "L/share growth APR".

### I-02 — Gas-taxed no-op compounds (Info)

**Verdict: not applicable at the review commit.** The finding is premised entirely on the
fresh-fee cap (`cap = 4 × 0 = 0 → no swap → no-op`). That code was removed in `435d940`. At
`4dae465`, a one-sided retained balance ≥ $100 *is* swapped (half the value-imbalance, 5%
price-limited) and reinvested — the trigger and the action share the same value base, which is
precisely why the cap was removed. The described no-op cannot occur.

**Draft Team Response:** Not applicable to the reviewed code — the finding analyzes
`REBALANCE_CAP_MULT`, removed in `435d940` (before the review commit `4dae465`). At the review
hash the rebalance sizes on the full loose balance, so a one-sided retained balance ≥ $100
compounds productively. Please verify against `4dae465` and withdraw or re-scope.

### I-03 — ZapHelper reentrancy guard (Info)

**Verdict: valid hardening**, consistent with our own rule (guards on external entrypoints).
`ZapHelper` holds live caller balances across an arbitrary `router.call` with full-balance
sweeps. **Fix:** inherit `ReentrancyGuard`, `nonReentrant` on `zap()` and `zapDeposit()`.

### I-04 — zap() deadline (Info)

**Verdict: valid.** `zapDeposit()` has one; `zap()` doesn't. **Fix:** add a `deadline` param and
check before pulling tokens. ABI change — update the two client call sites
(`vltUSDC.js:910` static preview, `:1371` send) and the vendored helper ABI.

### I-05 — previewRedeem out-of-range (Info)

**Verdict: valid, view-only.** `redeem()`'s downcast is provably safe (burn enforces
`shares ≤ supply`); the preview had no bound and could silently truncate. **Fix:** out-of-range
input is CLAMPED to the full-supply quote (`if (shares > supply) shares = supply`) rather than
reverting — a preview is a UI feed and must always return a workable number; the clamp keeps
the downcast in range, so the truncated-quote defect is gone. (We deliberately did not adopt
the report's `require` suggestion: quotes never revert.)

### I-06 — Position key recompute (Info)

**Verdict: valid gas nit.** All inputs immutable. **Fix:** compute once in the constructor,
store as `bytes32 immutable positionKey`.

### I-07 — recipient == vault locks shares (Info)

**Verdict: valid footgun.** Vault only rejects `address(0)`. **Fix:**
`require(recipient != address(this), "self-recipient")` in `deposit()` (covers the ZapHelper
path, which forwards recipient to the vault).

### I-08 — Constructor validation (Info)

**Verdict: partially valid.** Deploy scripts already validate, but the vault is immutable and
on-chain asserts are one-time-cheap. **Fix:** require pool initialized
(`getSlot0.sqrtPriceX96 != 0` — compatible with the 00→01 deploy order), `tickSpacing > 0`
(clear revert instead of a division panic), both currencies non-native, and — pending decision —
`fee == 10000` to lock the 1% economics on-chain. Skip pinning a canonical PoolManager address
(chain-dependent; that stays the deploy script's job).

## Fix plan

**Batch A — code (one sitting, then: 61-test suite, Slither 0, Solhint, fork sim):**
1. `require(shares > 0)` in deposit mint path (L-01) + regression test
2. ZapHelper `ReentrancyGuard` (I-03)
3. `zap()` deadline param (I-04) + client: two call sites + vendored ABI
4. previewRedeem bound (I-05)
5. `bytes32 immutable positionKey` (I-06)
6. `recipient != address(this)` (I-07)
7. Constructor asserts (I-08, incl. fee == 10000 if approved)
8. feeApr NatSpec + client "L/share growth" label (I-01)

**Batch B — docs:** design-model section in AUDIT.MD/README (M-01/L-02 bound, symmetry, exit
purity); fee-routing donation constraint (L-03); re-anchor audit citations after Batch A.

**Batch C — Shieldify comms:** send design-model preamble + per-finding Team Responses; request
correction/withdrawal of I-02 and re-anchor of L-03's cap section to `4dae465`; dispute M-01 →
Low; request the fixes-review round on the Batch A commit.

## Decisions (resolved 2026-07-17)

1. **Fee routing will NOT use `PoolManager.donate()`** — confirmed. L-03 stays Low per the
   finding's own severity condition; the no-large-one-sided-donations rule is documented as a
   binding constraint on any future routing mechanism.
2. **`fee == 10000` hardcoded in the constructor** — done (I-08 batch).
3. **M-01/L-02 accepted as design** — the severity dispute and docs language go out as drafted.

## Status

- Batch A (code hardening) implemented: L-01, I-03, I-04, I-05 (clamp, not revert), I-06, I-07, I-08, I-01 NatSpec.
  71 tests green (61 existing + 10 new in `test/audit.hardening.test.js`), Slither 0, Solhint
  clean. Gas re-measured (GASNOTES.md): vault paths −0.5k, zap paths +1.6–3.8k.
- Client updated for the `zap(deadline)` ABI change and the APR label.
- Remaining: send Batch C responses to Shieldify; request I-02 withdrawal and L-03 re-anchor;
  fixes-review round on the hardening commit.

## Addendum (2026-07-18): `donate()` — new scope for the fixes-review

The review surfaced that the vault had NO sanctioned way to push value to holders: raw
transfers sit in the capturable common pool (M-01 surface) and fold in through the rebalance
swap (L-03 surface), while `PoolManager.donate()` IS the L-03 vector. We added the missing
primitive at `7b00f25`:

    donate(uint256 vltAmount, uint256 usdcAmount, address donor, uint256 deadline)
        -> uint128 liquidityAdded
    ZapHelper.zapDonate(usdcAmount, swapUsdcToVlt, minVltOut, deadline, donor, swapData)
        -> uint128 liquidityAdded   // USDC-only gift via the whitelisted route

Deposit-minus-mint: pulls the pair from the caller, adds max balanced liquidity at the pool
price, refunds the short leg, mints no shares. Swap-free and oracle-free; reuses the deposit
unlock callback verbatim; `totalSupply() > 0` gate; same $100 fold-first trigger as deposit;
`Donate(sender, donor, vltUsed, usdcUsed, liquidityAdded)` event (payer vs attributed donor, mirroring Deposit) keeps the fee-accounting identity
exact. Documented JIT caveat (large one-shot donations are front-runnable pro-rata) with an
operational tranching rule and a pinned characterization test. 8 new tests (79 total), Slither
0, Solhint clean. **Please include `donate()` in the fixes-review scope.** This also upgrades
the L-03 posture: routing now has a first-class donation endpoint that cannot create the
donation-inflated pending-fee state.

## Addendum 2 (2026-07-19): LP-completeness batch — additional fixes-review scope

Reviewing the surface for other missing primitives after `donate()` surfaced three, all landed
at `2006f11`:

1. **`ERC20Permit` on the vltUSDC share token** (EIP-2612; name "Bankroll VLT-USDC LP",
   version "1"). Now-or-never on an immutable contract; enables gasless share approvals for
   periphery and integrators.
2. **`previewDeposit(vltAmount, usdcAmount) → (shares, vltUsed, usdcUsed)`** — the entry-side
   quote symmetric with `previewRedeem`. Pre-trigger state, `minShares` stays the binding
   protection, never reverts (mirrors the I-05 clamp philosophy).
3. **`ZapHelper.zapRedeem` / `zapRedeemWithPermit`** — USDC-only exit through the periphery:
   pull shares (permit variant needs no prior approval; tolerant try/catch permit), redeem
   in-kind to the helper, sell the whole VLT leg via the whitelisted route, deliver USDC under
   an AGGREGATE `minUsdcOut` bound. The vault's `redeem` remains swap-free — exit purity holds;
   the sell leg exists only in the replaceable periphery. In the vault's Redeem event a zapped
   exit shows owner = helper (≠ end receiver), mirroring the zapDeposit convention.

85 tests green (6 new), Slither 0, Solhint clean. **Please include all three in the
fixes-review scope** along with `donate()`/`zapDonate()`.
