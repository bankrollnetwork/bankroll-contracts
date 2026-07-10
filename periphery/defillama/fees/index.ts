// vltUSDC — DefiLlama fees adapter (dimension-adapters).
//
// SUBMISSION COPY: paste this file verbatim as dimension-adapters/fees/vltusdc/index.ts after
// filling in VAULT and `start` (TODOs below). Test upstream with: pnpm i && pnpm test fees vltusdc
//
// Accounting (complete from vault events alone — see the repo's AUDIT.MD §7a):
//   realized pool fees      = Σ Compound.fee0/fee1  +  Σ FeesRetained.fee0/fee1
//   keeper (finder) payout  = Σ Compound.finder0/finder1   (1% of each fresh harvest)
//   supply-side revenue     = fees − finder payout          (auto-compounded to shareholders)
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
  "event Compound(address indexed finder, uint256 fee0, uint256 fee1, uint256 finder0, uint256 finder1, uint128 liquidityAdded)";
const FEES_RETAINED_EVT = "event FeesRetained(uint256 fee0, uint256 fee1)";

const fetch = async (options: FetchOptions) => {
  const dailyFees = options.createBalances();
  const dailyRevenue = options.createBalances(); // stays empty: no protocol take
  const dailyProtocolRevenue = options.createBalances(); // stays empty: no protocol take
  const dailySupplySideRevenue = options.createBalances();

  const compounds = await options.getLogs({ target: VAULT, eventAbi: COMPOUND_EVT });
  const retained = await options.getLogs({ target: VAULT, eventAbi: FEES_RETAINED_EVT });

  compounds.forEach((log: any) => {
    dailyFees.add(VLT, log.fee0);
    dailyFees.add(USDC, log.fee1);
    // The 1% finder cut goes to the permissionless keeper, not to shareholders.
    dailySupplySideRevenue.add(VLT, log.fee0 - log.finder0);
    dailySupplySideRevenue.add(USDC, log.fee1 - log.finder1);
  });

  retained.forEach((log: any) => {
    // Fees harvested-and-retained by deposits/redeems reinvest 100% (no finder cut).
    dailyFees.add(VLT, log.fee0);
    dailyFees.add(USDC, log.fee1);
    dailySupplySideRevenue.add(VLT, log.fee0);
    dailySupplySideRevenue.add(USDC, log.fee1);
  });

  return { dailyFees, dailyRevenue, dailyProtocolRevenue, dailySupplySideRevenue };
};

const methodology = {
  Fees: "Uniswap V4 VLT/USDC 1% pool trading fees realized by the vault's full-range position: Compound events report each harvest-and-reinvest in full (fee0/fee1), and FeesRetained events report fees swept to the vault when deposits/redeems touch the position.",
  SupplySideRevenue:
    "Realized fees minus the 1% finder cut paid to whoever calls the permissionless compound(); the remainder is auto-compounded into the position for all shareholders.",
  Revenue:
    "Zero. The vault is ownerless with no protocol fee switch. The only non-shareholder cut is the 1% keeper incentive (Compound.finder0/finder1), which is excluded from SupplySideRevenue and documented here.",
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
