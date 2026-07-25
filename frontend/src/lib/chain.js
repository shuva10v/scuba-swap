/**
 * Chain access for the demo. Everything here reads the real chain — the design
 * brief forbids mock data anywhere a quote, gas figure or proof is displayed.
 *
 * Config comes from `deployments/demo.json`, written by `script/demo-up.sh`.
 * It is imported rather than hardcoded so a re-run of the demo script (which
 * produces new addresses) needs no code change.
 */

import { createPublicClient, createWalletClient, custom, http, defineChain } from "viem";
import demo from "../../../deployments/demo.json";

export const DEMO = demo;

/**
 * World Chain, as forked by anvil. Declared locally rather than imported from
 * viem/chains because the RPC must point at the local fork, and the chain id
 * must match what anvil reports (480) or wallet_switchEthereumChain fails.
 */
export const demoChain = defineChain({
  id: demo.chainId,
  name: "ScubaSwap demo (World Chain fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545"] } },
});

export const publicClient = createPublicClient({
  chain: demoChain,
  transport: http(),
});

export function walletClientFrom(provider) {
  return createWalletClient({ chain: demoChain, transport: custom(provider) });
}

// ---------------------------------------------------------------------------
// ABI — only what the UI calls.
//
// `quote` is declared non-payable rather than view because that is how SwapVM
// declares it; the contract is *intended* to be staticcalled (see FRICTION F-03),
// which viem's `simulateContract` does. Declaring it `view` here would be a lie
// about the on-chain signature and would produce the wrong selector.
// ---------------------------------------------------------------------------

const ORDER = {
  type: "tuple",
  components: [
    { name: "maker", type: "address" },
    { name: "traits", type: "uint256" },
    { name: "data", type: "bytes" },
  ],
};

export const routerAbi = [
  {
    type: "function",
    name: "quote",
    stateMutability: "nonpayable",
    inputs: [
      { name: "order", ...ORDER },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      { name: "order", ...ORDER },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
  { type: "function", name: "WORLD_ID_ACTION", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "WORLD_ID_RP_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  {
    type: "function",
    name: "spentProofs",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  // Custom errors, so a revert surfaces as a name instead of a raw selector.
  { type: "error", name: "WorldIdProofMissing", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "WorldIdProofExpired", inputs: [{ type: "uint64" }, { type: "uint256" }] },
  { type: "error", name: "WorldIdProofAlreadySpent", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "error", name: "WorldIdPolicyMalformed", inputs: [{ type: "uint256" }, { type: "uint256" }] },
  // World ID's own errors, so a verifier rejection is named rather than showing as
  // a bare selector. InvalidMerkleRoot in particular is the one a stale fork
  // produces, and it is otherwise very hard to attribute.
  { type: "error", name: "InvalidMerkleRoot", inputs: [] },
  { type: "error", name: "ProofInvalid", inputs: [] },
  { type: "error", name: "InvalidAction", inputs: [] },
  { type: "error", name: "UnregisteredIssuerSchemaId", inputs: [] },
];

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
];

/** Programs keyed by the depth band they back. */
export const PROGRAMS = {
  surface: { ...demo.programs.open, label: "Surface", depth: "0 m", feeLabel: "0.30%" },
  human: { ...demo.programs.tiered, label: "Human tier", depth: "−10 m", feeLabel: "0.05%" },
  reef: { ...demo.programs.humanOnly, label: "The reef", depth: "−30 m", feeLabel: "0.05%" },
};

export function orderTuple(program) {
  return { maker: program.maker, traits: BigInt(program.traits), data: program.data };
}

/**
 * Quote a program. Returns `{ amountOut }` or `{ error }` — a guarded program
 * refusing an unproven taker is a normal, expected outcome here, not an
 * exception, so it is returned as data rather than thrown.
 */
export async function quote({ program, amountIn, takerData, account }) {
  try {
    const { result } = await publicClient.simulateContract({
      address: DEMO.router,
      abi: routerAbi,
      functionName: "quote",
      args: [orderTuple(program), amountIn, takerData],
      account,
    });
    return { amountIn: result[0], amountOut: result[1], orderHash: result[2] };
  } catch (err) {
    return { error: decodeRevert(err) };
  }
}

/**
 * Turn a viem error into something a human can act on.
 *
 * Worth the effort: the guard's refusals are the most interesting thing the UI
 * can show, and by default they arrive as an unreadable selector buried in a
 * nested cause chain.
 */
export function decodeRevert(err) {
  const name = err?.cause?.data?.errorName ?? err?.walk?.((e) => e?.data?.errorName)?.data?.errorName;
  const args = err?.cause?.data?.args;

  switch (name) {
    case "WorldIdProofMissing":
      return { name, message: "No World ID proof supplied", detail: `guard wanted ${args?.[1]} bytes, got ${args?.[0]}` };
    case "WorldIdProofExpired":
      return { name, message: "Proof has expired", detail: "the verifier does not check this — ScubaSwap does" };
    case "WorldIdProofAlreadySpent":
      return { name, message: "Proof already used", detail: "one proof buys one swap" };
    case "WorldIdPolicyMalformed":
      return { name, message: "Program policy is malformed" };
    case "InvalidMerkleRoot":
      return {
        name,
        message: "World ID rejected the proof's Merkle root",
        detail: "the fork's identity tree is older than the proof — restart the demo chain at latest",
      };
    case "ProofInvalid":
      return { name, message: "World ID rejected the proof", detail: "signal, nonce or nullifier does not match" };
    case "InvalidAction":
      return { name, message: "Action mismatch", detail: "router's WORLD_ID_ACTION differs from the requested action" };
    case "UnregisteredIssuerSchemaId":
      return { name, message: "Credential schema not accepted by the verifier" };
    default: {
      const raw = err?.shortMessage ?? err?.message ?? "reverted";
      return { name: name ?? "Reverted", message: raw.split("\n")[0].slice(0, 160) };
    }
  }
}
