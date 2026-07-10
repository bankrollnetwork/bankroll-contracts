// DEV ONLY. One-shot fork setup: create+initialize the V4 pool, deploy the vault + ZapHelper,
// and fund DEV_ACCOUNT (your wallet) so you can connect on the fork WITHOUT importing a hardhat
// key. Run against a running forked node:
//   npm run fork:node        # terminal 1  (FORK=1 hardhat node)
//   npm run fork:setup       # terminal 2  (this script, --network localhost)
//
// .env knobs: DEV_ACCOUNT (your wallet — funded with ETH/USDC; the vault is ownerless),
// INIT_USDC_PER_VLT (pool price, e.g. 0.41), FUND_ETH (default 1000), FUND_USDC (default 1000000).
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { resolveConfig, buildPoolKey } = require("../config");
const { readSqrtPriceX96 } = require("../lib/pool");
const { encodeSqrtRatioX96 } = require("../../test/helpers/math");

async function erc20Decimals(addr) {
  const t = new ethers.Contract(addr, ["function decimals() view returns (uint8)"], ethers.provider);
  return Number(await t.decimals());
}

async function ensurePool(cfg, poolKey, usdcIsCurrency0) {
  const existing = await readSqrtPriceX96(cfg.poolManager, poolKey);
  if (existing > 0n) {
    console.log(`✓ pool already initialized (sqrtPriceX96=${existing})`);
    return;
  }
  let sqrtPriceX96;
  if (process.env.INIT_SQRT_PRICE_X96 && process.env.INIT_SQRT_PRICE_X96.trim() !== "") {
    sqrtPriceX96 = BigInt(process.env.INIT_SQRT_PRICE_X96.trim());
  } else if (process.env.INIT_USDC_PER_VLT && process.env.INIT_USDC_PER_VLT.trim() !== "") {
    const usdcPerVlt = Number(process.env.INIT_USDC_PER_VLT.trim());
    const vltDec = await erc20Decimals(cfg.vlt);
    const usdcDec = await erc20Decimals(cfg.usdc);
    const vltRef = 10n ** BigInt(vltDec);
    const SCALE = 1_000_000_000n;
    const usdcRef = (BigInt(Math.round(usdcPerVlt * 1e9)) * 10n ** BigInt(usdcDec)) / SCALE;
    const amount0 = usdcIsCurrency0 ? usdcRef : vltRef;
    const amount1 = usdcIsCurrency0 ? vltRef : usdcRef;
    sqrtPriceX96 = encodeSqrtRatioX96(amount1, amount0);
  } else {
    throw new Error("Set INIT_USDC_PER_VLT (or INIT_SQRT_PRICE_X96) to initialize the pool.");
  }
  console.log(`initializing pool at sqrtPriceX96=${sqrtPriceX96} …`);
  const pm = await ethers.getContractAt("IPoolManager", cfg.poolManager);
  await (await pm.initialize(poolKey, sqrtPriceX96)).wait();
  console.log("✓ pool initialized");
}

async function fund(account, usdcAddr) {
  const ethHuman = process.env.FUND_ETH || "1000";
  const usdcHuman = process.env.FUND_USDC || "1000000";
  const p = ethers.provider;
  await p.send("hardhat_setBalance", [account, ethers.toBeHex(ethers.parseEther(ethHuman))]);
  const raw = ethers.parseUnits(usdcHuman, 6);
  const slot = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [account, 9])
  );
  await p.send("hardhat_setStorageAt", [usdcAddr, slot, ethers.toBeHex(raw, 32)]);
  console.log(`✓ funded ${account}: ${ethHuman} ETH, ${usdcHuman} USDC`);
}

async function main() {
  const cfg = resolveConfig(hre.network.name);
  const { poolKey, usdcIsCurrency0 } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const [deployer] = await ethers.getSigners();

  const dev =
    process.env.DEV_ACCOUNT && process.env.DEV_ACCOUNT.trim() !== ""
      ? ethers.getAddress(process.env.DEV_ACCOUNT.trim())
      : null;

  if (!cfg.router) throw new Error("No router. Set ZAP_ROUTER_ADDRESS (or use the mainnet default).");
  console.log(`Network: ${cfg.networkName}  deployer: ${deployer.address}`);

  await ensurePool(cfg, poolKey, usdcIsCurrency0);

  // The vault is fully ownerless — no admin arg (DEV_ACCOUNT is only funded, not made owner).
  const Vault = await ethers.getContractFactory("VltUsdcVault");
  const vault = await Vault.deploy(cfg.poolManager, poolKey, cfg.usdc);
  await vault.waitForDeployment();

  const Zap = await ethers.getContractFactory("ZapHelper");
  const zap = await Zap.deploy(cfg.router, cfg.permit2, vault.target);
  await zap.waitForDeployment();

  // Fund the dev account (your wallet) — connect it on the fork with no key import. Falls back
  // to the deployer if DEV_ACCOUNT isn't set.
  await fund(dev || deployer.address, cfg.usdc);

  const out = {
    rpc: "http://127.0.0.1:8545",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    vault: vault.target,
    zapHelper: zap.target,
    usdc: cfg.usdc,
    vlt: cfg.vlt,
    router: cfg.router,
    permit2: cfg.permit2,
    devAccount: dev || deployer.address,
  };
  fs.writeFileSync(path.join(__dirname, ".deployed.json"), JSON.stringify(out, null, 2)); // for dev scripts (fork:simulate)
  console.log("\n✓ Fork ready. Paste vault + zapHelper into the test client Config panel:\n");
  console.log(JSON.stringify(out, null, 2));
  if (!dev) {
    console.log("\n(note) DEV_ACCOUNT not set — funded the deployer account. Set DEV_ACCOUNT=<your wallet> in .env to use your own wallet.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
