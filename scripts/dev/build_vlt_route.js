// DEV ONLY. Build Universal Router calldata for USDC -> VLT (USDC →V3 0.05%→ WETH →V2→ VLT),
// for use as ZAP_TEST_SWAPDATA in the fork test. Pure encoding, no network. The final output
// goes to MSG_SENDER (the helper that calls execute), so it's independent of the helper address.
//
//   node scripts/dev/build_vlt_route.js [amountInRaw]
const { AbiCoder, Interface, solidityPacked } = require("ethers");

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const VLT = "0x6b785a0322126826d8226d77e173d75dafb84d11";

// Universal Router constants.
const MSG_SENDER = "0x0000000000000000000000000000000000000001";
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
const CONTRACT_BALANCE = 1n << 255n; // "use the router's full balance of the input token"
const V3_SWAP_EXACT_IN = "00";
const V2_SWAP_EXACT_IN = "08";

const amountIn = BigInt(process.argv[2] || 10_000n * 10n ** 6n); // default 10,000 USDC
const deadline = 4102444800n; // year 2100 — comfortably future at any fork block

const coder = AbiCoder.defaultAbiCoder();

// Hop 1: V3 exact-in USDC -> WETH (0.05% = 500), output kept IN the router (ADDRESS_THIS),
// paid by the caller via Permit2 (payerIsUser = true).
const v3Path = solidityPacked(["address", "uint24", "address"], [USDC, 500, WETH]);
const v3Input = coder.encode(
  ["address", "uint256", "uint256", "bytes", "bool"],
  [ADDRESS_THIS, amountIn, 0n, v3Path, true]
);

// Hop 2: V2 exact-in WETH -> VLT, spending the router's full WETH balance from hop 1
// (payerIsUser = false), output to MSG_SENDER (the helper).
const v2Input = coder.encode(
  ["address", "uint256", "uint256", "address[]", "bool"],
  [MSG_SENDER, CONTRACT_BALANCE, 0n, [WETH, VLT], false]
);

const commands = "0x" + V3_SWAP_EXACT_IN + V2_SWAP_EXACT_IN;
const ur = new Interface(["function execute(bytes commands, bytes[] inputs, uint256 deadline)"]);
const swapData = ur.encodeFunctionData("execute", [commands, [v3Input, v2Input], deadline]);

console.log(`amountIn (USDC raw): ${amountIn}`);
console.log(`ZAP_TEST_SWAPDATA=${swapData}`);
