// DEV ONLY. Fund an account on the running forked node with ETH + USDC (USDC via the
// FiatTokenV2_2 balanceOf storage slot 9). VLT has no easy slot — obtain it via a zap.
//   npx hardhat run scripts/dev/fund_account.js --network localhost          # funds deployer
//   ACCOUNT=0x.. FUND_USDC=100000 FUND_ETH=100 npx hardhat run scripts/dev/fund_account.js --network localhost
const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig } = require("../config");

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const [signer] = await ethers.getSigners();
  const account = ethers.getAddress(process.env.ACCOUNT || signer.address);
  const usdcHuman = process.env.FUND_USDC || "100000";
  const ethHuman = process.env.FUND_ETH || "100";

  const p = ethers.provider;
  await p.send("hardhat_setBalance", [account, ethers.toBeHex(ethers.parseEther(ethHuman))]);

  const raw = ethers.parseUnits(usdcHuman, 6);
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, 9])
  );
  await p.send("hardhat_setStorageAt", [cfg.usdc, slot, ethers.toBeHex(raw, 32)]);

  console.log(`✓ funded ${account}: ${ethHuman} ETH, ${usdcHuman} USDC (${cfg.usdc})`);
  console.log("  VLT: use the test client's 'Buy VLT' (zap) or the seed flow.");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
