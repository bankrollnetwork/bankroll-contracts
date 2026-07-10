# vltUSDC Vault — Security Audit

| | |
|---|---|
| **Project** | vltUSDC — auto-compounding Uniswap V4 VLT/USDC full-range LP vault |
| **Contracts in scope** | `contracts/VltUsdcVault.sol`, `contracts/ZapHelper.sol` |
| **Compiler** | solc 0.8.26, optimizer 200 runs, `viaIR`, `evmVersion: cancun` |
| **Performed by** | Claude (Fable 5) with Solidity Audit Skill |
| **Date** | July 8, 2026 |
| **Status of code** | Pre-deployment (not yet on mainnet); Hardhat workspace, 47 tests passing |

This audit covers source-code analysis, static analysis (Slither, re-run fresh for this
report), and review of the project's dynamic test suite (executed for this report). It is not
a substitute for the planned independent Shieldify review, formal verification, or an
economic simulation of keeper behavior. See **Disclaimer** at the end.

---

## 1. Prior audit context (VLT token)

Two prior reports cover the **VLT token itself** (`VaultToken`,
`0x6b785a0322126826d8226d77e173d75dafb84d11`) — the 18-decimal ERC-20 this vault pairs with
USDC. Neither covers the contracts in scope here; they matter because the vault's trust model
leans on VLT being a well-behaved token.

- **`src/media/VLT_Audit.pdf`** (Claude Opus 4.7 w/ Solidity Audit Skill, April 22, 2026):
  0 Critical / 0 High / 0 Medium / 3 Low / 8 Informational. All findings cosmetic or
  pre-deployment-only. Confirms: fixed 1.8M supply, no mint, no pause, no blocklist, no
  upgrade path, no fee-on-transfer, no rebasing, LP permanently locked at the token contract.
- **Shieldify Security — Bankroll Vault Token (VLT) Security Review** (June 1, 2026,
  [report](https://github.com/shieldify-security/audits-portfolio/blob/main/reports/Bankroll-VLT-Security-Review.pdf)):
  1 Informational (supply-conservation invariant unobservable pre-bootstrap; acknowledged).
  On-chain verification that 99.998% of Uniswap V2 LP is permanently unwithdrawable —
  **"rug-proof on liquidity"** determination.

**Relevance to this audit:** VLT is verified to be a plain, fixed-supply ERC-20 with no
transfer hooks, no fee-on-transfer, and no rebasing. The vault's assumptions about its two
pool tokens (see §4 trust model and I-06) are therefore sound for the VLT leg. USDC remains
an upgradeable, blacklistable third-party contract.

---

## 2. Executive summary

`VltUsdcVault` is a single-position, full-range Uniswap V4 VLT/USDC LP vault whose ERC-20
shares are denominated in pool **liquidity (L)** rather than dollars. It is **fully
ownerless**: no admin, no pause, no upgrade path, no privileged parameter, no sweep. The
three entrypoints (`deposit`, `redeem`, `compound`) are permissionless and `nonReentrant`;
the only external dependency in the critical path is the canonical V4 `PoolManager`, with
hooks explicitly disallowed at construction (`VltUsdcVault.sol:222`). `ZapHelper` is a
stateless, ownerless periphery contract that converts USDC-only deposits into the balanced
pair via one immutable whitelisted router; a fault in it cannot affect vault solvency.

The architecture is deliberately minimal and the hard problems of this design — the
first-depositor inflation attack, direct-donation share inflation, and V4's
fold-all-fees-into-any-`modifyLiquidity` behavior (the project's "BUG-1") — are all
correctly handled (§7). Slither reports **0 results** (75 contracts, 96 detectors, re-run
for this audit) and the test suite (including a stateful invariant harness, reentrancy
probes, and fee-retention tests against a real `PoolManager`) passes — 42 tests at audit
time, 47 after the post-audit remediations and event additions below.

**No Critical, High, or Medium severity issues were identified.** The findings below are
Low-severity refinements and informational notes, several of which are conscious,
in-code-documented design choices flagged here for completeness.

### Findings summary

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 0 | — |
| Low | 3 | **All 3 fixed** (July 8, 2026 — see per-finding Resolution notes) |
| Informational | 10 | Acknowledged / by design (I-10 added by the July 9 re-audit) |

**Remediation re-verification (July 8, 2026):** after the L-01–L-03 fixes, the contracts
recompile clean, **Slither again reports 0 results** (75 contracts, 96 detectors), Solhint is
clean, and the suite grew to **46 passing tests** — including four new regression tests: an
expired-deadline revert for `deposit`, an expired-deadline revert for `zapDeposit` (asserting
the external swap leg never ran), a rebalance-cap test (a one-sided donation with no fresh
fees is never swapped), and a `zap()` refund-to-caller test. (The §7a event change below adds
a fifth regression test, bringing the final post-remediation total to **47**.)

**Adversarial re-audit (July 9, 2026):** the final contracts + this report were re-reviewed
by an independent multi-agent pass — eight parallel dimensions (V4 delta settlement, fee/event
accounting, the L-01 rebalance cap, share/inflation math, ZapHelper, reentrancy/access,
arithmetic, and report-accuracy), each candidate finding adversarially verified by a separate
skeptic, plus a completeness critic. **No new code correctness or security defect was
confirmed** in either contract — the two contract-level candidates raised were both refuted as
intended, already-documented BUG-1 behavior. It surfaced one informational contract nuance
(I-10, added above) and three accuracy defects in this document itself — stale line-number
citations, an incorrect `slither-disable` count, and a self-contradictory test count — all
corrected in this revision.

---

## 3. Scope

| File | nSLOC (approx.) | Coverage |
|---|---|---|
| `contracts/VltUsdcVault.sol` | ~360 | Full, line-by-line |
| `contracts/ZapHelper.sol` | ~120 | Full, line-by-line |
| `contracts/test/*` (MockERC20, ReentrantToken, MockSwapRouter, MockPermit2, V4Harness) | ~190 | Reviewed only as test scaffolding — **not production code**, must never be deployed |

Out of scope: `@uniswap/v4-core`, `@uniswap/v4-periphery`, `@openzeppelin/contracts`
(audited upstream dependencies), deploy scripts, the frontend, and the VLT token itself
(covered by the prior audits above).

---

## 4. Architecture, actors, and trust model

**Actors**

| Actor | Capabilities | Notes |
|---|---|---|
| Any user | `deposit`, `redeem`, `compound`, ERC-20 share ops | No privileged role exists anywhere |
| Keeper / finder | `compound()` for a 1% in-kind cut of freshly harvested pool fees | Permissionless, competitive |
| ZapHelper (or any zapper) | Ordinary caller of `deposit` | Vault has no knowledge of it |
| Uniswap V4 PoolManager | Sole external dependency; calls back `unlockCallback` | Callback gated to `msg.sender == poolManager` (`VltUsdcVault.sol:541`) |
| Deployer | Constructor parameters only | Zero post-deploy privileges |

**Mutable state** on the otherwise-immutable vault is limited to: OZ ERC-20 share
accounting, `poolKey` (constructor write-once), `inceptionTime` (write-once on first
deposit), and the informational 35-slot L/share snapshot ring. There is nothing an admin
key could touch because there is no admin key.

**Core invariants** (all verified in code and exercised by `test/vault.invariants.test.js`):

1. **Solvency by construction** — shares are a pro-rata claim on position liquidity;
   `redeem` removes exactly `floor(L·shares/supply)` and returns both tokens in-kind
   (`VltUsdcVault.sol:428`). The vault never owes more L than the position holds.
2. **Share supply changes only in `deposit`/`redeem`** — `compound()` mints no shares, so
   L/share is monotonically non-decreasing across compounds (`VltUsdcVault.sol:719`).
3. **Uncompounded pool fees always accrue to all holders** — every `modifyLiquidity` path
   splits `feesAccrued` out of `callerDelta` and retains it at the vault
   (`VltUsdcVault.sol:577-602, 639-658`); only `compound()` pays any fee out (the 1%). See
   I-10 for the one bounded exception this creates for a joining depositor.
4. **Every unlock nets its deltas to zero** — otherwise the PoolManager reverts
   `CurrencyNotSettled`; all passing flow tests prove this transitively.
5. **`MINIMUM_LIQUIDITY` (1,000 L) is locked at `0xdead` forever** on first deposit
   (`VltUsdcVault.sol:390-391`).

**Token assumptions:** both pool tokens must be non-hooked, non-fee-on-transfer,
non-rebasing ERC-20s. Verified true for VLT (§1). USDC satisfies this today but is an
upgradeable proxy with a blacklist (see I-06); the blacklist case is handled and documented
in-code (`VltUsdcVault.sol:411-414`).

---

## 5. Findings — Low

### L-01 — `compound()` values and rebalances at manipulable spot price; "never loses" is a bounded-loss claim, not an absolute one

**Location:** `VltUsdcVault.sol:276-301` (`compoundClaimable`), `783-826` (`_rebalance`),
`89-111` (limit + cap constants)

`compound()` gates on a USDC valuation of claimable assets taken from the pool's current
`sqrtPriceX96`, and `_rebalance` sizes and executes its internal swap against that same
spot price, bounded to a ≤5% *further* move by `sqrtPriceLimitX96`. The 5% band bounds the
price impact **of the vault's own swap**, relative to whatever the pool price already is —
it does not bound a *prior* manipulation. An attacker can push the pool price, then call
`compound()` (earning the finder fee themselves), causing the vault to swap ~half its
claimable imbalance at the skewed price and add liquidity at that skewed ratio; the
attacker's restoring swap then extracts part of that value.

**Why this is Low, not Medium:** the exploit is structurally unprofitable in this design.
(1) The at-risk notional is only the reinvestable balance (fees since the last compound
plus retained dust — typically small, floored at $1). (2) Manipulating a full-range 1% pool
requires a large swap whose 1% fee accrues predominantly **to the vault itself** (it is the
dominant LP), so the attacker funds the holders they are attacking, twice (push and
restore). (3) Liquidity added at a bad price is bounded dust relative to the manipulation
cost. The in-code claim "a manipulated price simply defers, never loses"
(`VltUsdcVault.sol:96`) is slightly stronger than what holds: an unfilled remainder defers,
but the filled portion executes at the prevailing (possibly skewed) price. The test
`compound keeps NAV/share monotonic even when the price is pushed before compound`
exercises exactly this and passes because the fee income exceeds the skew loss.

**Recommendation:** No code change required given the economics. If extra belt-and-braces
is wanted before mainnet, cap `amountIn` in `_rebalance` to a small multiple of this
harvest's `fee0`/`fee1` (bounding worst-case skewed-swap notional even when large retained
balances have accumulated), and soften the comment at line 96 to "defers, and bounds any
loss to the filled portion at the prevailing price."

**Resolution (fixed, July 8, 2026):** both recommendations applied. A new constant
`REBALANCE_CAP_MULT = 4` caps the rebalance swap input to 4× the value of the current
call's freshly harvested pool fees, expressed in the input currency at spot
(`_rebalance` now takes `fee0`/`fee1`); with zero fresh fees the cap is zero and the vault
never trades held balances at spot. Capped-out imbalance folds forward across compounds.
The overstated "never loses" comment was rewritten to state the actual guarantee (the 5%
band bounds the vault's own price impact; the cap bounds the notional exposed to a prior
manipulation). Regression test: `vault.flows.test.js` — "rebalance swap is capped by fresh
fees: a one-sided donation alone is never swapped."

### L-02 — `zap()` sends the unspent-input refund to `recipient`, not to the caller

**Location:** `ZapHelper.sol:130-142` (`zap`); pre-fix the refund `_sweep` sent unspent `tokenIn` to `recipient` (now `msg.sender`, line 141)

`zap(tokenIn, tokenOut, amountIn, minOut, recipient, swapData)` pulls `amountIn` from
`msg.sender`, but if the route under-consumes its input, the leftover `tokenIn` is swept to
`recipient` along with the output. When `recipient` is a third party (a common pattern:
"swap and send to my cold wallet / a contract"), the caller's refund is silently
misdirected to that third party. The NatSpec ("refund any unspent `tokenIn`") does not say
to whom, and the natural reading is "to the payer."

**Impact:** loss limited to route under-spend dust, only when `recipient != msg.sender`;
no protocol funds at risk. (`zapDeposit` is unaffected — it sweeps to `msg.sender`.)

**Recommendation:** `_sweep(tokenIn, msg.sender)` in `zap()`, or document explicitly that
all residuals follow `recipient`.

**Resolution (fixed, July 8, 2026):** `zap()` now sweeps unspent `tokenIn` to `msg.sender`
(the payer); `recipient` receives the output only, and the NatSpec states this explicitly.
Regression test: `zaphelper.permit2.test.js` — "refunds unspent input to the CALLER, not
the recipient."

### L-03 — No deadline parameter on `deposit` / `zapDeposit`

**Location:** `VltUsdcVault.sol:349-356` (`deposit`), `ZapHelper.sol:89-95` (`zapDeposit`)

Neither the vault's `deposit` nor the helper's `zapDeposit` accepts a `deadline`. A
transaction that lingers in the mempool (low gas, congestion) can execute much later under
market conditions the user no longer intends. The existing bounds (`minShares`,
`minVltOut`) do limit the damage — `minShares` is denominated in L, so a stale execution
still cannot mint fewer shares than promised — but L-denominated bounds do not pin the
*dollar* terms of the entry, and Uniswap periphery convention is to include a deadline.
`redeem` and `compound` genuinely do not need one (in-kind / self-bounded respectively).

**Recommendation:** add a `uint256 deadline` +
`require(block.timestamp <= deadline, "expired")` to `deposit` and `zapDeposit` (or accept,
documented, that `minShares`/`minVltOut` are the only staleness guards).

**Resolution (fixed, July 8, 2026):** `deposit(vltAmount, usdcAmount, minShares, deadline)`
and `zapDeposit(usdcAmount, swapUsdcToVlt, minVltOut, minShares, deadline, swapData)` both
revert `"expired"` past the deadline. The helper checks **before** its external swap leg and
passes the same deadline through to the vault (defense in depth). All callers updated:
test helpers, seed/simulate scripts (the seed script uses now + 30 min), the frontend ABI,
and `vltUSDC.js` (sends now + 30 min). Regression tests: `vault.edge.test.js` — "deposit
past its deadline reverts"; `scripts.quoter.test.js` — "zapDeposit past its deadline
reverts before the swap leg runs."

---

## 6. Findings — Informational

### I-01 — `compound()` reverts instead of no-opping if ≥ $1 is donated to the vault before the first deposit

`compoundClaimable()` counts vault-held balances (`VltUsdcVault.sol:294-295`), so a ≥$1
donation made **before any deposit exists** passes the gate, and `_onCompound`'s
fee-collect poke (`modifyLiquidity` with `liquidityDelta == 0`, `VltUsdcVault.sol:669-673`)
then reverts inside V4 (`CannotUpdateEmptyPosition` — a poke requires an existing
position). Nothing is stuck or lost — `compound()` simply reverts until the first deposit
creates the position, after which the donation folds into the next compound as designed.
Self-healing; noted for completeness.

### I-02 — Permit2 branch of `_execRoute` does not reset the residual ERC-20 approval

`_execRoute` resets the router allowance to 0 after the route in the plain-allowance branch
(`ZapHelper.sol:178`) but the Permit2 branch leaves the helper→Permit2 ERC-20 allowance at
whatever the route did not consume (`ZapHelper.sol:153-156`). This is benign in the current
design: the helper holds no balances between calls (everything is swept), and the Permit2
sub-approval (router as spender) expires after 60 seconds. Asymmetric hygiene only; reset
both branches for uniformity if touched again.

### I-03 — Any tokens resting in `ZapHelper` are claimable by the first caller (by design)

`zap()`/`zapDeposit()` measure and sweep the helper's **entire** balance of the involved
tokens (`ZapHelper.sol:111, 122-123, 141, 182-185`). Tokens accidentally transferred
directly to the helper are therefore collectable by anyone who calls `zap` next. This is
the intended "stateless, no custody" model and cannot touch user or vault funds, but it is
worth stating in user-facing docs: **never send tokens directly to the ZapHelper address.**

### I-04 — Vault shares report `decimals() == 0`

`VltUsdcVault.sol:251-253`. Intentional (shares are raw integer L units), and correct in
that mint/burn/transfer semantics are unchanged. Expect cosmetic quirks in integrations
that assume 18 decimals (some DEX UIs, portfolio trackers, `permit`-less approvals with
"unlimited" shortcuts). Purely a display/integration consideration.

### I-05 — `Snapshot.timestamp` is `uint32` (wraps in 2106)

`VltUsdcVault.sol:153`. The APR ring's timestamps overflow in February 2106. The ring is
informational-only and touches no accounting; acceptable, noted for the record.

### I-06 — External-token trust assumptions (USDC upgradeability & blacklist)

The vault hardcodes correct behavior for today's USDC (6 decimals, blacklist handled at
`VltUsdcVault.sol:411-414`: a blacklisted redeemer's whole `redeem` reverts, harming only
themselves). Residual risks outside the vault's control: USDC is an upgradeable proxy
(Circle could in principle add hooks/fees, violating the vault's token assumptions), and a
**blacklisted vault address** — however unlikely — would freeze the USDC leg of every
redeem. Neither has a code remediation in an ownerless design; they are inherent to pairing
with USDC and should be listed in user-facing risk docs. The VLT leg carries no equivalent
risk (immutable token, §1).

### I-07 — Finder-fee base excludes retained balances: keeper incentive can lag the gate

Conscious design (documented at `VltUsdcVault.sol:686-690` and in the README): the 1%
bounty is computed only on **freshly harvested pool fees**, while retained
deposit/redeem-harvested fees and dust reinvest with no bounty. Consequence: the $1 gate
can be satisfied almost entirely by retained balances while the bounty is near zero, so no
rational keeper calls `compound()` and the retained value sits unreinvested until fresh
pool fees accrue. Pure opportunity cost to holders, no loss; flagged so the choice is
re-confirmed at the Shieldify review as the README requests.

### I-08 — `ZapHelper` emits no events

`zap`/`zapDeposit` emit nothing. Vault events cover deposits, but off-chain accounting of
zap routing, under-spends, and sweeps would benefit from a `ZapExecuted`-style event.
(Consistent with the project's no-event-log-dependency stance for *reads*; emitting is
still cheap and useful for indexers.)

### I-09 — Dependency versions are caret ranges, not exact pins

`package.json` declares `^5.1.0` / `^1.0.2` for OZ and v4-core/periphery. `package-lock.json`
pins the actual install, but for an audited artifact the convention is exact versions in
`package.json` too, so the audited bytecode is reproducible from the manifest alone.

### I-10 — A joining depositor's share price ignores retained/pending fees (bounded JIT-yield capture)

*Surfaced by the July 9 adversarial re-audit.* Shares are priced purely on position
liquidity: `shares = supply * liquidityAdded / liqBefore` (`VltUsdcVault.sol:398`), with
`liqBefore` snapshotted before the unlock (`:371`). The vault's **off-position** value — prior
compound dust, redeem-retained fees, and the position's pending pool fees that `_onDeposit`
harvests into the retained balance *during this very deposit* (`:577-602`) — is deliberately
excluded from that price. This exclusion is exactly what defeats donation inflation (pricing
on token balances would reopen it, see §7), so it is a **deliberate trade-off, not a coding
error**. The side effect: a new depositor pays nothing for the retained/pending value yet, by
becoming a holder, gains a pro-rata claim on it; when a later `compound()` folds that value
into L, the joiner captures their fraction of value that accrued entirely before they joined,
diluting prior holders by the same amount. `redeem()` is asymmetric in the holder-favoring
direction (a leaver forfeits pending fees, `:639-658`), so the only extractable direction is
deposit-then-hold-through-a-compound — classic JIT yield capture, not an atomic round-trip.

**Why informational, not a vulnerability:** the transferable amount is bounded by the
*uncompounded* fee/dust balance at deposit time — small under the permissionless, $1-gated,
1%-bounty compound cadence — there is no atomic profit and no solvency or theft vector, and
capturing a meaningful fraction requires depositing capital comparable to the entire existing
position for a dust-sized gain. Existing holders can fully neutralize it by calling the
permissionless `compound()` before a large deposit lands (crystallizing pending value into L
first). Invariant #3 and the §7 donation analysis were tightened to cross-reference this.

**Recommendation: accept and document** as bounded JIT-yield capture — the current, and
correct, choice. The theoretical alternative, crystallizing pending+retained fees into L at the
top of `deposit()` (invoking the harvest-and-reinvest path before snapshotting `liqBefore`),
is **not recommended**: it grafts a full compound onto every deposit, imposing three concrete
costs to close a near-zero gap. (1) *Gas tax on every depositor* — the retained balance is
almost always one-sided, so folding it in requires the rebalance `swap()` + `_addLiquidity`,
i.e. the whole `compound()` body, on each deposit. (2) *Keeper cannibalization* — deposits
would drain the fresh-fee pool the 1% finder bounty is computed on, so standalone `compound()`
rarely clears gas and genuine keeper participation dries up, leaving a quiet market with no
deposits uncompounded. (3) *Breaks the swap-free deposit invariant* — `deposit()` performs no
swap today (only `compound()` swaps, in the vault's own pool); crystallizing drags a pool swap
into the deposit path, giving deposits price-manipulation exposure (the L-01 cap would now have
to guard deposits too) and making their gas/success depend on live pool state — eroding the
deterministic, oracle-free deposit the design leans on. The gap it would close is already
self-solving: I-10's magnitude is bounded by the *uncompounded* fee balance at deposit time,
which under an active keeper is ~zero. The cheap, sufficient mitigation is a user-facing note
that a keeper `compound()` immediately before a large deposit erases even the bounded case.
**Do not** instead add vault token balances to the share price — that reopens the
donation-inflation vector this design exists to prevent. Flagged for the Shieldify review so
the trade-off is explicitly re-confirmed.

---

## 7. Attack-surface analysis (verified safe)

Each of the classic vault attack classes was checked explicitly:

**First-depositor share inflation — mitigated.** First deposit requires
`liquidityAdded > 1_000` and locks 1,000 shares at `0xdead` (`VltUsdcVault.sol:390-396`).
Because shares are L-denominated and L/share can only be inflated by *donating value that
compounds to all holders*, the attacker's inflation spend is recouped only pro-rata to
their own holding; quantitatively, making a victim's worst-case rounding loss reach even
$100 requires donating ≥ $100 × totalSupply-in-shares — astronomically unprofitable — and
`minShares` independently reverts a rounded-to-zero mint.

**Direct-donation inflation — mitigated.** Shares are minted pro-rata to **ΔL reported by
the PoolManager** (`VltUsdcVault.sol:398`), never to token balances; donated tokens are
snapshotted as `retain0/1` *before* the deposit transfer (`VltUsdcVault.sol:365-366`) and
excluded from the depositor's add, folding forward to all holders. (This ΔL-only pricing has
one bounded side effect — a joining depositor's pro-rata claim on *pre-existing* retained/
pending fees — analyzed as informational finding I-10.)

**V4 fee-sweep ("BUG-1") — correctly fixed in all three paths.** V4 folds a position's
full accrued fees into `callerDelta` on *any* `modifyLiquidity`. `_onDeposit` harvests fees
to the vault before the depositor's add (`VltUsdcVault.sol:577-602`); `_onRedeem` pays the
redeemer `callerDelta − feesAccrued` and takes the fees to the vault
(`VltUsdcVault.sol:639-658`); `_onCompound` is the only fee-payout path (1% of the fresh
harvest). `test/vault.fees.test.js` covers all three.

**Delta settlement — nets to zero on every path.** Adds settle negative deltas
(`sync → transfer → settle`, `VltUsdcVault.sol:858-866`), removes/harvests `take` positive
deltas in full, and the swap settles only the input actually consumed under a partial fill
(`VltUsdcVault.sol:832-855`). Any residual would revert the whole unlock
(`CurrencyNotSettled`), which the passing flow tests exclude.

**Reentrancy — guarded and structurally limited.** All three entrypoints are
`nonReentrant`; the unlock callback accepts only the PoolManager (`VltUsdcVault.sol:541`);
the pool tokens have no transfer hooks (§1); the finder payout is last, after all pool
effects (`VltUsdcVault.sol:730-733`). The suite's `ReentrantToken` probe asserts reentry
reverts with `ReentrancyGuardReentrantCall`.

**Redeem sandwiching — not value-extractable.** Redemption is strictly in-kind and
pro-rata; a manipulated price only shifts the token *split*, and by AM-GM the bundle at a
displaced price is worth more, not less, at the true price. The absence of min-out bounds
on `redeem` is therefore sound (and keeps exit ungrieffable).

**Rounding directions — consistently favor the vault/holders.** Deposit shares floor
(`:398`), redeem liquidity floors (`:428`), V4 rounds removal amounts down, the
`uint128` downcast in `redeem` is bounded by the position's own `uint128` liquidity, the
sqrt-space 5% limit constants round inward (9747² = 0.95004, 10246² = 1.04980), and
`_liquidityForAmounts` takes the min of the two single-sided computations so an add can
never demand more than the vault holds.

**Access control — nothing to protect.** There are no privileged functions; the
constructor enforces `hooks == address(0)` and canonical token ordering
(`VltUsdcVault.sol:222-223`), eliminating the hook-based attack surface entirely.

---

## 7a. Post-audit change (July 8, 2026): fee-accounting events for off-chain adapters

Reviewed as part of this engagement. Motivated by DefiLlama fees-adapter / TVL support:
the original events could not account for realized pool fees from logs alone, because the
BUG-1 fix makes `deposit()`/`redeem()` harvest the position's accrued fees to the vault
**silently**, and `Compound` emitted only the finder's 1% cut — an events-only fee adapter
would systematically under-report whenever the vault was actively used.

**Changes** (`VltUsdcVault.sol`, events section and callback handlers):

- `Compound` extended: `Compound(finder, fee0, fee1, finder0, finder1, liquidityAdded)` —
  now carries the FULL freshly harvested pool fees, with the finder amounts alongside.
- New `FeesRetained(uint256 fee0, uint256 fee1)`, emitted by `_onDeposit` and `_onRedeem`
  whenever a fee harvest is retained at the vault (only when non-zero).

**Adapter contract:** realized pool fees = Σ `Compound.fee0/fee1` + Σ `FeesRetained.fee0/fee1`;
keeper revenue = Σ `finder0/finder1`; SupplySideRevenue = the difference; ProtocolRevenue = 0
(no protocol take exists). TVL needs no events: `previewRedeem(totalSupply())` plus the
vault's token balances at a block.

**Security review of the change:** accounting-neutral — no storage, no control flow, no
transfer logic touched; emits occur inside the unlock callback after calls into the trusted
PoolManager only, under `nonReentrant` entrypoints (the pre-existing `reentrancy-events`
justification now also covers `_onDeposit`/`_onRedeem`, suppressed inline with the same
rationale as `_onCompound`). Event args honestly label their basis: `Compound.fee0/fee1`
are the fresh harvest only (retained balances reinvested in the same call are reported by
the earlier `FeesRetained` emissions that created them — no double count). Verified by a
new regression test (`vault.fees.test.js` — "emits complete fee-accounting events…")
asserting `FeesRetained` matches computed gross fees on both paths and
`finder = fee / 100` exactly; suite at 47 passing, Slither 0, Solhint clean after the
change. Frontend ABI (`src/js/vault-abi.js`) updated to match.

---

## 8. Static & dynamic analysis (re-run for this audit)

- **Slither** (local venv, `slither.config.json`, test contracts and `node_modules`
  filtered): **0 results** over 75 contracts with 96 detectors. The ~31 inline
  `slither-disable` directives in the two production contracts (26 `-next-line` + one
  `-start/-end` region in `VltUsdcVault.sol`, 4 in `ZapHelper.sol`, spanning ~10 distinct
  detector categories) were each re-reviewed and all are justified (intentional tick-spacing
  truncation, `== 0` guards, partial-tuple reads, wrapping fee-growth subtraction,
  trusted-callee event ordering under `nonReentrant`, including the `reentrancy-events`
  disables added for the §7a `FeesRetained` emits).
- **Solhint** security gate: wired (`npm run lint:sol`), clean per workspace config.
- **Hardhat suite:** **42 passing, 2 pending** at audit time; **47 passing** after the
  L-01–L-03 remediations and the §7a event change (the pending pair are the opt-in
  `FORK=1` mainnet-fork tests). Coverage includes deposit/redeem/compound flows against a
  real deployed `PoolManager`, the fee-retention (BUG-1) tests, first-deposit inflation,
  reentrancy, USDC-blacklist behavior, the price-push-before-compound NAV-monotonicity
  test, the APR ring, and a 3-seed stateful invariant harness.
- **Suggested pre-mainnet additions** (echoing the README's own caveats): a Foundry
  `invariant_*` suite for thousands-of-runs fuzzing depth, and a fork test through the real
  Universal Router once the VLT mainnet route exists.

---

## 9. Security posture checklist

| Item | Status |
|---|---|
| No owner / admin / privileged role | Pass |
| No upgradeability, `delegatecall`, or `selfdestruct` | Pass |
| No pause (exit always open) | Pass |
| Reentrancy guards on all entrypoints; callback caller-gated | Pass |
| Checks-effects-interactions (burn-before-unlock; finder paid last) | Pass |
| First-depositor inflation mitigated (dead shares + min first ΔL) | Pass |
| Donation-inflation mitigated (ΔL-based shares, retain snapshot) | Pass |
| V4 `feesAccrued`/principal split complete on every `modifyLiquidity` path | Pass |
| Oracle-free (no external price dependency in vault) | Pass |
| Hooks disallowed at construction | Pass |
| Slippage bounds where value-extractable (`minShares`, `minVltOut`) | Pass |
| SafeERC20 everywhere; no unchecked external-call returns | Pass |
| Slither clean / Solhint clean | Pass |
| Deadline parameters on time-sensitive entrypoints | Pass (fixed — L-03) |
| Refund routing in periphery `zap()` | Pass (fixed — L-02) |
| Rebalance notional capped independently of retained balance | Pass (fixed — L-01) |
| Exact dependency pinning in manifest | Fail (Info — I-09) |
| Independent third-party audit | Pending (Shieldify) |

---

## 10. Conclusion

The vltUSDC vault is an unusually disciplined design: ownerless, oracle-free, single
external dependency, shares denominated in a manipulation-resistant unit (L), in-kind exit
that cannot be gated or sandwiched for value, and a periphery split that keeps the entire
routing/MEV surface out of the solvency-critical core. The historically dangerous parts of
this pattern — first-depositor inflation, donation inflation, and V4's fee-folding
semantics — are all handled correctly and covered by targeted tests.

**No Critical, High, or Medium issues were found.** The three Low findings — a
fresh-fee-scaled cap on the compound rebalance notional (plus an honest restatement of its
price-bound guarantee), refund routing in `zap()`, and deadlines on `deposit`/`zapDeposit` —
**have all been fixed and regression-tested** (see the Resolution notes in §5; Slither 0,
47 tests passing post-fix). The informational items are predominantly conscious design
choices that should simply be re-confirmed during the independent review.

Recommended before mainnet, in order: (1) ~~apply/accept L-01–L-03 explicitly~~ done; (2) complete
the planned **Shieldify audit** with the README's flagged scope (V4 settlement paths, the
fee split, the finder-fee base, and the ZapHelper external-sourcing pattern); (3) re-run
Slither + the full suite (and ideally a Foundry invariant pass) on the final commit; and
(4) publish the audited commit hash and deployed addresses so users can verify source
against bytecode.

---

## Disclaimer

This review reflects analysis of the source code in `src/contracts/contracts/` as of the
date above, the referenced prior reports, and the project's own test/static-analysis
tooling executed locally. It does not guarantee the absence of vulnerabilities, does not
cover deployed bytecode verification (nothing is deployed yet), and does not constitute
financial advice. Modifications after this review — including fixes for the findings above
— may introduce new issues and warrant re-review.
