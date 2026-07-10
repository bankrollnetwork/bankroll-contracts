// DEV ONLY. On a mainnet fork, report where VLT has liquidity (V2 pairs + V3 pools) so we know
// what route the ZapHelper must take for USDC->VLT. Run: FORK=1 npx hardhat run scripts/dev/probe_vlt_liquidity.js
// Uses raw eth_call (no gas field) to avoid EDR's forked-block gas-limit cap.
const hre = require("hardhat");
const { ethers } = hre;

const VLT = "0x6b785a0322126826d8226d77e173d75dafb84d11";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const V3_FACTORY = "0x1f98431c8ad98523631ae4a59f267346ea31f984";

const iface = new ethers.Interface([
  "function getPair(address,address) view returns (address)",
  "function getPool(address,address,uint24) view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
]);

async function call(to, fn, args) {
  const data = iface.encodeFunctionData(fn, args);
  // Explicit gas under EDR's forked-call cap (it otherwise applies the 60M block gas).
  const ret = await ethers.provider.send("eth_call", [{ to, data, gas: "0xF42400" }, "latest"]);
  return iface.decodeFunctionResult(fn, ret);
}

async function main() {
  console.log(`VLT code present: ${(await ethers.provider.getCode(VLT)).length > 2}`);

  for (const [name, b] of [["VLT/WETH", WETH], ["VLT/USDC", USDC]]) {
    const [pair] = await call(V2_FACTORY, "getPair", [VLT, b]);
    if (pair === ethers.ZeroAddress) {
      console.log(`V2 ${name}: none`);
    } else {
      const [r0, r1] = await call(pair, "getReserves", []);
      const [t0] = await call(pair, "token0", []);
      console.log(`V2 ${name}: ${pair}  reserves=[${r0}, ${r1}]  token0=${t0}`);
    }
  }

  for (const fee of [500, 3000, 10000]) {
    for (const [name, b] of [["USDC/VLT", USDC], ["WETH/VLT", WETH]]) {
      const [pool] = await call(V3_FACTORY, "getPool", [VLT, b, fee]);
      console.log(`V3 ${name} @${fee}: ${pool === ethers.ZeroAddress ? "none" : pool}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
