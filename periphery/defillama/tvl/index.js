// vltUSDC — DefiLlama TVL adapter.
//
// SUBMISSION COPY: paste this file verbatim as DefiLlama-Adapters/projects/vltusdc/index.js
// after filling in VAULT (TODO below). Self-contained by design — no imports beyond what the
// DefiLlama runner injects. Test upstream with: node test.js projects/vltusdc/index.js
//
// TVL = the two-token principal backing all outstanding shares — vault.previewRedeem(totalSupply())
// on the vault's single full-range Uniswap V4 VLT/USDC position — plus the VLT/USDC fee balances
// retained on the vault awaiting the next compound. Both tokens are held for real (no
// misrepresentedTokens flag needed). VLT is priced by the llama coins server from its Uniswap V2
// VLT/WETH market (verified ~$0.33, confidence 0.99, July 2026).

const VAULT = "0x0000000000000000000000000000000000000000"; // TODO(deploy): VltUsdcVault mainnet address
const VLT = "0x6b785a0322126826d8226d77e173d75dafb84d11"; // currency0, 18 decimals
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // currency1, 6 decimals

async function tvl(api) {
  // 1. Principal held as V4 position liquidity, valued in-kind by the vault's own preview.
  //    previewRedeem(totalSupply()) returns (amount0 = VLT, amount1 = USDC) raw; (0, 0) pre-seed.
  const supply = await api.call({ abi: "uint256:totalSupply", target: VAULT });
  const [amount0, amount1] = await api.call({
    abi: "function previewRedeem(uint256 shares) view returns (uint256 amount0, uint256 amount1)",
    target: VAULT,
    params: [supply],
  });
  api.add(VLT, amount0);
  api.add(USDC, amount1);

  // 2. Retained fees + compound dust sitting as plain ERC-20 balances on the vault.
  await api.sumTokens({ owner: VAULT, tokens: [VLT, USDC] });
}

module.exports = {
  methodology:
    "TVL is the VLT + USDC principal backing all outstanding vltUSDC shares (vault.previewRedeem(totalSupply()) on the vault's single full-range Uniswap V4 VLT/USDC 1% position), plus fee balances retained on the vault awaiting the next permissionless compound. The vault is ownerless: no admin, no protocol fee, no oracle.",
  // start: TODO(deploy) — vault inception unix timestamp (vault.inceptionTime() after first deposit).
  ethereum: { tvl },
};
