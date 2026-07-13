// vltUSDC — DefiLlama fees adapter (dimension-adapters).
//
// SUBMISSION COPY: paste this file verbatim as dimension-adapters/fees/vltusdc/index.ts after
// filling in VAULT and `start` (TODOs below). Test upstream with: pnpm i && pnpm test fees vltusdc
//
// Accounting (complete from vault events alone — see the repo's AUDIT.MD §7a):
//   realized pool fees      = Σ Compound.vltFees/usdcFees  +  Σ FeesRetained.vltFees/usdcFees
//   supply-side revenue     = the same total — 100% reinvests for shareholders (no fee of
//                             any kind; there is no keeper and no finder cut)
//   protocol revenue        = 0                              (ownerless vault, no fee switch)
//
// NOTE: keep the plain-JS mirror of this fetch loop (fees/index.local.js in the project repo)
// in sync if this logic changes — it drives the local fork test harness.

import { FetchOptions, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";

const VAULT = "0x0000000000000000000000000000000000000000"; // TODO(deploy): VltUsdcVault mainnet address
const VLT = "0x6b785a0322126826d8226d77e173d75dafb84d11"; // currency0, 18 decimals
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // currency1, 6 decimals

const COMPOUND_EVT =
  "event Compound(uint256 vltFees, uint256 usdcFees, uint128 liquidityAdded)";
const FEES_RETAINED_EVT = "event FeesRetained(uint256 vltFees, uint256 usdcFees)";

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances(); // stays empty: no protocol take
  const dailyProtocolRevenue = options.createBalances(); // stays empty: no protocol take
  const dailySupplySideRevenue = options.createBalances();

  const compounds = await options.getLogs({ target: VAULT, eventAbi: COMPOUND_EVT });
  const retained = await options.getLogs({ target: VAULT, eventAbi: FEES_RETAINED_EVT });

  // Both event kinds reinvest 100% for shareholders — fees and supply-side are identical.
  [...compounds, ...retained].forEach((log: any) => {
    dailyFees.add(VLT, log.vltFees);
    dailyFees.add(USDC, log.usdcFees);
    dailySupplySideRevenue.add(VLT, log.vltFees);
    dailySupplySideRevenue.add(USDC, log.usdcFees);
  });

  return { dailyFees, dailyRevenue, dailyProtocolRevenue, dailySupplySideRevenue };
};

const methodology = {
  Fees: "Uniswap V4 VLT/USDC 1% pool trading fees realized by the vault's full-range position: Compound events report each harvest-and-reinvest in full (vltFees/usdcFees), and FeesRetained events report fees swept to the vault when deposits/redeems touch the position.",
  SupplySideRevenue:
    "Equal to Fees: 100% of realized fees auto-compound into the position for shareholders. There is no keeper and no fee of any kind — compounding runs inside deposits.",
  Revenue:
    "Zero. The vault is ownerless with no protocol fee switch and takes no cut from any flow.",
  ProtocolRevenue: "Zero. No protocol take exists or can be added (immutable, ownerless vault).",
};

const adapter: SimpleAdapter = {
  version: 2,
  fetch,
  chains: [CHAIN.ETHEREUM],
  start: "2026-01-01", // TODO(deploy): vault deployment date (YYYY-MM-DD)
  methodology,
};

export default adapter;
