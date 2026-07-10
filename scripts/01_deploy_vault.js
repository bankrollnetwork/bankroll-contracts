// Step 1: deploy the VltUsdcVault against the (already-initialized) pool.
// Constructor: (IPoolManager, PoolKey, usdc). The vault is fully ownerless — no admin arg.

const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("./config");
const { readSqrtPriceX96 } = require("./lib/pool");

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [deployer] = await ethers.getSigners();

  // Guard: do not deploy a vault whose pool isn't initialized — every flow would revert.
  const price = await readSqrtPriceX96(cfg.poolManager, poolKey);
  if (price === 0n) {
    throw new Error("Pool is not initialized. Run scripts/00_create_and_init_pool.js first.");
  }

  console.log(`Network: ${cfg.networkName}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`PoolManager: ${cfg.poolManager}`);
  console.log(`USDC: ${cfg.usdc}  VLT: ${cfg.vlt}`);

  const Vault = await ethers.getContractFactory("VltUsdcVault");
  const vault = await Vault.deploy(cfg.poolManager, poolKey, cfg.usdc);
  await vault.waitForDeployment();

  console.log(`\n✓ VltUsdcVault deployed: ${vault.target}`);
  console.log(`  Set VAULT_ADDRESS=${vault.target} in .env, then run scripts/deploy_zaphelper.js.`);
  console.log(`  Verify with: npm run verify:vault  (network: ${cfg.networkName})`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
