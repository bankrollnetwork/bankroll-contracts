// Plain-JS mirror of fees/index.ts's fetch loop, for the local fork harness (no TS toolchain).
// fees/index.ts is the CANONICAL submission copy — if its logic changes, change this to match.
// Parameterized on addresses (unlike the submission copy) so the harness can target a fork deploy.

const COMPOUND_EVT =
  "event Compound(address indexed finder, uint256 fee0, uint256 fee1, uint256 finder0, uint256 finder1, uint128 liquidityAdded)";
const FEES_RETAINED_EVT = "event FeesRetained(uint256 fee0, uint256 fee1)";

// Returns an async (options) => dimensions function, same shape as the upstream adapter's fetch.
function makeFetch({ vault, vlt, usdc }) {
  return async function fetch(options) {
    const dailyFees = options.createBalances();
    const dailyRevenue = options.createBalances();
    const dailyProtocolRevenue = options.createBalances();
    const dailySupplySideRevenue = options.createBalances();

    const compounds = await options.getLogs({ target: vault, eventAbi: COMPOUND_EVT });
    const retained = await options.getLogs({ target: vault, eventAbi: FEES_RETAINED_EVT });

    compounds.forEach((log) => {
      dailyFees.add(vlt, log.fee0);
      dailyFees.add(usdc, log.fee1);
      dailySupplySideRevenue.add(vlt, log.fee0 - log.finder0);
      dailySupplySideRevenue.add(usdc, log.fee1 - log.finder1);
    });

    retained.forEach((log) => {
      dailyFees.add(vlt, log.fee0);
      dailyFees.add(usdc, log.fee1);
      dailySupplySideRevenue.add(vlt, log.fee0);
      dailySupplySideRevenue.add(usdc, log.fee1);
    });

    return { dailyFees, dailyRevenue, dailyProtocolRevenue, dailySupplySideRevenue, _raw: { compounds, retained } };
  };
}

module.exports = { makeFetch, COMPOUND_EVT, FEES_RETAINED_EVT };
