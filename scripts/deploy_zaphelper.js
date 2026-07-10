// Deploy the periphery ZapHelper (run AFTER 01_deploy_vault.js — it points at the vault).
//
//   VAULT_ADDRESS        the deployed vault (the helper reads vlt()/usdc() from it)
//   ZAP_ROUTER_ADDRESS   swap router the helper executes routes against (defaults to the
//                        Universal Router on mainnet via config.js)
//   ZAP_PERMIT2_ADDRESS  Permit2 (defaults to canonical). Set to the zero address only for a
//                        router that pulls via a plain ERC-20 allowance.

const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig } = require("./config");

async function main() {
  const cfg = resolveConfig(hre.network.name);
  if (!cfg.router) {
    throw new Error("No router. Set ZAP_ROUTER_ADDRESS (no Universal Router default for this network).");
  }
  if (!cfg.vaultAddress) {
    throw new Error("VAULT_ADDRESS not set. Run scripts/01_deploy_vault.js first.");
  }

  console.log(`Network: ${cfg.networkName}`);
  console.log(`Vault:   ${cfg.vaultAddress}`);
  console.log(`Router:  ${cfg.router}`);
  console.log(`Permit2: ${cfg.permit2}`);

  const Zap = await ethers.getContractFactory("ZapHelper");
  const zap = await Zap.deploy(cfg.router, cfg.permit2, cfg.vaultAddress);
  await zap.waitForDeployment();

  console.log(`\n✓ ZapHelper deployed: ${zap.target}`);
  console.log(`  Set ZAP_HELPER_ADDRESS=${zap.target} in .env (used by the frontend for zap deposits).`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
