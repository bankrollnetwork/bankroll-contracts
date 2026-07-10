// Step 2: seed the first deposit directly into the vault with a balanced VLT + USDC pair.
//
// The first deposit must add liquidity > MINIMUM_LIQUIDITY (1000 L units); the script previews
// the resulting shares and warns if it looks too small. Bootstrapping is done with a direct
// deposit (operator supplies both tokens) — no routing dependency. Ongoing user deposits go
// through the periphery ZapHelper (USDC-only → it buys VLT and deposits).
//
//   VAULT_ADDRESS   the deployed vault
//   SEED_USDC       human USDC amount (e.g. 5000)
//   SEED_VLT        human VLT amount of ~equal value (e.g. 2500 at 2 USDC/VLT)

const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig } = require("./config");

async function erc20(addr) {
  return new ethers.Contract(
    addr,
    [
      "function decimals() view returns (uint8)",
      "function approve(address,uint256) returns (bool)",
      "function balanceOf(address) view returns (uint256)",
    ],
    (await ethers.getSigners())[0]
  );
}

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("Set VAULT_ADDRESS in .env");
  if (!process.env.SEED_USDC || !process.env.SEED_VLT) {
    throw new Error("Set SEED_USDC and SEED_VLT (human amounts of ~equal value) in .env");
  }

  const [signer] = await ethers.getSigners();
  const usdc = await erc20(cfg.usdc);
  const vlt = await erc20(cfg.vlt);
  const usdcAmount = ethers.parseUnits(String(process.env.SEED_USDC), Number(await usdc.decimals()));
  const vltAmount = ethers.parseUnits(String(process.env.SEED_VLT), Number(await vlt.decimals()));

  const vault = await ethers.getContractAt("VltUsdcVault", vaultAddress);

  console.log(`Seeding first deposit into vault ${vaultAddress}`);
  console.log(`  VLT=${vltAmount}  USDC=${usdcAmount}`);

  await (await vlt.approve(vaultAddress, vltAmount)).wait();
  await (await usdc.approve(vaultAddress, usdcAmount)).wait();

  // Stale-transaction guard: give the seed tx 30 minutes to land, then it expires.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  // Preview shares to sanity-check the first-deposit liquidity lock before committing.
  const previewShares = await vault.deposit.staticCall(vltAmount, usdcAmount, 0n, deadline);
  console.log(`  preview shares (ΔL - MINIMUM_LIQUIDITY) = ${previewShares}`);
  if (previewShares <= 0n) {
    throw new Error("First deposit would not exceed MINIMUM_LIQUIDITY — increase SEED amounts.");
  }

  const rc = await (await vault.deposit(vltAmount, usdcAmount, 0n, deadline)).wait();
  console.log(`✓ First deposit complete in tx ${rc.hash}`);
  console.log(`  vault position liquidity = ${await vault.positionLiquidity()}`);
  console.log(`  your vltUSDC balance     = ${await vault.balanceOf(signer.address)}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
