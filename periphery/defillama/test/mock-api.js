// Minimal shims of the DefiLlama runtime (sdk ChainApi + dimension-adapters FetchOptions),
// backed by an ethers v6 JsonRpcProvider, so the adapter logic can be exercised against the
// project's mainnet-fork node (or any RPC) without cloning the DefiLlama repos.
//
// Faithful to the small API surface the adapters use — nothing more:
//   ChainApi:     call({abi, target, params}), add(token, bal), sumTokens({owner, tokens})
//   FetchOptions: createBalances() -> { add }, getLogs({target, eventAbi}) -> named-args logs

const { ethers } = require("ethers");

const ERC20_BALANCE_ABI = ["function balanceOf(address) view returns (uint256)"];

// 'uint256:totalSupply' shorthand → a full human-readable fragment.
function toFragment(abi) {
  if (abi.startsWith("function ")) return abi;
  const [ret, name] = abi.split(":");
  return `function ${name}() view returns (${ret})`;
}

class MockChainApi {
  constructor(provider) {
    this.provider = provider;
    this.balances = {}; // token(lowercase) -> BigInt raw
  }

  async call({ abi, target, params = [] }) {
    const iface = new ethers.Interface([toFragment(abi)]);
    const frag = iface.fragments[0];
    const data = iface.encodeFunctionData(frag, params);
    const ret = await this.provider.call({ to: target, data });
    const decoded = iface.decodeFunctionResult(frag, ret);
    return decoded.length === 1 ? decoded[0] : decoded;
  }

  add(token, balance) {
    const k = token.toLowerCase();
    this.balances[k] = (this.balances[k] ?? 0n) + BigInt(balance);
  }

  async sumTokens({ owner, tokens }) {
    for (const t of tokens) {
      const erc20 = new ethers.Contract(t, ERC20_BALANCE_ABI, this.provider);
      this.add(t, await erc20.balanceOf(owner));
    }
    return this.balances;
  }
}

// A tiny balances accumulator mirroring sdk.Balances' add(); token amounts stay raw.
function createBalancesFactory() {
  return function createBalances() {
    const items = {};
    return {
      add(token, amount) {
        const k = token.toLowerCase();
        items[k] = (items[k] ?? 0n) + BigInt(amount);
      },
      items,
    };
  };
}

// FetchOptions shim: getLogs decodes with the event ABI and returns objects whose named
// fields work like upstream (log.vltFees, log.usdcFees, ...), each a BigInt.
function makeFetchOptions(provider, { fromBlock, toBlock }) {
  return {
    createBalances: createBalancesFactory(),
    async getLogs({ target, eventAbi }) {
      const iface = new ethers.Interface([eventAbi]);
      const event = iface.fragments[0];
      const logs = await provider.getLogs({
        address: target,
        topics: [iface.getEvent(event.name).topicHash],
        fromBlock,
        toBlock,
      });
      return logs.map((l) => {
        const parsed = iface.parseLog(l);
        const named = {};
        event.inputs.forEach((inp, i) => (named[inp.name] = parsed.args[i]));
        named._txHash = l.transactionHash;
        named._blockNumber = l.blockNumber;
        return named;
      });
    },
  };
}

// Best-effort USD valuation via the llama coins server (mainnet token addresses, so it works
// for fork data too). Returns null per token on any failure — the harness prints raw regardless.
async function usdPrices(tokens) {
  try {
    const keys = tokens.map((t) => `ethereum:${t.toLowerCase()}`).join(",");
    const res = await fetch(`https://coins.llama.fi/prices/current/${keys}`);
    const { coins } = await res.json();
    const out = {};
    for (const t of tokens) out[t.toLowerCase()] = coins[`ethereum:${t.toLowerCase()}`] ?? null;
    return out;
  } catch (_) {
    return Object.fromEntries(tokens.map((t) => [t.toLowerCase(), null]));
  }
}

module.exports = { MockChainApi, makeFetchOptions, usdPrices };
