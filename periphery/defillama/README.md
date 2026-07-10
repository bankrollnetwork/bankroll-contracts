# vltUSDC — DefiLlama adapters (TVL + Fees)

Submission-ready adapters for listing the vltUSDC vault on DefiLlama, plus a local harness
that exercises the exact same logic against this repo's mainnet-fork node **before** the
vault is deployed.

| File | Purpose | Upstream destination |
|---|---|---|
| `tvl/index.js` | TVL adapter (plain JS, self-contained) | [`DefiLlama-Adapters`](https://github.com/DefiLlama/DefiLlama-Adapters) → `projects/vltusdc/index.js` |
| `fees/index.ts` | Fees adapter (TypeScript, self-contained) | [`dimension-adapters`](https://github.com/DefiLlama/dimension-adapters) → `fees/vltusdc/index.ts` |
| `fees/index.local.js` | Plain-JS mirror of the fees fetch loop (local harness only — keep in sync with `index.ts`) | — |
| `addresses.js` | Local-harness address resolution (env / `.deployed.json`) | — |
| `test/mock-api.js`, `test/run-fork.js` | ChainApi/FetchOptions shims + end-to-end fork run | — |

## Accounting model (mirrors AUDIT.MD §7a)

- **TVL** = `vault.previewRedeem(vault.totalSupply())` (the VLT + USDC principal backing all
  shares) **+** the vault's ERC-20 balances of both tokens (fees retained awaiting compound).
  Pure view calls — no events, no indexing.
- **Fees** (from events alone): realized pool fees = Σ `Compound.fee0/fee1` + Σ `FeesRetained.fee0/fee1`.
- **SupplySideRevenue** = fees − Σ `Compound.finder0/finder1` (the 1% permissionless-keeper cut).
- **Revenue / ProtocolRevenue** = 0 — the vault is ownerless with no fee switch.
- Token ordering everywhere: `*0` = VLT (18 decimals), `*1` = USDC (6 decimals)
  (VLT `0x6b78…` < USDC `0xa0b8…` ⇒ VLT is currency0).

## Test locally against the fork (works today, pre-deployment)

```bash
# terminal 1
npm run fork:node
# terminal 2
npm run fork:setup     # deploys vault + zap on the fork, writes scripts/dev/.deployed.json
npm run fork:fees      # pushes volume through the pool → real Compound/FeesRetained events
# terminal 3 (from src/contracts)
npm run adapters:test  # = node periphery/defillama/test/run-fork.js
```

The harness prints TVL token balances (+USD via coins.llama.fi), runs the fees fetch over the
recent block range (`FROM_BLOCK` env to widen), and **asserts `finder == fee/100`** on every
`Compound` — the invariant the supply-side math relies on. `RPC_URL` / `VAULT_ADDRESS`
override the defaults (localhost:8545 / `.deployed.json`), so the same command validates the
real mainnet deployment later.

## Submission steps (after mainnet deploy)

**TVL first** (the fees listing keys off the protocol's TVL slug):

1. Fork `DefiLlama/DefiLlama-Adapters`; copy `tvl/index.js` → `projects/vltusdc/index.js`.
2. Fill the `TODO(deploy)` vault address; optionally set `start` to `vault.inceptionTime()`.
3. `node test.js projects/vltusdc/index.js` — verify the token amounts and USD total.
4. Open the PR (template asks name/category/chain/twitter; suggested category: Liquidity
   Manager or Yield).

**Fees second:**

1. Fork `DefiLlama/dimension-adapters`; copy `fees/index.ts` → `fees/vltusdc/index.ts`.
2. Fill the `TODO(deploy)` vault address and `start` date (deployment day).
3. `pnpm i && pnpm test fees vltusdc` — verify a day with known compounds.
4. Open the PR.

## Confirm at submission time

- [ ] Real vault address propagated into **both** submission copies (grep `TODO(deploy)`).
- [ ] `start` values filled (TVL: unix ts; fees: `YYYY-MM-DD`).
- [ ] VLT still priced by the coins server: `https://coins.llama.fi/prices/current/ethereum:0x6b785a0322126826d8226d77e173d75dafb84d11`
      (verified July 2026: ~$0.33, confidence 0.99, sourced from the V2 VLT/WETH pair). If it
      ever de-lists, request pricing via the coins repo before submitting TVL.
- [ ] `api.sumTokens` style: check a recently merged TVL PR for the current preferred helper
      (`api.sumTokens` vs `sumTokens2` from `helper/unwrapLPs`) and match it.
- [ ] `pullHourly` flag on the fees adapter: copy whatever a recently merged fees PR does for
      a low-activity protocol.
- [ ] Keeper-cut classification: we report the 1% finder cut inside `dailyFees` but outside
      `dailySupplySideRevenue`, with `dailyRevenue = 0`. Some Llama reviewers prefer keeper
      incentives inside `dailyRevenue` — if asked, move the finder sums there (one-line change).
- [ ] If `fees/index.ts` logic changed since this was written, sync `fees/index.local.js`.
