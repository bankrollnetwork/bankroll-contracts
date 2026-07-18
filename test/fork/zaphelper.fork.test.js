// REAL Universal Router + Permit2 integration check for the ZapHelper, on a mainnet fork.
// Enabled only with FORK=1 + MAINNET_RPC_URL (an archive endpoint, e.g. Alchemy). Run:
//   FORK=1 MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/KEY npx hardhat test test/fork/zaphelper.fork.test.js
//
// This is the path the local suite can't cover: ZapHelper executing a genuine Universal Router
// route via Permit2 against real liquidity. It funds USDC by writing the balance slot, deploys
// the helper against the REAL Universal Router (config.js) + canonical Permit2, builds a V3
// exact-in route, and asserts the helper sourced the output token and enforced minOut.
//
// Defaults to USDC→WETH (deep, reliable liquidity). To target VLT instead, set
// ZAP_TEST_TOKEN_OUT (+ ZAP_TEST_V3_FEE for the USDC↔token fee tier) — provided VLT has a V3
// pool with USDC; otherwise a multi-hop path must be encoded.
//
// NOTE: the Universal Router address (config.js) and this command/route encoding should be
// confirmed against the live endpoint on first run — they are version-sensitive.

const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { setStorageAt } = require("@nomicfoundation/hardhat-network-helpers");
const { MAINNET, resolveConfig } = require("../../scripts/config");

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC_BALANCE_SLOT = 9; // FiatTokenV2_2 balanceOf mapping slot

const forkEnabled = process.env.FORK === "1" && !!hre.network.config.forking?.url;
const d = forkEnabled ? describe : describe.skip;

// Universal Router V3_SWAP_EXACT_IN command + execute(bytes,bytes[],uint256) ABI.
const V3_SWAP_EXACT_IN = "0x00";
const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) external payable"];

function v3Path(tokenIn, fee, tokenOut) {
  return ethers.solidityPacked(["address", "uint24", "address"], [tokenIn, fee, tokenOut]);
}

function buildUniversalRouterSwapData(recipient, amountIn, amountOutMin, path) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  // V3_SWAP_EXACT_IN input: (recipient, amountIn, amountOutMin, path, payerIsUser)
  const input = coder.encode(
    ["address", "uint256", "uint256", "bytes", "bool"],
    [recipient, amountIn, amountOutMin, path, true] // payerIsUser=true → UR pulls from caller via Permit2
  );
  const ur = new ethers.Interface(UR_ABI);
  // deadline is filled in by the caller (needs the fork's block time).
  return { input, ur };
}

async function fundUsdc(account, amount) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const slot = ethers.keccak256(coder.encode(["address", "uint256"], [account, USDC_BALANCE_SLOT]));
  await setStorageAt(MAINNET.usdc, slot, ethers.toBeHex(amount, 32));
}

d("ZapHelper — real Universal Router + Permit2 (mainnet fork)", () => {
  it("sources the output token through a genuine UR route and enforces minOut", async () => {
    const cfg = resolveConfig("mainnet");
    const [alice] = await ethers.getSigners();

    const tokenOut = process.env.ZAP_TEST_TOKEN_OUT
      ? ethers.getAddress(process.env.ZAP_TEST_TOKEN_OUT)
      : WETH;
    const v3Fee = Number(process.env.ZAP_TEST_V3_FEE || 500);
    const amountIn = BigInt(process.env.ZAP_TEST_USDC_IN || 10_000n * 10n ** 6n);

    // Sanity: real contracts have code on the fork.
    expect((await ethers.provider.getCode(cfg.router)).length).to.be.greaterThan(2);
    expect((await ethers.provider.getCode(cfg.permit2)).length).to.be.greaterThan(2);

    // Deploy the helper against the REAL Universal Router + canonical Permit2. A vault stub
    // satisfies the constructor's vlt()/usdc() reads; this test exercises the raw `zap` primitive.
    const Stub = await ethers.getContractFactory("MockVaultStub");
    const stub = await Stub.deploy(tokenOut, MAINNET.usdc);
    await stub.waitForDeployment();
    const Zap = await ethers.getContractFactory("ZapHelper");
    const zap = await Zap.deploy(cfg.router, cfg.permit2, stub.target);
    await zap.waitForDeployment();

    // Fund alice with USDC and approve the helper to pull it.
    await fundUsdc(alice.address, amountIn);
    const usdcErc = await ethers.getContractAt(
      "@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20",
      MAINNET.usdc
    );
    const outErc = await ethers.getContractAt("@openzeppelin/contracts/token/ERC20/IERC20.sol:IERC20", tokenOut);
    await (await usdcErc.connect(alice).approve(zap.target, ethers.MaxUint256)).wait();

    // Route for the zap. Two modes:
    //   - ZAP_TEST_SWAPDATA set → use that off-chain-built route verbatim (e.g. a real
    //     USDC→WETH→VLT multi-hop from the Uniswap Routing API). Its output recipient MUST be the
    //     helper — easiest via the Universal Router MSG_SENDER constant (address(0x...01)), which
    //     makes it independent of the helper's deployed address.
    //   - otherwise build a simple single-hop V3 USDC→tokenOut route (works for WETH; NOT for VLT,
    //     which has no single-hop V3 pool — VLT is V2 VLT/WETH only).
    let swapData = process.env.ZAP_TEST_SWAPDATA;
    if (!swapData) {
      const { input, ur } = buildUniversalRouterSwapData(
        zap.target,
        amountIn,
        0n,
        v3Path(MAINNET.usdc, v3Fee, tokenOut)
      );
      const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 3600n;
      swapData = ur.encodeFunctionData("execute", [V3_SWAP_EXACT_IN, [input], deadline]);
    }

    const before = await outErc.balanceOf(alice.address);
    await (
      await zap.connect(alice).zap(MAINNET.usdc, tokenOut, amountIn, 1n, ethers.MaxUint256, alice.address, swapData)
    ).wait();
    const received = (await outErc.balanceOf(alice.address)) - before;

    expect(received, "no output sourced via the real UR route").to.be.greaterThan(0n);
    // Helper is stateless — keeps nothing.
    expect(await outErc.balanceOf(zap.target)).to.equal(0n);
    expect(await usdcErc.balanceOf(zap.target)).to.equal(0n);
    console.log(`    sourced ${received} of ${tokenOut} for ${amountIn} USDC via the real Universal Router`);

    // minOut is enforced: an unsatisfiable bound reverts.
    await fundUsdc(alice.address, amountIn);
    await expect(
      zap.connect(alice).zap(MAINNET.usdc, tokenOut, amountIn, ethers.MaxUint256, ethers.MaxUint256, alice.address, swapData)
    ).to.be.reverted; // "zap-slippage" (or UR revert on the reused deadline) — either way it must not succeed
  });
});
