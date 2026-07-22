// Single supervised launch entrypoint: preflight checks → (only with LAUNCH=yes) the full
// deploy pipeline 00 → 01 → zaphelper → 02 → 03 in one process, addresses flowing in memory —
// no .env round-trips between steps.
//
//   npm run launch:mainnet              # DRY RUN: preflight only, prints the board, no txs
//   LAUNCH=yes npm run launch:mainnet   # arms execution after a green preflight
//   npm run launch:rehearse             # same pipeline against a local fork (verify skipped)
//
// Safety properties:
//   - A bare invocation NEVER sends a transaction (LAUNCH=yes is the only arming switch).
//   - Price-drift guard: refuses to INITIALIZE a pool whose INIT_USDC_PER_VLT deviates from
//     the live external market (V2 VLT/WETH × V3 USDC/WETH) by more than LAUNCH_MAX_DRIFT_BPS
//     (default 200 = 2%) — a stale .env price can never set the pool price.
//   - Resume-safe: an already-initialized pool is skipped (like 00), an existing VAULT_ADDRESS /
//     ZAP_HELPER_ADDRESS is reused instead of redeployed, and the seed is skipped when the
//     vault already has supply — so a crashed run can be re-armed without double-deploying.
//   - The seed deadline anchors to the LATEST BLOCK's timestamp (not wall clock): correct on
//     mainnet and immune to the time-shifted clocks of long-lived dev forks.
//
// Reuses the same helpers as the step scripts (resolveConfig / buildPoolKey / readSqrtPriceX96 /
// encodeSqrtRatioX96), so this cannot drift from what the individual steps would do.

const fs = require("fs");
const hre = require("hardhat");
// PLAIN ethers for every transaction: hardhat-ethers' signer wrapper polls getTransaction on
// pending txs, and some RPCs (Alchemy) return `to: ""` for pending contract creations, which
// its formatter rejects — crashing the watcher AFTER a successful broadcast (observed live).
// Plain ethers builds the TransactionResponse from the signed tx and polls receipts only.
const { ethers } = require("ethers");
const { resolveConfig, buildPoolKey } = require("./config");
const { readSqrtPriceX96, priceUsdcPerVlt } = require("./lib/pool");
const { encodeSqrtRatioX96 } = require("../test/helpers/math");

// Mainnet reference venues for the live external VLT price (also present on mainnet forks).
const V2_VLT_WETH = "0x966053ca4fca049173eb1f27e4cb168ccb794534";
const V3_USDC_WETH = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const MAX_DRIFT_BPS = Number(process.env.LAUNCH_MAX_DRIFT_BPS || 200);
const MIN_ETH = ethers.parseEther("0.003"); // hard floor for the whole tx sequence

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
];

function fmt(x, d) {
  return ethers.formatUnits(x, d);
}

// Live external VLT price in USDC: V2 VLT/WETH reserves × V3 USDC/WETH spot. Returns null when
// the venues aren't readable (e.g. a mock-local chain) — callers treat that as "no reference".
async function liveExternalPrice(p) {
  try {
    const pair = new ethers.Contract(
      V2_VLT_WETH,
      ["function getReserves() view returns (uint112,uint112,uint32)", "function token0() view returns (address)"],
      p
    );
    const [r0, r1] = await pair.getReserves();
    const wethIs0 = (await pair.token0()).toLowerCase() === WETH;
    const wethR = wethIs0 ? r0 : r1;
    const vltR = wethIs0 ? r1 : r0;
    const v3 = new ethers.Contract(
      V3_USDC_WETH,
      ["function slot0() view returns (uint160 sqrtPriceX96, int24, uint16, uint16, uint16, uint8, bool)"],
      p
    );
    const s0 = await v3.slot0();
    const sp = Number(s0.sqrtPriceX96) / 2 ** 96;
    const ethUsd = (1 / (sp * sp)) * 1e12;
    return (Number(wethR) / Number(vltR)) * ethUsd;
  } catch (e) {
    return null;
  }
}

async function contractFactory(name, signer) {
  const art = await hre.artifacts.readArtifact(name);
  return new ethers.ContractFactory(art.abi, art.bytecode, signer);
}
async function contractAt(name, address, runner) {
  const art = await hre.artifacts.readArtifact(name);
  return new ethers.Contract(address, art.abi, runner);
}

async function main() {
  const armed = process.env.LAUNCH === "yes";
  const cfg = resolveConfig(hre.network.name);
  const { poolKey, usdcIsCurrency0 } = buildPoolKey(cfg.vlt, cfg.usdc, cfg.fee, cfg.tickSpacing);
  const url = hre.network.config.url;
  if (!url) throw new Error("launch.js needs an RPC-backed network (mainnet/sepolia/localhost).");
  const provider = new ethers.JsonRpcProvider(url);
  const isLive = hre.network.name === "mainnet" || hre.network.name === "sepolia";
  // Live networks sign locally with the deployer key; dev nodes use their unlocked account 0.
  const signer = isLive
    ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)
    : await provider.getSigner(0);
  const net = await provider.getNetwork();

  const usdc = new ethers.Contract(cfg.usdc, ERC20_ABI, signer);
  const vlt = new ethers.Contract(cfg.vlt, ERC20_ABI, signer);
  const usdcDec = Number(await usdc.decimals());
  const vltDec = Number(await vlt.decimals());

  // ── gather state ─────────────────────────────────────────────────────────
  const ethBal = await provider.getBalance(signer.address);
  const usdcBal = await usdc.balanceOf(signer.address);
  const vltBal = await vlt.balanceOf(signer.address);
  const poolSqrtP = await readSqrtPriceX96(cfg.poolManager, poolKey, provider);
  const poolInitialized = poolSqrtP !== 0n;
  const live = await liveExternalPrice(provider);

  const initPriceStr = process.env.INIT_USDC_PER_VLT;
  const seedUsdcStr = process.env.SEED_USDC;
  const seedVltStr = process.env.SEED_VLT;
  const seedUsdc = seedUsdcStr ? ethers.parseUnits(seedUsdcStr, usdcDec) : null;
  const seedVlt = seedVltStr ? ethers.parseUnits(seedVltStr, vltDec) : null;

  // ── preflight board ──────────────────────────────────────────────────────
  const checks = [];
  const check = (ok, name, detail, hard = true) => checks.push({ ok, name, detail, hard });

  check(true, "network", `${hre.network.name} (chainId ${net.chainId})`);
  check(true, "deployer", signer.address);
  check(ethBal >= MIN_ETH, "deployer ETH", `${fmt(ethBal, 18)} (floor ${fmt(MIN_ETH, 18)})`);
  check(!!process.env.ETHERSCAN_API_KEY, "etherscan key", process.env.ETHERSCAN_API_KEY ? "set" : "missing", isLive);
  check(true, "pool", poolInitialized
    ? `already initialized @ ~$${priceUsdcPerVlt(poolSqrtP, { usdcIsCurrency0, vltDecimals: vltDec, usdcDecimals: usdcDec }).toFixed(4)}/VLT (init step will be skipped)`
    : "not initialized (step 0 will set the price)");

  if (!poolInitialized) {
    check(!!initPriceStr, "INIT_USDC_PER_VLT", initPriceStr || "missing (required to initialize)");
    if (initPriceStr && live != null) {
      const driftBps = Math.abs((Number(initPriceStr) - live) / live) * 10000;
      check(driftBps <= MAX_DRIFT_BPS, "price drift",
        `init $${Number(initPriceStr).toFixed(4)} vs live $${live.toFixed(4)} → ${(driftBps / 100).toFixed(2)}% (max ${(MAX_DRIFT_BPS / 100).toFixed(2)}%)`);
    } else if (initPriceStr) {
      check(true, "price drift", "no live reference venue readable — SKIPPED (verify the price by hand)", false);
    }
  }

  const vaultSeeded = cfg.vaultAddress
    ? (await (await contractAt("VltUsdcVault", cfg.vaultAddress, provider)).totalSupply()) > 0n
    : false;
  if (!vaultSeeded) {
    check(!!(seedUsdc && seedVlt), "seed config", `SEED_USDC=${seedUsdcStr || "?"} SEED_VLT=${seedVltStr || "?"}`);
    if (seedUsdc && seedVlt) {
      check(usdcBal >= seedUsdc && vltBal >= seedVlt, "seed funding",
        `hold ${fmt(usdcBal, usdcDec)} USDC / ${fmt(vltBal, vltDec)} VLT vs seed ${seedUsdcStr}/${seedVltStr}`);
      const ref = Number(initPriceStr) || live;
      if (ref) {
        const ratio = (Number(seedVltStr) * ref) / Number(seedUsdcStr);
        check(true, "seed balance", `VLT side is ${(ratio * 100).toFixed(1)}% of the USDC side (imbalance refunds — not lost)`, false);
      }
    }
  } else {
    check(true, "seed", "vault already has supply — seed step will be skipped");
  }
  check(true, "reuse", `vault=${cfg.vaultAddress || "(deploy fresh)"} zapHelper=${cfg.zapHelper || "(deploy fresh)"}`);

  console.log("\n══ LAUNCH PREFLIGHT ═════════════════════════════════════════");
  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "✓" : c.hard ? "✗" : "⚠";
    if (!c.ok && c.hard) failed = true;
    console.log(` ${mark} ${c.name.padEnd(18)} ${c.detail}`);
  }
  console.log("═════════════════════════════════════════════════════════════");
  console.log(` plan: ${poolInitialized ? "" : "init pool → "}${cfg.vaultAddress ? "reuse vault" : "deploy vault"} → ${cfg.zapHelper ? "reuse helper" : "deploy helper"} → ${vaultSeeded ? "skip seed" : "seed"} → ${isLive ? "verify" : "skip verify (dev chain)"}`);

  if (failed) {
    console.error("\nPreflight FAILED — fix the ✗ items above. No transactions were sent.");
    process.exitCode = 1;
    return;
  }
  if (!armed) {
    console.log("\nDRY RUN complete (green board). Arm with LAUNCH=yes to execute.");
    return;
  }

  // ── execute ──────────────────────────────────────────────────────────────
  console.log("\n══ EXECUTING ════════════════════════════════════════════════");

  // Step 0: initialize the pool (exactly as 00_create_and_init_pool.js encodes it).
  if (!poolInitialized) {
    const price = Number(initPriceStr);
    const SCALE = 1_000_000_000n;
    const vltRef = 10n ** BigInt(vltDec);
    const usdcRef = (BigInt(Math.round(price * 1e9)) * 10n ** BigInt(usdcDec)) / SCALE;
    const amount0 = usdcIsCurrency0 ? usdcRef : vltRef;
    const amount1 = usdcIsCurrency0 ? vltRef : usdcRef;
    const sqrtPriceX96 = encodeSqrtRatioX96(amount1, amount0);
    const pm = await contractAt("IPoolManager", cfg.poolManager, signer);
    await (await pm.initialize(poolKey, sqrtPriceX96)).wait();
    console.log(`✓ pool initialized @ $${price}/VLT (sqrtPriceX96=${sqrtPriceX96})`);
  } else {
    console.log("• pool already initialized — skipped");
  }

  // Step 1: vault.
  let vaultAddr = cfg.vaultAddress;
  if (!vaultAddr) {
    const Vault = await contractFactory("VltUsdcVault", signer);
    const vault = await Vault.deploy(cfg.poolManager, poolKey, cfg.usdc);
    await vault.waitForDeployment();
    vaultAddr = vault.target;
    console.log(`✓ VltUsdcVault deployed: ${vaultAddr}`);
  } else {
    console.log(`• vault reused: ${vaultAddr}`);
  }

  // Step 1b: ZapHelper.
  let zapAddr = cfg.zapHelper;
  if (!zapAddr) {
    if (!cfg.router) throw new Error("No router for this network (ZAP_ROUTER_ADDRESS).");
    const Zap = await contractFactory("ZapHelper", signer);
    const zap = await Zap.deploy(cfg.router, cfg.permit2, vaultAddr);
    await zap.waitForDeployment();
    zapAddr = zap.target;
    console.log(`✓ ZapHelper deployed: ${zapAddr}`);
  } else {
    console.log(`• zapHelper reused: ${zapAddr}`);
  }

  // Step 2: seed (skipped when supply exists — resume-safe).
  const vault = await contractAt("VltUsdcVault", vaultAddr, signer);
  let seedTx = null;
  if ((await vault.totalSupply()) === 0n) {
    await (await vlt.approve(vaultAddr, seedVlt)).wait();
    await (await usdc.approve(vaultAddr, seedUsdc)).wait();
    // Deadline from the LATEST BLOCK, not wall clock (fork clocks drift; mainnet is equal).
    const blk = await provider.getBlock("latest");
    const deadline = BigInt(blk.timestamp) + 1800n;
    const previewShares = await vault.deposit.staticCall(seedVlt, seedUsdc, 0n, deadline, signer.address);
    if (previewShares <= 0n) throw new Error("Seed would not clear MINIMUM_LIQUIDITY — increase SEED amounts.");
    console.log(`  seed preview: ${previewShares} shares`);
    const rc = await (await vault.deposit(seedVlt, seedUsdc, 0n, deadline, signer.address)).wait();
    seedTx = rc.hash;
    console.log(`✓ seeded: tx ${rc.hash}`);
    console.log(`  position L = ${await vault.positionLiquidity()}  |  deployer vltUSDC = ${await vault.balanceOf(signer.address)}`);
  } else {
    console.log("• vault already seeded — skipped");
  }

  // Step 3: Etherscan verification (live networks only; lag-tolerant).
  if (isLive) {
    const keyTuple = [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks];
    for (const [name, address, args] of [
      ["VltUsdcVault", vaultAddr, [cfg.poolManager, keyTuple, cfg.usdc]],
      ["ZapHelper", zapAddr, [cfg.router, cfg.permit2, vaultAddr]],
    ]) {
      try {
        await hre.run("verify:verify", { address, constructorArguments: args });
        console.log(`✓ ${name} verified`);
      } catch (e) {
        const msg = String(e.message || e);
        if (/already verified/i.test(msg)) console.log(`• ${name} already verified`);
        else console.log(`⚠ ${name} verification failed (${msg.split("\n")[0]}) — retry later: npm run verify:vault`);
      }
    }
  } else {
    console.log("• dev chain — verification skipped");
  }

  // ── artifacts ────────────────────────────────────────────────────────────
  const blk = await provider.getBlock("latest");
  const record = {
    network: hre.network.name,
    chainId: Number(net.chainId),
    block: blk.number,
    timestamp: new Date(blk.timestamp * 1000).toISOString(),
    poolManager: cfg.poolManager,
    usdc: cfg.usdc,
    vlt: cfg.vlt,
    fee: cfg.fee,
    tickSpacing: cfg.tickSpacing,
    vault: vaultAddr,
    zapHelper: zapAddr,
    router: cfg.router,
    permit2: cfg.permit2,
    seedTx,
  };
  const outFile = `.deployed.${hre.network.name}.json`;
  fs.writeFileSync(outFile, JSON.stringify(record, null, 2) + "\n");

  console.log("\n══ DONE ═════════════════════════════════════════════════════");
  console.log(`record: ${outFile}`);
  console.log("\n.env lines:");
  console.log(`VAULT_ADDRESS=${vaultAddr}`);
  console.log(`ZAP_HELPER_ADDRESS=${zapAddr}`);
  console.log("\nclient Config panel JSON:");
  console.log(JSON.stringify({ vault: vaultAddr, zap: zapAddr }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
