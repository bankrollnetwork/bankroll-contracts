# vltUSDC Vault - Independent Codex Security Review

| Field | Details |
|---|---|
| Project | vltUSDC Uniswap V4 full-range LP vault |
| Scope | `contracts/VltUsdcVault.sol`, `contracts/ZapHelper.sol`, relevant tests and docs |
| Reviewer | Codex |
| Original review date | July 10, 2026 |
| Current-source update | July 14, 2026 |
| Context | Second-opinion review updated for the current keeperless, deposit-triggered auto-compound contract. All source citations below use current GitHub-style line anchors. |

## Executive Summary

The current vault is a compact, ownerless, single-position Uniswap V4 LP vault. The external write surface is `deposit()` and `redeem()`; there is no public `compound()` entrypoint and no keeper bounty. Instead, `deposit()` triggers the internal compound leg once `compoundClaimable().valueUsdc` reaches `AUTO_COMPOUND_MIN_USDC`, then prices the depositor after that fold-in.

With the project economics made explicit, I consider this a clean audit: no Critical, High, Medium, or Low findings. The remaining notes are informational design assumptions/tradeoffs to document and monitor.

## Findings Summary

| ID | Severity | Finding |
|---|---:|---|
| I-01 | Informational | Pending/retained fee timing is an accepted long-term-holder tradeoff, narrowed by deposit-triggered auto-compound |
| I-02 | Informational | Retained balances can be deployed at live spot during the internal compound leg, but manipulation should be uneconomic under normal flow |
| I-03 | Informational | Ownerless design leaves no operational response path for upstream emergencies |
| I-04 | Informational | Permit2 residual allowance cleanup is not recommended while ZapHelper remains a transient proxy |

## Validation Performed

- Reviewed the current `VltUsdcVault.sol` and `ZapHelper.sol` line by line.
- Reviewed the existing `AUDIT.MD` as a cross-check.
- Re-anchored this report's source locations to the current July 14 contract layout.
- Prior dynamic review included Hardhat tests, Slither, linting, and temporary economic probes; those probes were removed before this report was saved.

## I-01: Pending/retained fee timing is an accepted long-term-holder tradeoff, narrowed by deposit-triggered auto-compound

**Severity:** Informational

**Current locations:**

- [contracts/VltUsdcVault.sol:384-398](contracts/VltUsdcVault.sol#L384-L398) - `deposit()` checks `compoundClaimable()` and runs `_compound()` before measuring this depositor's liquidity when the threshold is met.
- [contracts/VltUsdcVault.sol:400-443](contracts/VltUsdcVault.sol#L400-L443) - `deposit()` snapshots retained balances, pulls the depositor's tokens, adds only the depositor contribution, and mints shares from actual added liquidity.
- [contracts/VltUsdcVault.sol:615-667](contracts/VltUsdcVault.sol#L615-L667) - `_onDeposit()` harvests pending V4 fees into retained vault balances, then adds only the depositor contribution.
- [contracts/VltUsdcVault.sol:460-489](contracts/VltUsdcVault.sol#L460-L489) - `redeem()` removes pro-rata position liquidity only.
- [contracts/VltUsdcVault.sol:673-711](contracts/VltUsdcVault.sol#L673-L711) - `_onRedeem()` subtracts accrued fees from the redeemer payout and retains them for remaining holders.

### Description

Shares are priced in Uniswap V4 position liquidity (`L`), not by valuing loose token balances. That is intentional: it keeps deposit/redeem cheap, avoids live spot valuation in share minting, and preserves the direct-donation defense.

The current contract narrows the old entrant-side timing issue by running `_compound()` before the deposit's retain snapshot and `liqBefore` measurement once claimable value reaches `AUTO_COMPOUND_MIN_USDC`. Below that threshold, pending/retained value can still be locally redistributed between short-term entrants, leavers, and continuing holders, but that is the accepted gas/economic compromise. Redeemers still forfeit pending fees to remaining holders when exiting before a fold-in; this is consistent with the long-term-holder policy.

### Impact

Small, local redistribution of uncompounded fee value around deposits and redemptions. The contract is optimized for long-term holders and threshold-triggered compounding, not exact per-block fee entitlement.

### Recommendation

Keep the design if this is the intended policy, but document it directly:

- `deposit()` and `redeem()` are intentionally cheap and do not crystallize every sub-threshold fee amount for the caller.
- Deposits at or above the auto-compound threshold fold claimable value into `L` before the new shares are priced.
- Short-term users may miss or receive small local fee amounts around threshold timing.

## I-02: Retained balances can be deployed at live spot during the internal compound leg, but manipulation should be uneconomic under normal flow

**Severity:** Informational

**Current locations:**

- [contracts/VltUsdcVault.sol:281-316](contracts/VltUsdcVault.sol#L281-L316) - `compoundClaimable()` values retained balances plus pending fees at live pool spot.
- [contracts/VltUsdcVault.sol:384-398](contracts/VltUsdcVault.sol#L384-L398) - `deposit()` triggers `_compound()` once claimable value reaches `AUTO_COMPOUND_MIN_USDC` and the position exists.
- [contracts/VltUsdcVault.sol:496-516](contracts/VltUsdcVault.sol#L496-L516) - `_compound()` is internal only and runs through the V4 unlock path.
- [contracts/VltUsdcVault.sol:717-758](contracts/VltUsdcVault.sol#L717-L758) - `_onCompound()` harvests fees, rebalances, then reinvests the full vault balance with no shares minted and no fee paid out.
- [contracts/VltUsdcVault.sol:769-807](contracts/VltUsdcVault.sol#L769-L807) - `_addLiquidity()` reads current `slot0` and mints liquidity from desired token amounts.
- [contracts/VltUsdcVault.sol:816-858](contracts/VltUsdcVault.sol#L816-L858) - `_rebalance()` caps only the internal swap input to a multiple of freshly harvested fees.

### Description

The rebalance cap limits the swap leg, not the later add-liquidity leg. After `_rebalance()`, `_onCompound()` passes the vault's full token balance into `_addLiquidity()`, and `_addLiquidity()` computes liquidity at the current pool price.

This means retained/off-position balances waiting for the next internal compound can be deployed at live spot. Under the accepted model, that is not a practical vulnerability because the affected amount should be marginal compared with principal: once it is worth folding in, deposit flow triggers the compound leg. Manipulating the local 1% pool also requires paying pool fees on the price push and likely on the restore, with a large portion accruing to the vault when it is the dominant LP.

### Impact

The theoretical at-risk notional is the loose retained balance passed to `_addLiquidity()`, not already-deployed vault principal. In normal operation this should be small and uneconomic to manipulate.

The assumption should be revisited if retained balances can become large through prolonged no-deposit periods, direct token transfers, unusual fee conditions, or any future change that increases off-position balances.

### Recommendation

No mandatory code change if the current economic model is accepted. Recommended documentation and monitoring:

- document that spot-price exposure applies only to retained/off-position amounts waiting for the next deposit-triggered compound;
- monitor `compoundClaimable().valueUsdc` and the age of retained balances;
- re-evaluate if retained balances regularly exceed a small fraction of position principal.

## I-03: Ownerless design leaves no operational response path for upstream emergencies

**Severity:** Informational

**Current locations:**

- [contracts/VltUsdcVault.sol:70-72](contracts/VltUsdcVault.sol#L70-L72) - ownerless/immutable design statement.
- [contracts/VltUsdcVault.sol:229-259](contracts/VltUsdcVault.sol#L229-L259) - constructor fixes pool identity, requires no hooks, and labels USDC/VLT.
- [contracts/VltUsdcVault.sol:355-443](contracts/VltUsdcVault.sol#L355-L443) - `deposit()` is permissionless and includes the internal compound trigger.
- [contracts/VltUsdcVault.sol:460-489](contracts/VltUsdcVault.sol#L460-L489) - `redeem()` remains permissionless and in-kind.
- [contracts/VltUsdcVault.sol:496-516](contracts/VltUsdcVault.sol#L496-L516) - compounding is internal only; there is no admin or keeper function.

### Description

The ownerless design is a deliberate strength: no admin can pause, sweep, upgrade, redirect fees, or change parameters. The tradeoff is that there is also no operational response if an upstream dependency behaves unexpectedly.

The main residual assumptions are:

- USDC remains non-fee-on-transfer and operational for the vault address;
- the USDC blacklist does not include the vault address;
- the canonical V4 PoolManager and no-hook pool remain the intended execution venue;
- no migration path is needed if the VLT/USDC market moves elsewhere;
- deposit and the internal compound leg intentionally share fate at the threshold, while `redeem()` remains the open exit path.

### Recommendation

Accept if ownerlessness is the intended trust model. Document the shared-fate behavior for threshold-crossing deposits and keep user-facing risk docs clear that there is no emergency lever.

## I-04: Permit2 residual allowance cleanup is not recommended while ZapHelper remains a transient proxy

**Severity:** Informational

**Current locations:**

- [contracts/ZapHelper.sol:96-131](contracts/ZapHelper.sol#L96-L131) - `zapDeposit()` pulls USDC, routes through the router, deposits into the vault, and sweeps leftover VLT/USDC to the caller.
- [contracts/ZapHelper.sol:134-149](contracts/ZapHelper.sol#L134-L149) - raw `zap()` forwards output and refunds unspent input to the caller.
- [contracts/ZapHelper.sol:154-186](contracts/ZapHelper.sol#L154-L186) - `_execRoute()` sets either direct router approval or Permit2 approval, executes the router call, checks measured output, and clears only the direct router approval path.
- [contracts/ZapHelper.sol:189-193](contracts/ZapHelper.sol#L189-L193) - `_sweep()` forwards the helper's full token balance.

### Description

In the Permit2 route path, the helper approves Permit2 and gives the router a short-lived Permit2 allowance. If the router under-consumes the approved amount, some allowance may remain until expiry. Under this architecture, that is normal route plumbing rather than a security finding.

`ZapHelper` is a functional proxy, not a vault. Its security invariant is that it should not custody tokens after a call. `zapDeposit()` sends swap output and remaining USDC into the vault, the vault refunds unused LP dust back to the helper as payer, and the helper sweeps remaining VLT/USDC back to the original caller. The residual allowance is only meaningful if the helper also has a token balance to spend; cleaning it after every successful route adds gas on the hot path while not improving the main invariant.

### Recommendation

Do not add approval cleanup solely for accounting symmetry. Keep the focus on balance cleanup and user refunds. Revisit only if the helper later gains custody semantics, stores balances across calls, supports arbitrary token parking, or routes through a less constrained spender model.

## Final Assessment

The current contracts read cleanly under the stated economic model. Fee timing, retained-balance spot exposure, ownerless shared fate, and Permit2 allowance fluctuation are documented tradeoffs rather than required fixes. The practical follow-up is documentation and monitoring, not a mandatory accounting or approval-cleanup redesign.
