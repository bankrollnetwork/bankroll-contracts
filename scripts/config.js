// Network-aware deployment config. Env vars always win; otherwise fall back to the
// canonical mainnet values from the pitch. Throws for anything required-but-missing on
// a live network so a deploy never proceeds half-configured.

const { ethers } = require("hardhat");

// Canonical Uniswap V4 PoolManager singletons. VERIFY against the current Uniswap
// deployment docs before a real deploy — these are pinned here for convenience.
// Stored lowercase; ethers.getAddress() re-checksums (avoids brittle hand-typed EIP-55 casing).
const POOL_MANAGER = {
  mainnet: "0x000000000004444c5dc75cb358380d2e3de08a90",
  sepolia: "0xe03a1074c86cfedd5c142c4f04f1a1536e203543",
};

// Mainnet token addresses (USDC canonical; VLT from the vltUSDC pitch).
const MAINNET = {
  usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  vlt: "0x6b785a0322126826d8226d77e173d75dafb84d11",
};

// ZapHelper router targets. Permit2 is canonical (same address on every chain). The Universal
// Router address MUST be verified against Uniswap's current deployment docs before a real deploy.
const PERMIT2 = "0x000000000022d473030f116ddee9f6b43ac78ba3";
const UNIVERSAL_ROUTER = {
  // Verified against Uniswap's v4 deployments docs (developers.uniswap.org/contracts/v4/deployments,
  // Jul 2026): this is the current mainnet Universal Router (v2 / v4-capable; also serves the V2+V3
  // legs the zap uses). A newer point release, UR 2.1.1, lives at
  // 0x4c82d1fbfe28c977cbb58d8c7ff8fcf9f70a2cca — switch only if a route needs it (the fork suite is
  // validated against the address below). Re-verify the docs before the actual deploy.
  mainnet: "0x66a9893cc07d91d95644aedd05d03f95e1dba8af",
};

function pick(...vals) {
  for (const v of vals) if (v && String(v).trim() !== "") return String(v).trim();
  return undefined;
}

// Resolve and validate all parameters for `networkName` (hre.network.name).
function resolveConfig(networkName) {
  const env = process.env;
  // A forked `localhost`/`hardhat` node IS mainnet, so default to the mainnet addresses there
  // too. Explicit env vars always win (the mock-local bootstrap sets them), so that path is
  // unaffected; this just lets the mainnet-fork-via-localhost flow work with no extra config.
  const useMainnetDefaults =
    networkName === "mainnet" || networkName === "localhost" || networkName === "hardhat";

  const poolManager = pick(
    env.POOL_MANAGER_ADDRESS,
    POOL_MANAGER[networkName],
    useMainnetDefaults ? POOL_MANAGER.mainnet : undefined
  );
  const usdc = pick(env.USDC_ADDRESS, useMainnetDefaults ? MAINNET.usdc : undefined);
  const vlt = pick(env.VLT_ADDRESS, useMainnetDefaults ? MAINNET.vlt : undefined);
  const fee = Number(pick(env.POOL_FEE) || 10000);
  const tickSpacing = Number(pick(env.TICK_SPACING) || 200);

  // ZapHelper deps. router defaults to the Universal Router; permit2 to canonical (set
  // ZAP_PERMIT2=0x0 only if your router pulls via plain allowance, e.g. a test router).
  const router = pick(
    env.ZAP_ROUTER_ADDRESS,
    UNIVERSAL_ROUTER[networkName],
    useMainnetDefaults ? UNIVERSAL_ROUTER.mainnet : undefined
  );
  const permit2 = pick(env.ZAP_PERMIT2_ADDRESS, PERMIT2);
  const vaultAddress = pick(env.VAULT_ADDRESS); // set after 01_deploy_vault.js
  const zapHelper = pick(env.ZAP_HELPER_ADDRESS); // set after deploy_zaphelper.js

  const missing = [];
  if (!poolManager) missing.push("POOL_MANAGER_ADDRESS");
  if (!usdc) missing.push("USDC_ADDRESS");
  if (!vlt) missing.push("VLT_ADDRESS");
  if (missing.length) {
    throw new Error(
      `Missing config for network "${networkName}": ${missing.join(", ")}. ` +
        `Set them in .env (mainnet has built-in defaults).`
    );
  }

  return {
    networkName,
    poolManager: ethers.getAddress(poolManager),
    usdc: ethers.getAddress(usdc),
    vlt: ethers.getAddress(vlt),
    fee,
    tickSpacing,
    router: router ? ethers.getAddress(router) : undefined,
    permit2: permit2 ? ethers.getAddress(permit2) : ethers.ZeroAddress,
    vaultAddress: vaultAddress ? ethers.getAddress(vaultAddress) : undefined,
    zapHelper: zapHelper ? ethers.getAddress(zapHelper) : undefined,
  };
}

// Build the V4 PoolKey from the token addresses, enforcing currency0 < currency1
// (the same ordering the vault constructor requires). hooks is address(0).
function buildPoolKey(vlt, usdc, fee, tickSpacing) {
  const a = ethers.getAddress(vlt);
  const b = ethers.getAddress(usdc);
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return {
    poolKey: { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress },
    usdcIsCurrency0: BigInt(b) === BigInt(currency0),
  };
}

module.exports = { resolveConfig, buildPoolKey, POOL_MANAGER, MAINNET };
