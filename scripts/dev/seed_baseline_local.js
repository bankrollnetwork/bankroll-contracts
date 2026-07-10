// DEV ONLY. Seeds external baseline liquidity into the (now-initialized) local pool so the
// first deposit's entry swap has a counterparty. Uses the v4-core test modify-liquidity router.

const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("../config");
const { fullRangeTicks } = require("../../test/helpers/math");

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [dep] = await ethers.getSigners();

  const Router = await ethers.getContractFactory("PoolModifyLiquidityTest");
  const router = await Router.deploy(cfg.poolManager);
  await router.waitForDeployment();

  const erc = (a) =>
    new ethers.Contract(a, ["function approve(address,uint256) returns (bool)"], dep);
  await (await erc(cfg.usdc).approve(router.target, ethers.MaxUint256)).wait();
  await (await erc(cfg.vlt).approve(router.target, ethers.MaxUint256)).wait();

  const { tickLower, tickUpper } = fullRangeTicks(cfg.tickSpacing);
  await (
    await router.modifyLiquidity(
      poolKey,
      { tickLower, tickUpper, liquidityDelta: 10n ** 18n, salt: ethers.ZeroHash },
      "0x"
    )
  ).wait();

  console.log(`✓ seeded baseline liquidity via router ${router.target}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
