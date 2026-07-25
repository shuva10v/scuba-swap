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

/** The two live v4 verifier proxies on World Chain, by environment. */
export const VERIFIERS = {
  production: "0x00000000009E00F9FE82CfeeBB4556686da094d7",
  staging: "0x703a6316c975DEabF30b637c155edD53e24657DB",
};

/**
 * Deployments, keyed by World ID environment.
 *
 * There are two routers because staging and production are **separate identity
 * trees** and the verifier is a router immutable — one router can only ever serve
 * one environment. Testing both flows therefore needs two of everything downstream
 * of the verifier: two routers, two sets of shipped programs, two Aqua balances.
 *
 * The environment is not a free choice at proof time either. IDKit takes it as a
 * prop and the QR encodes a bridge URL for that environment, so the toggle has to
 * be set *before* gearing up — it selects which World App will answer, not just
 * which contract verifies.
 *
 * Accepts the older flat single-router config too. A deployment on disk from before
 * this change is still perfectly valid, and failing to load it would turn a config
 * shape difference into a broken page.
 */
export const ENVIRONMENTS = demo.environments ?? {
  [Object.entries(VERIFIERS).find(
    ([, addr]) => addr.toLowerCase() === (demo.worldIdVerifier ?? "").toLowerCase(),
  )?.[0] ?? "production"]: {
    router: demo.router,
    worldIdVerifier: demo.worldIdVerifier,
    programs: demo.programs,
  },
};

/** Environments this deployment actually has a router for. */
export const AVAILABLE_ENVIRONMENTS = Object.keys(ENVIRONMENTS);

// Each environment's router must actually point at that environment's verifier.
// Worth asserting rather than trusting: if the deploy wrote the staging verifier
// under the "production" key, every proof would be requested from the wrong World
// App and fail on the Merkle root — with the UI confidently naming the environment
// it believed it was on. A label that disagrees with the immutable is the one error
// this file cannot detect later.
for (const [name, env] of Object.entries(ENVIRONMENTS)) {
  const expected = VERIFIERS[name];
  if (expected && env.worldIdVerifier && expected.toLowerCase() !== env.worldIdVerifier.toLowerCase()) {
    throw new Error(
      `deployment config is inconsistent: environment "${name}" names verifier ` +
        `${env.worldIdVerifier}, but ${name} is ${expected}. Re-run the deploy script.`,
    );
  }
}

export const DEFAULT_ENVIRONMENT =
  demo.defaultEnvironment && ENVIRONMENTS[demo.defaultEnvironment]
    ? demo.defaultEnvironment
    : AVAILABLE_ENVIRONMENTS[0];

/**
 * World Chain, as forked by anvil. Declared locally rather than imported from
 * viem/chains because the RPC must point at the local fork, and the chain id
 * must match what anvil reports (480) or wallet_switchEthereumChain fails.
 */
/**
 * Where to read the chain.
 *
 * Recorded by the deploy rather than defaulted here, because a config and an RPC that
 * disagree produce a page where every quote fails and nothing explains why — and
 * `chainId` cannot catch it, since an anvil fork of World Chain also reports 480.
 *
 * `VITE_RPC_URL` still wins, which is how you point a mainnet deployment at a
 * dedicated provider: the depth panel issues one quote per band per amount change, so
 * a public endpoint is the thing most likely to rate-limit during a live demo.
 */
export const RPC_URL = import.meta.env.VITE_RPC_URL || demo.rpcUrl || "http://127.0.0.1:8545";

/** True when this deployment is real World Chain rather than a local fork. */
export const IS_MAINNET = !/127\.0\.0\.1|localhost/.test(RPC_URL);

export const demoChain = defineChain({
  id: demo.chainId,
  name: IS_MAINNET ? "World Chain" : "ScubaSwap demo (World Chain fork)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
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

/**
 * The pair, as roles rather than as sort positions.
 *
 * `isAToB` is a property of the deployment: SwapVM addresses the pair by sorted
 * order, and which of the two tokens sorts first depends entirely on the
 * addresses they landed at. Canonical WETH sorts before USDC on World Chain, so
 * hardcoding `isAToB: true` was correct for the local fork demo and wrong the
 * first time the demo tokens were deployed fresh — it would have sold the 6dp
 * token under a WETH label. The deploy records the roles; read them.
 */
export const PAIR = {
  sell: demo.weth,
  buy: demo.usdc,
  sellDecimals: demo.baseDecimals ?? 18,
  buyDecimals: demo.quoteDecimals ?? 6,
  isAToB: demo.weth.toLowerCase() === demo.tokenA.toLowerCase(),
};

/**
 * A fresh action for one dive.
 *
 * World ID issues at most one proof per (identity, rp, action), so reusing a
 * single action means a device that refuses to mint a second time — the
 * `nullifier_replayed` dead end. The router commits to a *prefix* instead, so
 * every dive names its own action and gets its own proof.
 *
 * The suffix only has to be unique per identity, and a second-resolution
 * timestamp is: World App requires a fresh liveness check per proof, which takes
 * far longer than a second. It is not a secret and does not need to be
 * unguessable — the nullifier and the taker-bound signal do that work.
 */
export function freshAction() {
  return `${demo.worldIdActionPrefix}-${Math.floor(Date.now() / 1000)}`;
}

/** Does `action` belong to this router's prefix? Mirrors `_isActionAllowed`. */
export function isActionAllowed(action) {
  return typeof action === "string" && action.startsWith(demo.worldIdActionPrefix);
}

/** Band presentation, shared across environments — only the programs differ. */
const BAND_META = {
  surface: { key: "open", label: "Surface", depth: "0 m", feeLabel: "0.30%" },
  human: { key: "tiered", label: "Human tier", depth: "−10 m", feeLabel: "0.05%" },
  reef: { key: "humanOnly", label: "The reef", depth: "−30 m", feeLabel: "0.05%" },
};

/**
 * Programs for one environment, keyed by the depth band they back.
 *
 * A function rather than a constant because the two routers ship their own orders:
 * the order hash commits to the router, so a production program is not a valid
 * order on the staging router and vice versa.
 */
export function programsFor(environment) {
  const env = ENVIRONMENTS[environment] ?? ENVIRONMENTS[DEFAULT_ENVIRONMENT];
  return Object.fromEntries(
    Object.entries(BAND_META).map(([band, meta]) => [band, { ...env.programs[meta.key], ...meta }]),
  );
}

/** Router address for one environment. */
export function routerFor(environment) {
  return (ENVIRONMENTS[environment] ?? ENVIRONMENTS[DEFAULT_ENVIRONMENT]).router;
}

export function orderTuple(program) {
  return { maker: program.maker, traits: BigInt(program.traits), data: program.data };
}

/**
 * Quote a program. Returns `{ amountOut }` or `{ error }` — a guarded program
 * refusing an unproven taker is a normal, expected outcome here, not an
 * exception, so it is returned as data rather than thrown.
 */
export async function quote({ router, program, amountIn, takerData, account }) {
  try {
    const { result } = await publicClient.simulateContract({
      address: router,
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
