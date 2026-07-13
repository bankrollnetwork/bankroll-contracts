// Plain-JS mirror of fees/index.ts's fetch loop, for the local fork harness (no TS toolchain).
// fees/index.ts is the CANONICAL submission copy — if its logic changes, change this to match.
// Parameterized on addresses (unlike the submission copy) so the harness can target a fork deploy.

const COMPOUND_EVT =
  "event Compound(uint256 vltFees, uint256 usdcFees, uint128 liquidityAdded)";
const FEES_RETAINED_EVT = "event FeesRetained(uint256 vltFees, uint256 usdcFees)";

// Returns an async (options) => dimensions function, same shape as the upstream adapter's fetch.
function makeFetch({ vault, vlt, usdc }) {
  return async function fetch(options) {
    const dailyFees = options.createBalances();
    const dailyRevenue = options.createBalances();
    const dailyProtocolRevenue = options.createBalances();
    const dailySupplySideRevenue = options.createBalances();

    const compounds = await options.getLogs({ target: vault, eventAbi: COMPOUND_EVT });
    const retained = await options.getLogs({ target: vault, eventAbi: FEES_RETAINED_EVT });

    // Both event kinds reinvest 100% for shareholders — fees and supply-side are identical.
    [...compounds, ...retained].forEach((log) => {
      dailyFees.add(vlt, log.vltFees);
      dailyFees.add(usdc, log.usdcFees);
      dailySupplySideRevenue.add(vlt, log.vltFees);
      dailySupplySideRevenue.add(usdc, log.usdcFees);
    });

    return { dailyFees, dailyRevenue, dailyProtocolRevenue, dailySupplySideRevenue, _raw: { compounds, retained } };
  };
}

module.exports = { makeFetch, COMPOUND_EVT, FEES_RETAINED_EVT };
