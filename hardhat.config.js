require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const {
  MAINNET_RPC_URL,
  SEPOLIA_RPC_URL,
  FORK_BLOCK_NUMBER,
  FORK,
  DEPLOYER_PRIVATE_KEY,
  MNEMONIC,
  ETHERSCAN_API_KEY,
} = process.env;

// Build the `accounts` field for live networks from a private key or a mnemonic.
// Returns undefined when neither is set, so `hardhat compile`/test never demand a key.
function liveAccounts() {
  if (DEPLOYER_PRIVATE_KEY && DEPLOYER_PRIVATE_KEY.trim() !== "") {
    return [DEPLOYER_PRIVATE_KEY.trim()];
  }
  if (MNEMONIC && MNEMONIC.trim() !== "") {
    return { mnemonic: MNEMONIC.trim() };
  }
  return undefined;
}

// Optional mainnet fork for the local `hardhat` network (enabled with FORK=1).
const forking =
  FORK === "1" && MAINNET_RPC_URL
    ? {
        url: MAINNET_RPC_URL,
        blockNumber: FORK_BLOCK_NUMBER ? Number(FORK_BLOCK_NUMBER) : undefined,
      }
    : undefined;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Uniswap V4 (PoolManager) overflows solc's stack without the IR pipeline.
      viaIR: true,
      // V4 relies on transient storage (TSTORE/TLOAD) and MCOPY.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      // V4 needs the Cancun opcodes available on the in-memory chain too.
      hardfork: "cancun",
      forking,
      // Generous balances so the property/invariant harness never runs dry.
      accounts: { count: 20 },
      // Two forked-node fixes (only when forking; non-forked local runs keep defaults):
      //  - blockGasLimit pinned to EDR's FIXED eth_call gas cap (16,777,216 = 2^24). A forked
      //    node otherwise inherits mainnet's ~60M block gas; an unspecified-gas call defaults to
      //    blockGasLimit and exceeds the cap, breaking every view call (deploy scripts + the
      //    browser client's web3 reads). At == the cap, view calls pass and init/deploy txs fit.
      //  - initialBaseFeePerGas: 0 — a forked node inherits mainnet's EIP-1559 base fee, and
      //    ethers' fee estimate can undershoot the next block's base fee ("maxFeePerGas too low").
      //    A 0 base fee stays 0 (12.5% adjustments of 0 are 0), so every tx's fee always covers it.
      //  - chainId: 1337 — matches the ubiquitous "localhost 8545" default that MetaMask/Ganache
      //    use, so the wallet's network matches the node and signed (write) txs pass EIP-155.
      //    (Non-forked local runs keep hardhat's 31337 default — the test suite doesn't care.)
      ...(forking ? { blockGasLimit: 16777216, initialBaseFeePerGas: 0, chainId: 1337 } : {}),
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    mainnet: {
      url: MAINNET_RPC_URL || "",
      chainId: 1,
      accounts: liveAccounts(),
    },
    sepolia: {
      url: SEPOLIA_RPC_URL || "",
      chainId: 11155111,
      accounts: liveAccounts(),
    },
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY || "",
  },
  mocha: {
    // Fork tests and the invariant harness can be slow.
    timeout: 300000,
  },
};
