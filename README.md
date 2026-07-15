# vltUSDC Vault — Hardhat workspace

Hardhat build/test/deploy pipeline for `VltUsdcVault.sol`, an auto-compounding Uniswap
**V4** VLT/USDC full-range LP vault. ERC-20 shares are denominated in pool **liquidity (L)**.

**Core/periphery split:** the **vault** takes a balanced **VLT + USDC** pair → shares, with *no
swap and no external dependency* (deterministic, oracle-free, minimal-trust). A separate,
replaceable **`ZapHelper`** (periphery) converts a USDC-only deposit into that pair by **buying
VLT from its external market** (the buy pressure that lifts VLT's price) via an off-chain Uniswap
route, then calling the vault. The vault doesn't reference the helper — topology changes only
ever touch periphery, and a zapper bug can't affect the vault or its holders. See
[`docs/vltUSDC-pitch.md`](docs/vltUSDC-pitch.md) for the product overview.

This is a **standalone** Hardhat workspace; the jQuery/gulp frontend lives in the sibling
[bankroll-web](https://github.com/bankrollnetwork/bankroll-web) repo.

> **Status:** compiles, fully fork-/PoolManager-tested (61 unit + 2 opt-in fork tests), Slither
> clean (0 findings, 96 detectors), Solhint clean, dependencies pinned. **Not yet
> mainnet-ready** — pending the Shieldify audit (see
> [Remaining before mainnet](#remaining-before-mainnet)).

---

## Layout

```
bankroll-contracts/
├── contracts/
│   ├── VltUsdcVault.sol          # the vault: balanced VLT+USDC → shares, no external deps
│   ├── ZapHelper.sol             # PERIPHERY: USDC → buy VLT (off-chain route) → vault.deposit → shares
│   └── test/                     # test-only: MockERC20, ReentrantToken, MockSwapRouter, MockPermit2, V4Harness
├── scripts/
│   ├── config.js                 # network-aware params (mainnet defaults + env overrides)
│   ├── lib/pool.js               # extsload price reads + off-chain zap quoter
│   ├── deploy_zaphelper.js       # deploy the ZapHelper (run before the vault)
│   ├── 00_create_and_init_pool.js
│   ├── 01_deploy_vault.js
│   ├── 02_seed_first_deposit.js
│   ├── 03_verify_etherscan.js
│   └── dev/                      # local-only bootstrap helpers
├── periphery/
│   ├── defillama/                # submission-ready TVL + fees adapters (+ fork test harness)
│   └── dune/                     # DuneSQL dashboard queries (fees, TVL, APR, holders)
├── test/
│   ├── helpers/                  # fixture (real PoolManager + mocks) + math
│   ├── vault.flows.test.js       # deposit / redeem / auto-compound happy paths
│   ├── vault.edge.test.js        # edge, abuse, reentrancy, blacklist, admin
│   ├── vault.fees.test.js        # fee retention: deposit/redeem keep fees at the vault
│   ├── vault.invariants.test.js  # stateful property harness
│   ├── scripts.quoter.test.js    # quoter, buy-pressure, external-market sandwich bound
│   ├── zaphelper.permit2.test.js # ZapHelper Permit2 branch (deterministic, no RPC)
│   └── fork/                      # opt-in mainnet-fork: vault wiring + real UR/Permit2 zap (FORK=1)
├── hardhat.config.js             # solc 0.8.26, viaIR, evmVersion cancun
└── .env.example                  # copy to .env
```

## Prerequisites

- Node 18+ (developed on Node 22). `npm install` in this directory.
- For live deploys/forking: an archive RPC URL (Alchemy/Infura) and a funded deployer key.

```bash
cd bankroll-contracts
npm install
cp .env.example .env   # then fill in
```

## Build

```bash
npm run build          # hardhat compile (solc 0.8.26, viaIR, cancun)
```

The contract relies on Uniswap V4 transient storage, so the EVM version is pinned to
`cancun` and the IR pipeline is on (the PoolManager overflows the legacy stack otherwise).

## Test

The primary suite deploys the **real v4-core `PoolManager`** plus mock VLT (18d) / USDC (6d)
to the in-process Hardhat chain, initializes the pool, seeds baseline liquidity, and
exercises every flow. No archive RPC required.

```bash
npm test               # 61 passing (+ opt-in fork suite)
npm run coverage       # solidity-coverage
```

What's covered:

| Area | Where |
|---|---|
| Compiles against pinned v4 | `npm run build` |
| Liquidity math (v4-periphery `LiquidityAmounts`) | every deposit/compound test |
| Zero residual delta on every callback | implicit — the PoolManager reverts `CurrencyNotSettled` otherwise, so all passing flow tests prove it |
| Off-chain quoter: negligible dust + `minOut` holds under a sandwich | `scripts.quoter.test.js` |
| Flows: deposit ΔL/dust, redeem in-kind, auto-compound 100% reinvest / no shares / L up | `vault.flows.test.js`, `vault.edge.test.js` |
| Fee retention: deposit/redeem keep fees at the vault (never swept to the caller) | `vault.fees.test.js` |
| ZapHelper: external sourcing, buy pressure, sandwich bound, Permit2 branch | `scripts.quoter.test.js`, `zaphelper.permit2.test.js` |
| Invariants: solvency, no-free-shares, compound monotonicity, settlement | `vault.invariants.test.js` |
| Edge/abuse: `deposit(0)`, redeem>balance, below-threshold deposit (no compound), donation socialization, reentrancy on every entrypoint, blacklisted USDC | `vault.edge.test.js` |
| Security: `nonReentrant`/CEI, `MINIMUM_LIQUIDITY`, `sweep` can't touch core tokens, pause never blocks redeem | `vault.edge.test.js` |

### Static analysis

```bash
npm run lint:sol       # Solhint security gate (.solhint.json) — JS-native, exit 0 clean
npm run slither        # Slither — needs the local .venv (see below); exit 0 clean
```

- **Solhint** is wired as a security-focused lint gate (style/gas/doc rules scoped out so
  it surfaces real issues only).
- **Slither** runs from a local Python venv kept out of `package.json`:
  ```bash
  python3 -m venv .venv
  .venv/bin/pip install "cbor2<5.6" slither-analyzer   # cbor2<5.6 avoids a Rust build on Py3.13
  npm run slither
  ```
  All 14 raw findings were triaged: 1 was a **real bug** (the V4 fee-sweep issue, handled by
  the deposit/redeem retention split — see [Key mechanics](#key-mechanics)); the
  other 13 are false positives (intentional tick-spacing snap, `== 0` guards, partial-tuple
  reads, event-after-trusted-call under `nonReentrant`) suppressed with justified inline
  `slither-disable` annotations. Slither now reports **0 results**.

### Optional mainnet fork tests

Need an **archive RPC** (e.g. Alchemy/Infura/QuickNode — a normal mainnet HTTPS endpoint; their
free tiers serve archive state). Gated on `FORK=1`, so they skip cleanly otherwise.

```bash
# .env: MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY   FORK=1
FORK=1 FORK_BLOCK_NUMBER=25217000 npx hardhat test test/fork/vault.fork.test.js test/fork/zaphelper.fork.test.js
```

> **Pin `FORK_BLOCK_NUMBER`.** Forking from "latest" (unpinned) caused intermittent 403s from the
> RPC here; pinning a block also enables the local cache (Hardhat warns about this). Any recent
> block works.
> Also ensure the Alchemy app has **Ethereum Mainnet enabled** (Dashboard → app → Networks),
> else every request 403s.

- `vault.fork.test.js` — ✅ confirms the vault wires up against the actual **deployed** mainnet
  PoolManager and that `positionLiquidity()` decodes its live storage. (Notes that the VLT/USDC
  V4 pool isn't initialized on mainnet yet — expected.)
- `zaphelper.fork.test.js` — ✅ the integration the local suite can't cover: `ZapHelper` executing
  a **genuine Universal Router route via Permit2** against real liquidity. Validated at block
  25217000 (sourced ≈4.99 WETH for 10k USDC). USDC→WETH by default; set
  `ZAP_TEST_TOKEN_OUT`/`ZAP_TEST_V3_FEE` to target VLT once its mainnet route is known. Funds USDC
  via `setStorageAt`.

The Permit2 branch itself is also covered **deterministically (no RPC)** by
`zaphelper.permit2.test.js` (mock Permit2 + a Permit2-pulling router), so the helper's
production approval path doesn't rely solely on the fork run. A full
deposit/redeem/compound cycle additionally needs the V4 VLT/USDC pool initialized + a VLT
route — that's the end-to-end simulation below.

### Full end-to-end fork simulation (60 days)

The complete lifecycle on a persistent forked node — pool creation, a zap-seeded first
deposit through the **real Universal Router + Permit2**, then N simulated days of trading
volume with a deposit-triggered compound each day. This is the closest thing to production the
suite offers: real mainnet tokens (USDC/VLT), the real PoolManager, real routing.

```bash
# .env: MAINNET_RPC_URL + FORK_BLOCK_NUMBER (pinned) + INIT_USDC_PER_VLT (pool seed price,
#       e.g. 0.50). Optional: DEV_ACCOUNT=<your wallet> to get funded for UI testing.
npm run fork:node        # terminal 1 — forked node on 127.0.0.1:8545 (leave running)
npm run fork:setup       # terminal 2 — init pool, deploy vault + ZapHelper, fund DEV_ACCOUNT
npm run fork:simulate    # seed 20k USDC via zapDeposit, then 60 days × (volume + trigger deposit)
npm run adapters:test    # DefiLlama TVL + fees adapters against the populated fork
```

`fork:setup` writes the deployed addresses to `scripts/dev/.deployed.json` (gitignored) and
prints them for the test client's Config panel; the later steps read that file. Knobs (env):
`SIM_DAYS` (60), `SIM_USDC_PER_SWAP` (2000), `SIM_SEED_USDC` (20000), `FUND_ETH`/`FUND_USDC`
for the dev account. `fork:fees` runs volume-only rounds without compounding.

Expected shape of a healthy run (validated July 10, 2026): simulate reports
`60/60 days compounded` with L/share monotonically rising (≈1.10 after 60 days at the
default volume), and `adapters:test` shows a consistent TVL (both token legs on the right
decimal scales), 60 decoded `Compound` events, and `✓ supply-side == fees` on every one.

Two fork-specific gotchas, both time-related:

- **`evm_increaseTime` pushes chain time days ahead of wall clock.** Anything computing a
  deadline from `Date.now()` will revert `"expired"` — compute deadlines from the latest
  block's timestamp instead (the bundled test client does; `fork:simulate` uses
  `MaxUint256`).
- **No arbitrageurs on a fork.** The vault pool's price and VLT's external market drift
  apart, so a naive 50/50 zap split leaves a large refund. The test client sizes the split
  from the measured route rate and the pool's own price; expect a fat "dust" refund if you
  zap with hand-picked splits at a large gap.

To click through the UI against this fork: build + serve the sibling `bankroll-web` repo,
point its `config.js` `window.rpcURL` at `http://127.0.0.1:8545`, and paste the vault +
ZapHelper addresses from `fork:setup` into the test client's Config panel (your
`DEV_ACCOUNT` wallet arrives pre-funded).

## Deploy

Configure `.env` (RPC, `DEPLOYER_PRIVATE_KEY`, `ETHERSCAN_API_KEY`, and any address/price
overrides). Mainnet PoolManager/USDC/VLT have built-in defaults; testnets need explicit
addresses. Always pass `--network`:

```bash
# 0. Create + initialize the pool (idempotent — skips if already initialized).
#    Needs INIT_USDC_PER_VLT or INIT_SQRT_PRICE_X96 if the pool doesn't exist yet.
npx hardhat run scripts/00_create_and_init_pool.js --network sepolia

# 1. Deploy the vault (guards: pool initialized). Has no external deps.
npx hardhat run scripts/01_deploy_vault.js --network sepolia
#    → prints the vault address; set VAULT_ADDRESS in .env

# 1b. Deploy the periphery ZapHelper, pointed at the vault (whitelisted router + Permit2).
npx hardhat run scripts/deploy_zaphelper.js --network sepolia
#    → set ZAP_HELPER_ADDRESS in .env (the frontend uses it for USDC zap-deposits)

# 2. Seed the first deposit directly with a balanced pair (SEED_VLT + SEED_USDC).
npx hardhat run scripts/02_seed_first_deposit.js --network sepolia

# 3. Verify the vault (+ ZapHelper if ZAP_HELPER_ADDRESS set) on Etherscan.
npx hardhat run scripts/03_verify_etherscan.js --network sepolia
```

> On mainnet the canonical VLT/USDC 1% pool likely already exists — step 0 detects this and
> no-ops, and you proceed straight to step 1.
>
> Ongoing user deposits go through the ZapHelper: the frontend builds the USDC→VLT route
> (Uniswap Routing API, output to the helper) and calls `zapDeposit(usdc, swapUsdcToVlt,
> minVltOut, minShares, deadline, swapData)`. Bootstrapping (step 2) uses a direct deposit, no
> route needed.

A complete local dry-run of this exact pipeline (used to validate it) is:

```bash
npx hardhat node &                                                        # terminal 1
npx hardhat run scripts/dev/bootstrap_local.js   --network localhost      # PoolManager+tokens+MockSwapRouter → .env
npx hardhat run scripts/00_create_and_init_pool.js --network localhost
npx hardhat run scripts/dev/seed_baseline_local.js --network localhost
npx hardhat run scripts/01_deploy_vault.js       --network localhost      # note the address
VAULT_ADDRESS=0x... npx hardhat run scripts/deploy_zaphelper.js   --network localhost
VAULT_ADDRESS=0x... npx hardhat run scripts/02_seed_first_deposit.js --network localhost  # direct VLT+USDC seed
```

## Key mechanics

- **Liquidity math** uses v4-periphery's canonical `LiquidityAmounts.getLiquidityForAmounts`
  with `TickMath.getSqrtPriceAtTick(tickLower/tickUpper)` — no hand-rolled rounding.
- **The compound leg makes no external transfer to any account**: 100% of fees are taken
  to the vault and reinvested; the only token movements are settlements with the PoolManager.
- **Fee retention:** V4 folds a position's *full* `feesAccrued` into `callerDelta` on **any**
  `modifyLiquidity` — unhandled, the first party to touch the position after fees accrue would
  sweep 100% of the uncompounded fees. `deposit`/`redeem` therefore split
  `callerDelta − feesAccrued`: the caller gets only their principal, and the fees are retained
  at `address(this)` for all holders, folding forward into the next compound. No path ever pays
  fees out — the compound leg converts them to position liquidity.
- **Fee-accounting events for off-chain adapters:** `Compound(vltFees, usdcFees,
  liquidityAdded)` reports each full fresh harvest, and `FeesRetained(vltFees, usdcFees)` fires
  whenever `deposit`/`redeem` harvest-and-retain pool fees. Log-based fee accounting (e.g. a
  DefiLlama fees adapter) is complete from events alone: realized fees = Σ `Compound.fee` +
  Σ `FeesRetained.fee`, all of it supply-side; TVL needs no events
  (`previewRedeem(totalSupply())` + vault balances). See `AUDIT.MD` §7a/§7d.
- **Documented design choices in-code:** compound dust **folds forward** into the next
  compound (it isn't counted in shares, so it can only ever raise future NAV); the `uint128`
  downcast in `redeem` is provably bounded by the position's own `uint128` liquidity; USDC's
  6 decimals + blacklist behavior (a blacklisted holder's redeem reverts on the USDC leg —
  their problem, not a solvency issue) and the deliberate absence of any approval flow.

## Core / periphery split (ZapHelper)

The vault itself is a minimal **VLT + USDC → shares** LP vault — no swap, no router, no external
reference. The `ZapHelper` is **periphery** and sits in front of it:

1. `zapDeposit(usdcAmount, …)` pulls USDC and buys `swapUsdcToVlt` USDC worth of VLT from its
   external market by executing an **off-chain-computed route** (`swapData`) against one
   **immutable** whitelisted router (Uniswap's **Universal Router** on mainnet), bounded by
   `minVltOut`. This is the **buy-pressure leg** (drains external VLT supply, lifts price).
2. It deposits the bought VLT + remaining USDC into the vault via `vault.deposit(vlt, usdc,
   minShares, deadline, recipient)` — the vault mints shares straight to the end wallet — and
   sweeps any refund dust back to the caller. The `deadline`
   (checked by the helper before the swap leg, and again by the vault) stops a stale mempool
   transaction from executing an old route under moved market terms.

Why this shape:
- **The vault has zero external deps in its critical path.** No router, Permit2, or `swapData`
  inside it. "Admin keys can't touch deposits" is trivially true (it references no mutable/
  external contract). The whole MEV/routing/version-sensitive surface lives in periphery.
- **A zapper bug can never affect the vault or existing holders** — it's just another caller
  doing a normal deposit; the vault's invariants hold regardless.
- **Topology changes redeploy the periphery, never the immutable vault.** Multiple zappers can
  coexist; the vault blesses none.
- The auto-compound leg only reinvests vault-held tokens; `redeem()` is in-kind (no sell pressure on exit).

> **Trade-off (accepted):** buy pressure is a property of the **zapper path**, not enforced by the
> vault. A user depositing VLT+USDC directly creates none; USDC depositors (the dominant flow) go
> through the zapper and drive it. The pitch's "oracle-free / single-venue / solvent" framing
> applies to the vault + redeem; the zapper deliberately depends on VLT's external market.

## Fee-growth APR (trailing 7d / 30d)

`feeApr() → (lifetimeBps, d7Bps, d30Bps)` reports the vault's **fee** performance with VLT price
moves stripped out. It rests on one fact: **shares ≡ liquidity (L)**, and the auto-compound leg
(run by a triggering deposit) adds L *without minting shares for it*, so **L/share rises only on
a compound leg** — never on a deposit's own pro-rata add, on redeems, or on price. It starts at
exactly `1.0` on the first deposit, so `L/share − 1` is the
price-neutral, IL-free lifetime fee growth. (USD NAV/share would conflate fees with
the VLT price — the wrong signal for "are the fees working.")

**The ring buffer.** A trailing window needs *historical* L/share, and the vault deliberately avoids
on-chain event-log queries (unreliable across chains), so it stores the history itself:

- `struct Snapshot { uint32 timestamp; uint224 perShareWad; }` packs into **one** storage word.
  `perShareWad = positionLiquidity · 1e18 / totalSupply` — L/share as a `1e18` fixed-point **ratio**
  (the `1e18` is precision, **not** the share `decimals()`, which is `0`). We store the *ratio*, not
  raw L, because L/share is invariant to deposits/redeems (they scale L and supply together) and
  moves only on compound — so it isolates fees.
- `Snapshot[35] feeHistory` is a circular buffer. `_snapshotFeeGrowth()` runs at the **end of the
  auto-compound leg** (before the triggering deposit's own liquidity add) and writes the
  post-compound L/share **at most once per UTC day** (`feeHistoryHead` = newest slot;
  `lastSnapshotDay` dedups). Deposits below the $100 trigger never reach the leg, so they never
  snapshot — missed/ineligible days simply aren't recorded.

**The view.** `feeApr()` is an endpoint (point-to-point) measurement that scans the 35 slots
off-chain (free): for each window it finds the snapshot whose timestamp is the largest still
`≤ now − window`, then annualizes the realized growth by the **actual** elapsed time:

    bps = (perNow − perThen) / perThen × (365 days / elapsed) × 10_000      // via FullMath.mulDiv

So each figure is the **average fee-growth rate over the window, simple-annualized** (not a compounded
APY; base = the window-start L/share). It is path-independent — only the two endpoints matter, so
intra-window lumpiness is smoothed — and *trailing*: a fresh compound lifts `perNow` so the rate jumps
immediately, then ages out as the window slides. It reflects **compounded** fees only; pending /
unrealized fees live in `compoundClaimable()`.

**Gaps are handled; cadence sets the floor on ring size.** Because slots store real timestamps and the
view annualizes by actual elapsed, a gap — no triggering deposit for days, or claimable below the trigger — just means the
matched snapshot is older and the realized window is `≥` the label; never corrupted, never
double-counted. The one constraint runs the other way: `FEE_HISTORY_LEN` must **exceed the longest
window measured in daily-cadence days**, or under fast (≈daily) compounding the `≥30-day-old` snapshot
the 30d window needs is evicted exactly when it's required, and the 30d figure flickers to `0`. Hence
**35 = the 30d window + ~5 days of headroom**; sparse (quiet-market) cadence is unaffected — the ring
just spans a longer wall-clock period. A window with no snapshot old enough returns `0` (insufficient
history → the frontend shows `—`).

**Cost & trust.** Per compound: one `extsload` + at most one `SSTORE` per day (other compounds just
read `lastSnapshotDay` and skip); the 35-slot scan is a view, free off-chain. The ring is
**informational only** — no admin, write-once-per-day, touches no vault accounting; the only mutable
storage on the otherwise-immutable vault is `poolKey` (constructor), `inceptionTime` (write-once on
first deposit), and this ring. `block.timestamp` here is benign (daily granularity — nothing of value
depends on sub-day precision) and the post-unlock snapshot is a benign reentrancy pattern
(`nonReentrant`, flash-accounting already settled); both are suppressed at the linter with
justifications, so Solhint/Slither stay clean.

> **Read it as guidance, not a guarantee.** Short windows are cadence-dependent (sparse compounds
> widen the realized window past the label), it excludes pending fees, and it's a backward-looking
> average — not a forecast.

## Design decisions (settled)

- **Compound dust:** fold-forward (simplest; benign — strictly accretive to holders).
- **Quoter location:** off-chain (`scripts/lib/pool.js`), used by the frontend to size the
  ZapHelper's `swapUsdcToVlt` split + `minVltOut`. The actual route calldata (`swapData`) comes
  from the Uniswap Routing API; for production-grade `minShares` a frontend can `callStatic` the
  zap. The included split math (swap ≈ `D/(2−fee)`) leaves <2% dust in tests.
- **No keeper, no compound entrypoint:** the external write surface is `deposit` + `redeem`,
  full stop. Once claimable value reaches `AUTO_COMPOUND_MIN_USDC` ($100, ungoverned constant)
  and the position exists (the pre-seed gate — AUDIT.MD §7d M-01), the next deposit runs the
  internal `_compound()` leg before its own liquidity is measured; a small deposit is the
  manual compound in a quiet market. Deposit and compound share fate (a reverting leg reverts
  the triggering deposit — it is argument-free with hard internal bounds). Staleness is
  value-neutral, since deposit/redeem already retain accrued fees for all holders.
- **No compound fee:** 100% of every harvest (fresh pool fees + retained balances + prior
  dust) reinvests for holders. There is no finder/keeper cut of any kind; the triggering
  depositor simply pays the compound's gas, and the $100 trigger keeps that gas worthwhile
  relative to the amount reinvested.

## Remaining before mainnet

What this workspace does **not** yet do:

1. **Shieldify audit** — resolve findings, then re-run `npm test` (+ fork suite). Scope to flag:
   the V4 fee-settlement path (BUG-1) and that the `feesAccrued`/principal split is complete
   across every callback; the **deposit-triggered auto-compound** (see AUDIT.MD §7d: the
   internal `_compound()` leg with no external entrypoint, the shared-fate coupling — a
   reverting compound leg blocks threshold-crossing deposits — the M-01 pre-seed gate, the
   $100 trigger constant, and the donation-socialization semantics that replaced donation
   inertness); and the **ZapHelper / external-sourcing
   path** (deposit's dependency on VLT's external market, the
   arbitrary-`swapData`-to-whitelisted-router pattern, and MEV/slippage bounded by `minVltOut`).
   NOTE: `AUDIT.MD` §§1–7 line citations were pinned against `6d76648`; §7d covers the
   keeperless redesign. Re-run Slither (`npm run slither`) + the suite after any change.
2. **Mainnet pool init + deploy + verify** — requires a funded key + archive RPC; the scripts
   above are ready. Publish the vault address into the pitch's Parameters table afterward.

## Notes / caveats

- **Invariant harness scale:** this is a deterministic Hardhat property harness (3 seeds ×
  ~40 ops), not Foundry's thousands-of-runs invariant engine. It asserts the same four
  invariants but at smaller scale. A complementary Foundry `invariant_*` suite is recommended
  pre-audit if exhaustive fuzzing is desired.
- **Not yet independently audited** — do not deploy real funds before the Shieldify audit.
```
