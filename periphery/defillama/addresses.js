// Local-harness address resolution ONLY. The submission copies (tvl/index.js, fees/index.ts)
// inline their constants — the DefiLlama repos take no env vars — so this file exists purely
// for periphery/defillama/test/run-fork.js to point the same logic at a fork deployment.
//
// Resolution order for the vault: VAULT_ADDRESS env → scripts/dev/.deployed.json (written by
// `npm run fork:setup`) → the TODO placeholder (which run-fork.js rejects with a clear error).

const fs = require("fs");
const path = require("path");

// Canonical mainnet constants (mirror scripts/config.js — a mainnet fork serves the same).
const VLT = "0x6b785a0322126826d8226d77e173d75dafb84d11"; // currency0 (18 decimals)
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // currency1 (6 decimals)
const POOL_MANAGER = "0x000000000004444c5dc75cb358380d2e3de08a90";

// TODO(deploy): replace with the deployed VltUsdcVault address, then propagate into
// tvl/index.js and fees/index.ts before submitting upstream.
const VAULT_PLACEHOLDER = "0x0000000000000000000000000000000000000000";

function resolveVault() {
  if (process.env.VAULT_ADDRESS && process.env.VAULT_ADDRESS.trim() !== "") {
    return process.env.VAULT_ADDRESS.trim();
  }
  const deployed = path.join(__dirname, "..", "..", "scripts", "dev", ".deployed.json");
  if (fs.existsSync(deployed)) {
    try {
      const j = JSON.parse(fs.readFileSync(deployed, "utf8"));
      if (j.vault) return j.vault;
    } catch (_) {}
  }
  return VAULT_PLACEHOLDER;
}

module.exports = { VLT, USDC, POOL_MANAGER, VAULT_PLACEHOLDER, resolveVault };
