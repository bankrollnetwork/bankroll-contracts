// Step 3: verify the deployed vault on Etherscan.
//
// Reconstructs the exact constructor arguments from the live contract's own getters, so
// verification can never drift from what was actually deployed.
//
//   VAULT_ADDRESS   the deployed vault
//   ETHERSCAN_API_KEY must be set in .env

const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Set VAULT_ADDRESS in .env");

  const vault = await ethers.getContractAt("VltUsdcVault", vaultAddress);

  const poolManager = await vault.poolManager();
  const usdc = await vault.usdc();
  const key = await vault.poolKey();
  // Public PoolKey getter returns (currency0, currency1, fee, tickSpacing, hooks).
  const poolKey = {
    currency0: key.currency0,
    currency1: key.currency1,
    fee: key.fee,
    tickSpacing: key.tickSpacing,
    hooks: key.hooks,
  };

  console.log("Verifying vault with constructor args:");
  console.log("  poolManager:", poolManager);
  console.log("  poolKey:    ", poolKey);
  console.log("  usdc:       ", usdc);

  await hre.run("verify:verify", {
    address: vaultAddress,
    constructorArguments: [poolManager, poolKey, usdc],
  });

  // Verify the periphery ZapHelper too, if deployed (args read from the live contract).
  const zapHelper = process.env.ZAP_HELPER_ADDRESS;
  if (zapHelper) {
    const zap = await ethers.getContractAt("ZapHelper", zapHelper);
    const router = await zap.router();
    const permit2 = await zap.permit2();
    const vaultRef = await zap.vault();
    console.log(`\nVerifying ZapHelper ${zapHelper} (router=${router}, permit2=${permit2}, vault=${vaultRef})`);
    await hre.run("verify:verify", { address: zapHelper, constructorArguments: [router, permit2, vaultRef] });
  } else {
    console.log("\n(skipping ZapHelper verify — ZAP_HELPER_ADDRESS not set)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
