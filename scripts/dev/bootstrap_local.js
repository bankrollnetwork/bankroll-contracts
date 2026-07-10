// DEV ONLY. Deploys a fresh PoolManager + mock VLT/USDC to a local node and writes their
// addresses into .env so the real 00→01→02 deploy scripts can run against them. Mirrors a
// chain where the pool exists but is not yet initialized.

const hre = require("hardhat");
const { ethers } = hre;
const fs = require("fs");
const path = require("path");

async function main() {
  const [dep] = await ethers.getSigners();

  const PM = await ethers.getContractFactory("PoolManager");
  const pm = await PM.deploy(dep.address);
  await pm.waitForDeployment();

  const Mock = await ethers.getContractFactory("MockERC20");
  const usdc = await Mock.deploy("USD Coin", "USDC", 6);
  await usdc.waitForDeployment();
  const vlt = await Mock.deploy("Vault", "VLT", 18);
  await vlt.waitForDeployment();

  // Fund the deployer so it can seed baseline liquidity + the first deposit.
  await (await usdc.mint(dep.address, 10n ** 18n)).wait(); // 1e12 USDC
  await (await vlt.mint(dep.address, 10n ** 30n)).wait(); // 1e12 VLT

  // Mock external VLT market. The ZapHelper is deployed AFTER the vault by deploy_zaphelper.js
  // (it points at the vault); here we just publish the mock as its router (permit2=0 => plain
  // allowance). The first deposit (02) is a direct VLT+USDC seed, so it doesn't need the helper.
  const MockRouter = await ethers.getContractFactory("MockSwapRouter");
  const mockRouter = await MockRouter.deploy(usdc.target, vlt.target);
  await mockRouter.waitForDeployment();
  await (await vlt.mint(mockRouter.target, 5_000_000n * 10n ** 18n)).wait();
  await (await usdc.mint(mockRouter.target, 2n * 5_000_000n * 10n ** 6n)).wait(); // ~2 USDC/VLT

  const env =
    [
      `POOL_MANAGER_ADDRESS=${pm.target}`,
      `USDC_ADDRESS=${usdc.target}`,
      `VLT_ADDRESS=${vlt.target}`,
      `INIT_USDC_PER_VLT=2`,
      `POOL_FEE=10000`,
      `TICK_SPACING=200`,
      `SEED_USDC=5000`,
      `SEED_VLT=2500`,
      `ZAP_ROUTER_ADDRESS=${mockRouter.target}`,
      `ZAP_PERMIT2_ADDRESS=0x0000000000000000000000000000000000000000`,
      `MOCK_ROUTER_ADDRESS=${mockRouter.target}`,
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "../../.env"), env);

  console.log("✓ bootstrap complete; wrote .env:\n" + env);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
