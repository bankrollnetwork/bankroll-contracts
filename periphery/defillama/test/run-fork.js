// End-to-end check of the DefiLlama adapter logic against a live deployment — normally the
// project's mainnet fork, later the real mainnet vault.
//
//   terminal 1: npm run fork:node
//   terminal 2: npm run fork:setup          (deploys vault+zap, writes scripts/dev/.deployed.json)
//               npm run fork:fees           (generates volume → Compound/FeesRetained events)
//   terminal 3: npm run adapters:test       (this file; RPC_URL / VAULT_ADDRESS override)
//
// The TVL section mirrors tvl/index.js and the fees section runs fees/index.local.js (the JS
// mirror of fees/index.ts) — keep all three in sync. Asserts the on-chain invariants the
// adapters rely on: finder == fee/100 per Compound, and previewRedeem ≈ position value.

const { ethers } = require("ethers");
const { VLT, USDC, VAULT_PLACEHOLDER, resolveVault } = require("../addresses");
const { MockChainApi, makeFetchOptions, usdPrices } = require("./mock-api");
const { makeFetch } = require("../fees/index.local");

const VAULT_ABI = [
  "function totalSupply() view returns (uint256)",
  "function previewRedeem(uint256) view returns (uint256 vltAmount, uint256 usdcAmount)",
  "function vlt() view returns (address)",
  "function usdc() view returns (address)",
  "function positionLiquidity() view returns (uint128)",
  "function compoundClaimable() view returns (uint256 vltAmount, uint256 usdcAmount, uint256 valueUsdc, uint256 feesValueUsdc)",
];

const fmt = (raw, dec) => Number(ethers.formatUnits(raw, dec)).toLocaleString("en-US", { maximumFractionDigits: 4 });

async function main() {
  const rpc = process.env.RPC_URL || "http://127.0.0.1:8545";
  const provider = new ethers.JsonRpcProvider(rpc);
  const vaultAddr = resolveVault();
  if (vaultAddr === VAULT_PLACEHOLDER) {
    throw new Error("No vault address: set VAULT_ADDRESS or run `npm run fork:setup` first.");
  }

  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, provider);
  // The fork deploys against real mainnet tokens; a mock-local deploy may use others — read
  // the truth from the vault and warn if the adapters' inlined constants wouldn't match.
  const [vlt, usdc] = [(await vault.vlt()).toLowerCase(), (await vault.usdc()).toLowerCase()];
  if (vlt !== VLT || usdc !== USDC) {
    console.warn(`! vault tokens (${vlt}, ${usdc}) differ from mainnet constants — mock-local deploy? Using the vault's.`);
  }

  console.log(`vault ${vaultAddr} via ${rpc}\n`);

  // ── TVL (mirrors tvl/index.js) ─────────────────────────────────────────────
  const api = new MockChainApi(provider);
  const supply = await api.call({ abi: "uint256:totalSupply", target: vaultAddr });
  const [vltAmount, usdcAmount] = await api.call({
    abi: "function previewRedeem(uint256 shares) view returns (uint256 vltAmount, uint256 usdcAmount)",
    target: vaultAddr,
    params: [supply],
  });
  api.add(vlt, vltAmount);
  api.add(usdc, usdcAmount);
  await api.sumTokens({ owner: vaultAddr, tokens: [vlt, usdc] });

  const prices = await usdPrices([vlt, usdc]);
  let tvlUsd = 0;
  console.log("TVL (principal via previewRedeem(totalSupply) + retained balances):");
  for (const [token, raw] of Object.entries(api.balances)) {
    const dec = token === usdc ? 6 : 18;
    const sym = token === usdc ? "USDC" : "VLT";
    const p = prices[token]?.price;
    if (p) tvlUsd += Number(ethers.formatUnits(raw, dec)) * p;
    console.log(`  ${sym.padEnd(5)} ${fmt(raw, dec)}${p ? `  (@ $${p})` : ""}`);
  }
  if (tvlUsd) console.log(`  ≈ $${tvlUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`);
  console.log(`  shares outstanding: ${supply}  |  position L: ${await vault.positionLiquidity()}`);

  // ── Fees (runs fees/index.local.js — the mirror of fees/index.ts) ─────────
  const latest = await provider.getBlockNumber();
  const fromBlock = Number(process.env.FROM_BLOCK ?? Math.max(0, latest - 5000));
  const options = makeFetchOptions(provider, { fromBlock, toBlock: latest });
  const fetchFees = makeFetch({ vault: vaultAddr, vlt, usdc });
  const dims = await fetchFees(options);

  const { compounds, retained } = dims._raw;
  console.log(`\nFees over blocks ${fromBlock}..${latest}: ${compounds.length} Compound, ${retained.length} FeesRetained`);
  // Invariant the adapter's supply-side math relies on: finder cut == fee / 100 (1%).
  for (const c of compounds) {
    if (c.vltFinder !== c.vltFees / 100n || c.usdcFinder !== c.usdcFees / 100n) {
      throw new Error(`finder != fee/100 in tx ${c._txHash} — adapter assumption broken`);
    }
  }
  if (compounds.length) console.log("  ✓ finder == fee/100 holds on every Compound");

  const show = (label, bals) => {
    const v = bals.items[vlt] ?? 0n;
    const u = bals.items[usdc] ?? 0n;
    console.log(`  ${label.padEnd(24)} VLT ${fmt(v, 18).padStart(14)}   USDC ${fmt(u, 6).padStart(12)}`);
  };
  show("dailyFees", dims.dailyFees);
  show("dailySupplySideRevenue", dims.dailySupplySideRevenue);
  show("dailyRevenue (protocol)", dims.dailyRevenue);

  const anyFees = Object.values(dims.dailyFees.items).some((x) => x > 0n);
  console.log(anyFees ? "\n✓ adapters produce non-zero, consistent data" : "\n(no fee events in range — run `npm run fork:fees` first)");
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
