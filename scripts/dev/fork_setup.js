// DEV ONLY. Deploy the vault + ZapHelper against a running forked node in ONE process (no
// VAULT_ADDRESS copy-paste between 01 and deploy_zaphelper) and print a paste-ready config
// JSON for the test client (src/vltUSDC.html). Run the pool-init FIRST:
//   FORK=1 FORK_BLOCK_NUMBER=25217000 npx hardhat node          # terminal 1
//   npx hardhat run scripts/00_create_and_init_pool.js --network localhost
//   npx hardhat run scripts/dev/fork_setup.js --network localhost
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("../config");
const { readSqrtPriceX96 } = require("../lib/pool");

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [deployer] = await ethers.getSigners();

  if (!cfg.router) throw new Error("No router. Set ZAP_ROUTER_ADDRESS (or use mainnet default).");
  const price = await readSqrtPriceX96(cfg.poolManager, poolKey);
  if (price === 0n) {
    throw new Error("Pool not initialized. Run scripts/00_create_and_init_pool.js --network localhost first.");
  }

  const Vault = await ethers.getContractFactory("VltUsdcVault");
  const vault = await Vault.deploy(cfg.poolManager, poolKey, cfg.usdc); // ownerless — no admin arg
  await vault.waitForDeployment();

  const Zap = await ethers.getContractFactory("ZapHelper");
  const zap = await Zap.deploy(cfg.router, cfg.permit2, vault.target);
  await zap.waitForDeployment();

  const out = {
    rpc: "http://127.0.0.1:8545",
    vault: vault.target,
    zapHelper: zap.target,
    usdc: cfg.usdc,
    vlt: cfg.vlt,
    router: cfg.router,
    permit2: cfg.permit2,
  };
  fs.writeFileSync(path.join(__dirname, ".deployed.json"), JSON.stringify(out, null, 2)); // for dev scripts (fork:simulate)
  console.log("\n✓ Vault + ZapHelper deployed. Paste vault + zapHelper into the test client Config panel:\n");
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
