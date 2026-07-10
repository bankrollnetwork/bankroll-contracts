# vltUSDC — Passive LP Yield with Built-in VLT Upside

**Deposit USDC and receive vltUSDC — a single token that lives in your wallet, earns auto-compounding trading-fee yield, and stays redeemable any time. Dampened exposure to VLT, with nothing to manage and nothing to trust.**

---

## How It Works

When you deposit USDC, the vault mints you **vltUSDC — a standard ERC-20 token sent straight to your wallet**. Your entire position is simply that token balance: you hold it yourself, and it's transferable and composable anywhere in DeFi. Underneath, your USDC sits in a VLT/USDC liquidity position earning a 1% fee on every trade, and those fees auto-reinvest so each token grows in value. Redeem any time to receive both underlying tokens back in kind — half of your value is available as USDC the moment you need it, with zero slippage.

## Why It's Different

- **Real yield, not emissions.** Returns come from actual trading volume, compounded — no inflationary rewards, no reflexive peg mechanics.
- **Lower-beta exposure.** Roughly half your capital sits in USDC, so you ride VLT's growth with materially less volatility than holding it outright.
- **Truly passive.** Auto-compounding, no rebalancing, no keeper to trust; anyone can trigger the compound for a small finder's fee.
- **Self-custodied and verifiable.** vltUSDC sits in your own wallet — never ours. Non-upgradeable, no oracle, hardcoded fee, and admin keys that can't touch deposits.
- **Self-reinforcing liquidity.** Protocol buy-flow and ecosystem fee routing deepen the pool, which captures more fees — compounding the compounding.
- **Variable yield and asset growth.** Both the fee yield and the token's value scale with market demand and trading activity — the more the pool is used, the more it compounds.
- **Asset-backed price.** vltUSDC's value is set by the real VLT/USDC pool it holds — not a promised peg. No algo tricks, no hidden leverage.

---

**The line:** vltUSDC turns VLT's trading activity into a passive, compounding return stream with half-anchored exposure and zero active management — a yield-and-growth vault you can fully verify and never have to babysit.

**Learn more and participate at [bankroll.network](https://bankroll.network).**

---

*This document is for informational purposes only. It is not an offer to sell or a solicitation to buy any security, nor financial, legal, or investment advice. Returns are not guaranteed and depend on trading volume and market conditions. Digital assets carry significant risk, including total loss of capital.*

---

# Use Case Overview — A Pillar of Bankroll Network

Bankroll Network is an on-chain financial cooperative built on one reserve asset, **VLT**. Its instruments stack into three reinforcing pillars — and vltUSDC is the income-and-growth layer that puts idle stablecoins to work.

- **Pillar 01 — VLT as store of value.** ETH concentrate and protocol-owned liquidity. The cooperative's reserve asset, backed by permanently locked liquidity.
- **Pillar 02 — VLT as collateral.** Borrow against VLT for on-chain credit — access liquidity without selling your position.
- **Pillar 03 — vltUSDC (this instrument).** Passive income and growth. Idle USDC becomes the cooperative's productive, deepest liquidity layer.

## Why It Outperforms a Standard LP

- **3.3× fees.** The 1% fee tier is the right rate for a volatile asset, and it earns 0.7 points more per trade than the 0.3% standard — 3.3× the fee rate. This is the single biggest reason returns here beat a generic V2-style LP.
- **One venue.** Every deposit aggregates into a single canonical VLT/USDC pool — the deepest market for VLT. That low-slippage depth is what lets the 1% fee capture trade flow rather than repel it.
- **POL flywheel.** Protocol-owned liquidity: ecosystem fee routing and buy-flow continuously deepen the pool, compounding volume and fees — depth a scatter of individual LPs can't match.

**The role:** vltUSDC pays holders while making VLT itself more tradeable for everyone — the cooperative's liquidity layer, not a private LP position.

---

# Technical Deep Dive — vltUSDC Under the Hood

## Architecture

vltUSDC is an ERC-20 share over a single full-range Uniswap V4 VLT/USDC position. Shares are denominated in the pool's **liquidity units (L)**, never in dollars — so no price oracle exists anywhere in the system. Your balance is a pro-rata claim on the position's liquidity, and redemption returns the underlying tokens directly.

## Core Flows

- **`deposit(usdc, swapToVlt, minVltOut, minShares)`** — Pulls USDC, swaps a slippage-bounded portion to VLT, adds liquidity, refunds dust, and mints shares pro-rata to the liquidity actually added (ΔL) — measured from the pool, not contract balances, which neutralizes donation and first-deposit inflation attacks.
- **`redeem(shares, minAmount0, minAmount1)`** — Burns shares, removes the pro-rata slice of liquidity, and returns both tokens in kind — no swap, no oracle, no forced sale. Cannot be rendered insolvent: you only ever withdraw what the position already holds.
- **`compound(swapAmountIn, zeroForOne, minOut)`** — Permissionless. Collects fees, pays the caller a hardcoded 1% finder's fee in kind, reinvests the remaining 99% as liquidity, and mints no new shares — so L rises against a fixed supply and every holder's redemption value grows automatically.

## Trust Model

- **Non-upgradeable.** No proxy, no migration path — the code that ships is the code that runs.
- **No admin keys on funds.** Owner can pause deposits and sweep stray tokens only — never USDC, VLT, or the position.
- **Solvent by construction.** Shares are liquidity claims; in-kind redemption can't exceed what's in the pool.
- **Oracle-free.** Liquidity-denominated shares plus in-kind exit remove every price-manipulation surface.
- **Hardened entrypoints.** Reentrancy guards, SafeERC20, checks-effects-interactions, first-deposit lock, slippage bounds on every swap.
- **Exit always open.** Redemption is never pausable.

## Risk Surface

- **Impermanent loss.** On large VLT moves the position underperforms holding the two tokens separately.
- **Underlying asset risk.** VLT is volatile with concentrated liquidity; price and depth risk apply.
- **Variable yield.** Fees track trading volume; quiet markets compound slower.
- **Deposit-swap exposure.** The USDC to VLT entry swap touches pool price, bounded by off-chain quote + on-chain minOut.
- **Smart-contract risk.** Independent audit by Shieldify prior to mainnet deployment.

## Parameters

| Parameter | Value |
|---|---|
| Chain · AMM | Ethereum mainnet · Uniswap V4 |
| Pool · fee tier · range | VLT/USDC · 1% · full range |
| Share unit | Pro-rata pool liquidity (L) — no fixed cap |
| Finder's fee | 1% of harvested fees, hardcoded |
| VLT token | 0x6b785a0322126826d8226d77e173d75DAfb84d11 |
| Vault contract | Published at deployment |
| Audit | Shieldify — in progress |

*Technical summary for evaluation only; not a specification or audit, and subject to change prior to deployment.*
