# vltUSDC Vault - Independent Codex Security Review

| Field | Details |
|---|---|
| Project | vltUSDC Uniswap V4 full-range LP vault |
| Scope | `contracts/VltUsdcVault.sol`, `contracts/ZapHelper.sol`, relevant tests and docs |
| Reviewer | Codex |
| Date | July 10, 2026 |
| Context | Second-opinion review of the current workspace. `AUDIT.MD` was read after the independent code pass and used as a cross-check. |

> **Project addendum (July 14, 2026 — added by the project, not by Codex; Codex's text below
> is unmodified).** This review examined the pre-redesign code, whose compounding model was a
> permissionless keeper `compound()` with a 1% finder fee. That model no longer exists: the
> July 14 keeperless redesign (see `AUDIT.MD` §7d) removed the compound entrypoint and the
> fee entirely — the external write surface is now `deposit` + `redeem`, and a deposit at
> ≥$100 claimable runs the internal compound leg (100% reinvests) before its shares are
> priced. Where this review says "keeper cadence," read "deposit-triggered cadence at the
> $100 threshold." Per-finding mapping notes are inlined below; the findings' code-path
> analysis (especially I-02) largely carries over.

## Executive Summary

The core contracts are compact, ownerless, and well tested. The basic V4 settlement paths, first-depositor lock, direct-donation handling, deadline checks, token-named events, and periphery refund routing are all materially better than a typical early vault implementation.

After discussing the intended keeper model, I agree that the pending-fee timing behavior is better treated as an explicit long-term-holder tradeoff than as a solvency bug: short-term entrants and leavers may miss or capture small local fee amounts so every deposit/redeem does not pay compound-level gas. That should be documented clearly, but it does not need to violate the intended economic model.

One implementation nuance is still worth documenting: the compound rebalance cap only limits the internal swap; the later add-liquidity step can still deploy retained balances at the current same-block spot price. After considering the intended keeper cadence and 1% local-pool fee economics, I treat this as an accepted economic assumption rather than a pre-mainnet defect, provided retained balances remain small.

## Findings Summary

| ID | Severity | Finding |
|---|---:|---|
| I-01 | Informational | Pending/retained fee timing is an accepted long-term-holder tradeoff, but should be documented explicitly |
| I-02 | Informational | Retained balances can be deployed at live spot during `compound()`, but manipulation should be uneconomic under keeper cadence |
| I-03 | Informational | Ownerless design leaves no operational response path for USDC or PoolManager emergencies |
| I-04 | Informational | Permit2 residual allowance cleanup is not recommended if ZapHelper remains a transient proxy |

## Validation Performed

- Reviewed `VltUsdcVault.sol` and `ZapHelper.sol` line by line.
- Reviewed the tests and the existing `AUDIT.MD` as a cross-check after the initial pass.
- Ran the full Hardhat suite: 54 passing, 2 pending fork tests.
- Ran Slither from the local virtual environment: 75 contracts, 96 detectors, 0 results.
- Ran the Solidity lint task during the review; it completed cleanly, with only an npm registry update-check DNS warning.
- Built and ran temporary proof probes for I-01 and I-02, then removed them before writing this report.

## I-01: Pending/retained fee timing is an accepted long-term-holder tradeoff, but should be documented explicitly

**Severity:** Informational

**Location:**

- `contracts/VltUsdcVault.sol:392-429` - deposit snapshots retained balances and mints shares only against added liquidity.
- `contracts/VltUsdcVault.sol:614-659` - `_onDeposit` harvests pending fees into retained vault balances before adding only the depositor contribution.
- `contracts/VltUsdcVault.sol:466-480` - redeem removes pro-rata position liquidity only.
- `contracts/VltUsdcVault.sol:680-704` - `_onRedeem` subtracts all accrued fees from the redeemer payout and retains them at the vault.
- `contracts/VltUsdcVault.sol:762-774` - compound reinvests retained balances with no new shares minted.

### Description

Shares are priced only in Uniswap V4 position liquidity (`L`). They do not account for:

- pending fees still inside the V4 position,
- fees harvested by `deposit()` or `redeem()` into the vault's loose balances,
- prior compound dust or direct retained token balances.

On deposit, the contract records `liqBefore = positionLiquidity()` before the unlock and mints:

```solidity
shares = (supply * liquidityAdded) / liqBefore;
```

That is intentional. It keeps deposit/redeem cheap and avoids making every stakeholder pay for a full compound. Fees are folded in when a keeper-run `compound()` is economically worthwhile. Under that model, long-term holders receive the compounded value over time, while short-term or small local fee movements are smoothed across the holder set.

The tradeoff is that a depositor who enters shortly before a compound can receive a pro-rata share of fees earned before entry, and a redeemer who exits before a compound can forfeit their pro-rata share of pending fees to remaining holders. Given the stated design goal, this is acceptable if the magnitude is kept small by keeper cadence and user-facing docs describe the behavior.

### Evidence

A temporary local probe generated fees, then had a second depositor enter before compounding. The depositor's pro-rata liquidity claim increased after compounding fees earned before their deposit:

```text
preDepositFeesValueUsdc: 951.409426 USDC
bobClaimBeforeCompound: 15058169708323903 L
bobClaimAfterCompound:  15073632206567799 L
capturedLiquidity:        15462498243896 L
```

This confirms the timing effect. It does not by itself show a broken solvency invariant or a principal-loss bug.

### Impact

Small, local redistribution of uncompounded fee value between short-term entrants, leavers, and continuing holders. Long-term holders are expected to receive the value when keepers fold profitable fees into the position.

### Recommendation

Keep the design if this is the intended policy, but document it directly:

- `deposit()` and `redeem()` are intentionally cheap and do not crystallize pending fees for the caller.
- Short-term users may miss or receive small local fee amounts around keeper compounds.
- The vault is optimized for long-term holders and keeper-driven compounding, not exact per-block fee entitlement.

Also consider adding monitoring around `compoundClaimable().valueUsdc` so the "small local profits" assumption stays true in production.

> **Project note (July 14, 2026 — §7d):** the redesign directly narrows this finding's
> deposit side: a deposit at ≥$100 claimable now crystallizes pending/retained value into L
> *before* its shares are priced, so the entrant-side timing window is bounded by the $100
> trigger rather than by keeper cadence. The redeem-side forfeit (leaver's pending fees stay
> with remaining holders) is unchanged and remains the documented long-term-holder policy.
> The recommended documentation now lives in the contract header, README, and `AUDIT.MD`
> §7d/I-10.

## I-02: Retained balances can be deployed at live spot during `compound()`, but manipulation should be uneconomic under keeper cadence

**Severity:** Informational

**Location:**

- `contracts/VltUsdcVault.sol:316-323` - `compoundClaimable()` values claimable assets at live spot.
- `contracts/VltUsdcVault.sol:751-774` - `_onCompound()` rebalances, then reinvests the full vault balance minus finder fees.
- `contracts/VltUsdcVault.sol:806-809` - `_addLiquidity()` reads the current slot0 price for liquidity math.
- `contracts/VltUsdcVault.sol:868-874` - `_rebalance()` caps only the internal swap input.

### Description

The current comments and the existing audit focus on the `REBALANCE_CAP_MULT` cap. That cap limits the notional of the internal swap inside `_rebalance()`. It does not limit the amount of retained balance later passed into `_addLiquidity()`.

After `_rebalance()` returns, `_onCompound()` does this:

```solidity
uint256 bal0 = _selfBalance(currency0);
uint256 bal1 = _selfBalance(currency1);
uint256 reinvest0 = bal0 > finder0 ? bal0 - finder0 : 0;
uint256 reinvest1 = bal1 > finder1 ? bal1 - finder1 : 0;
(uint128 liquidityAdded,,) = _addLiquidity(reinvest0, reinvest1);
```

`_addLiquidity()` then uses the current pool `sqrtPriceX96`. If an attacker first pushes the pool price, the vault mints liquidity at that skewed price. When the attacker restores the price, value can be arbitraged out of the liquidity that was just added.

This still happens when the rebalance swap cap is zero. For example, if there are retained balances but no fresh fees, `_rebalance()` returns without swapping, then `_addLiquidity()` can still deploy the retained balances at the live spot.

The key economic bound is that this affects only the retained/off-position amount being compounded, not the already-deployed principal. Under the intended keeper model, that amount should be marginal: once compounding is profitable, keepers fold it in. Manipulating the local 1% pool also requires paying pool fees on the price push and likely on the restore, with a large portion of those fees accruing to the vault if it is the dominant LP. That makes attacking dust or small retained balances economically unattractive.

### Evidence

A temporary local stress probe funded the vault with an intentionally oversized retained balance, pushed the spot price, called `compound()`, then reversed the price-moving swap. With no fresh fees, the rebalance cap did not apply to the add-liquidity leg:

```text
looseUsdcConsumed: 500000.000000 USDC
looseVltConsumed:  9828.047728790172353011 VLT
attackerUsdcDelta: 269524.886788 USDC
attackerVltDelta:  0 VLT
```

The exact numbers depend on pool depth and retained balances, and the stress balance above is intentionally much larger than the normal keeper cadence should allow. The probe proves the code path, not expected profitability under production assumptions.

### Impact

The theoretical at-risk notional is the loose retained balance passed to `_addLiquidity()`, not vault principal. In normal operation this should be small and unprofitable to manipulate because local-pool price movement pays the 1% pool fee while keepers prevent retained fees from growing once profitable.

This assumption should be revisited if retained balances can become large through delayed keeper activity, direct token transfers, unusual fee conditions, or any future change that increases off-position balances.

### Recommendation

No mandatory code change if the keeper/gas model is accepted. Recommended documentation and monitoring:

- document that spot-price risk applies only to retained/off-position amounts waiting for the next keeper compound;
- monitor retained balances and keeper cadence in production;
- re-evaluate if retained balances regularly exceed a small fraction of position principal;
- optionally cap total retained value deployed per compound if future operations show keeper liveness is weaker than expected.

> **Project note (July 14, 2026 — §7d): this finding CARRIES OVER to the keeperless design**
> — the compound leg still deploys the full retained balance via `_addLiquidity()` at live
> spot after the fee-scaled swap cap, and an attacker can now self-trigger it with a small
> deposit (previously by calling `compound()`). What changes is the liveness assumption that
> bounds the at-risk notional: retained balances are folded in by deposit flow at the $100
> trigger instead of by keeper economics, so under healthy flow the loose balance stays
> trigger-scale; in a prolonged no-deposit market it can accumulate exactly as this finding
> warns. The monitoring recommendation stands (the client's Stats panel now surfaces
> `compoundClaimable().valueUsdc` and the trigger for this reason), and Codex's economic
> bound (push + restore pay the 1% pool fee largely to the vault itself) is unchanged.

## I-03: Ownerless design leaves no operational response path for USDC or PoolManager emergencies

**Severity:** Informational

The ownerless design is a deliberate strength: no admin can pause, sweep, upgrade, or change fees. The tradeoff is that there is also no operational response if an upstream dependency behaves unexpectedly.

The main residual assumptions are:

- USDC remains non-fee-on-transfer and operational for the vault address;
- the USDC blacklist does not include the vault address;
- the canonical V4 PoolManager and no-hook pool remain the intended execution venue;
- no migration path is needed if the VLT/USDC market moves elsewhere.

This is acceptable if documented clearly. The code should not gain an admin key casually, but users should understand that "ownerless" also means "no emergency lever."

> **Project note (July 14, 2026 — §7d):** still true, and sharpened by the redesign's
> shared-fate choice: deposit and the compound leg revert together (no try/catch), so a
> latent compound-leg revert would block threshold-crossing deposits with no lever (redeem
> is unaffected; exit stays open). Accepted and flagged as the §7d audit-focus item; the
> related pre-seed-donation brick (M-01) was found and fixed with the `positionLiquidity()`
> trigger gate.

## I-04: Permit2 residual allowance cleanup is not recommended if ZapHelper remains a transient proxy

**Severity:** Informational

**Location:** `contracts/ZapHelper.sol:158-186`

In the Permit2 route path, the helper approves Permit2 and gives the router a short-lived Permit2 allowance. If the router under-consumes the approved amount, some allowance may remain until expiry. Earlier in this review I treated that as a Low hygiene issue, but under the current architecture it is better understood as normal route plumbing.

`ZapHelper` is a functional proxy, not a vault. Its security invariant is that it should not custody tokens after a call. `zapDeposit()` sends swap output and remaining USDC into the vault, the vault refunds unused LP dust back to the helper as payer, and the helper sweeps remaining VLT/USDC back to the original caller. The residual allowance is only relevant if the helper also has a token balance to spend; cleaning it after every successful route adds gas on the hot path while not improving the main invariant.

Recommendation: do not add approval cleanup solely for accounting symmetry. Keep the focus on balance cleanup and user refunds. Revisit only if the helper later gains custody semantics, stores balances across calls, supports arbitrary token parking, or routes through a less constrained spender model.

## Notes On Existing `AUDIT.MD`

I agree with much of the architectural review in `AUDIT.MD`, especially the V4 fee-folding analysis and the direct-donation defense. My main disagreements are:

- I now agree with treating the joining-depositor fee timing as informational if the intended fairness model is explicitly long-term-holder oriented and keeper-driven, not exact per-block fee entitlement.
- I agree that retained-balance spot manipulation should be uneconomic under the intended keeper cadence and 1% pool-fee economics, but the exact assumption should be documented because the cap itself applies only to `_rebalance()`'s swap input, not `_addLiquidity()`'s subsequent mint.

## Recommended Fix Order

1. Document I-01 in user-facing docs as the intended keeper/gas tradeoff for long-term holders.
2. Document I-02 as an assumption: retained balances should remain marginal because keepers fold them in when profitable and local-pool manipulation pays 1% fees.
3. Monitor retained balances and keeper cadence in production.
4. Document I-04 as the accepted ZapHelper transient-proxy allowance model.
5. Re-run Hardhat tests, Slither, and the fork tests on the final pre-deploy commit.

> **Project note (July 14, 2026):** items 1–3 are re-scoped by the keeperless redesign —
> I-01/I-02 documentation now lives in the contract header, README, and `AUDIT.MD` §7d, and
> "keeper cadence" monitoring becomes claimable-value monitoring (surfaced in the test
> client's Stats panel). Item 5 was re-run July 14 on the keeperless code: 61 tests passing,
> Slither 0 results, Solhint clean.

## Final Assessment

The implementation is close. I would accept fee-timing, retained-balance spot exposure, and Permit2 allowance fluctuation as documented tradeoffs under the intended model. The main audit recommendation is therefore documentation plus monitoring, not a mandatory accounting or approval-cleanup redesign.
