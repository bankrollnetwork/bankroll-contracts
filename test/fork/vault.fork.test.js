// Optional mainnet-fork integration check. Enabled only with FORK=1 and a MAINNET_RPC_URL
// (see hardhat.config.js / .env). Runs:  npm run test:fork
//
// The local suite already exercises every settlement path against the REAL v4-core
// PoolManager *bytecode*. This adds confidence that the vault wires up against the actual
// DEPLOYED mainnet PoolManager — same singleton address, same on-chain storage layout
// (the StateLibrary read in positionLiquidity() must decode real PoolManager storage).
//
// A full deposit/redeem/compound cycle on the fork additionally needs the VLT/USDC pool
// to exist + be funded with real VLT and USDC. That requires impersonating funded holders
// (set VLT_WHALE / USDC_WHALE) or a created+seeded pool; left as an opt-in extension below.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { POOL_MANAGER, MAINNET, buildPoolKey, resolveConfig } = require("../../scripts/config");
const { readSqrtPriceX96 } = require("../../scripts/lib/pool");

const forkEnabled = process.env.FORK === "1" && !!hre.network.config.forking?.url;
const d = forkEnabled ? describe : describe.skip;

d("VltUsdcVault — mainnet fork integration", () => {
  it("deploys against the real deployed PoolManager and reads its storage", async () => {
    const code = await ethers.provider.getCode(POOL_MANAGER.mainnet);
    expect(code.length, "no code at the mainnet PoolManager singleton").to.be.greaterThan(2);

    const { poolKey, usdcIsCurrency0 } = buildPoolKey(MAINNET.vlt, MAINNET.usdc, 10000, 200);
    const [deployer] = await ethers.getSigners();

    const cfg = resolveConfig("mainnet");
    const Vault = await ethers.getContractFactory("VltUsdcVault");
    const vault = await Vault.deploy(POOL_MANAGER.mainnet, poolKey, MAINNET.usdc);
    await vault.waitForDeployment();

    // The ZapHelper is periphery — it points at the vault (not vice-versa).
    const Zap = await ethers.getContractFactory("ZapHelper");
    const zap = await Zap.deploy(cfg.router, cfg.permit2, vault.target);
    await zap.waitForDeployment();
    expect(await zap.vault()).to.equal(vault.target);

    expect(await vault.poolManager()).to.equal(ethers.getAddress(POOL_MANAGER.mainnet));
    expect(await vault.usdc()).to.equal(ethers.getAddress(MAINNET.usdc));
    expect(await vault.vlt()).to.equal(ethers.getAddress(MAINNET.vlt));
    expect(await vault.usdcIsCurrency0()).to.equal(usdcIsCurrency0);

    // StateLibrary read against the live PoolManager storage layout — no position yet.
    expect(await vault.positionLiquidity()).to.equal(0n);

    const sqrtP = await readSqrtPriceX96(POOL_MANAGER.mainnet, poolKey);
    if (sqrtP === 0n) {
      console.log("    (note) the VLT/USDC 1% pool is not initialized on mainnet at this block.");
    } else {
      console.log(`    VLT/USDC 1% pool is live on mainnet: sqrtPriceX96=${sqrtP}`);
    }
  });
});
