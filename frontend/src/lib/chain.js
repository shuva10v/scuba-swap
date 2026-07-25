/**
 * Chain access for the demo. Everything here reads the real chain — the design
 * brief forbids mock data anywhere a quote, gas figure or proof is displayed.
 *
 * Config comes from `deployments/demo.json`, written by `script/demo-up.sh`.
 * It is imported rather than hardcoded so a re-run of the demo script (which
 * produces new addresses) needs no code change.
 */

import { createPublicClient, createWalletClient, custom, http, defineChain, keccak256 } from "viem";
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
  // Canonical Multicall3, verified deployed on World Chain. Declared because we define
  // this chain by hand rather than importing viem's, and without it viem cannot batch.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const publicClient = createPublicClient({
  chain: demoChain,
  transport: http(),
  // Coalesce concurrent reads into one multicall. The page polls quotes and balances
  // every few seconds, and a public RPC is the most likely thing to rate-limit at the
  // worst moment — batching keeps that to one request per tick instead of five.
  batch: { multicall: true },
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
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
];

/**
 * The pair, as roles rather than as sort positions.
 *
 * SwapVM addresses the pair by sorted order and picks the direction with a single
 * `isAToB` bit, so which token you are selling is positional. Which of the two sorts
 * first depends entirely on the addresses they landed at — canonical WETH sorts before
 * USDC on World Chain, so hardcoding `isAToB: true` was correct for the fork demo and
 * wrong the first time the demo tokens were deployed fresh. The deploy records the
 * roles; read them.
 *
 * Symbols come from the deployment too. The demo pair is dWETH/dUSDC, so labelling the
 * UI "WETH"/"USDC" would name tokens that are not the ones being traded.
 */
export const TOKENS = {
  base: {
    address: demo.weth,
    decimals: demo.baseDecimals ?? 18,
    symbol: demo.baseSymbol ?? "WETH",
    dot: "var(--hull)",
  },
  quote: {
    address: demo.usdc,
    decimals: demo.quoteDecimals ?? 6,
    symbol: demo.quoteSymbol ?? "USDC",
    dot: "#2775ca",
  },
};

/**
 * Which side is being sold, for a given direction.
 *
 * `flipped` sells the quote token instead of the base one. `isAToB` is derived rather
 * than stored because it means "the token I am selling is tokenA" — a fact about this
 * deployment's sort order combined with the chosen direction, not a constant.
 */
export function sidesFor(flipped) {
  const sell = flipped ? TOKENS.quote : TOKENS.base;
  const buy = flipped ? TOKENS.base : TOKENS.quote;
  return { sell, buy, isAToB: sell.address.toLowerCase() === demo.tokenA.toLowerCase() };
}

/** Block explorer for World Chain. Only meaningful for a mainnet deployment. */
export const EXPLORER = "https://worldscan.org";

/**
 * Explorer link for an address, or null on a local fork — worldscan has no view of a
 * fork, so linking there would point at an address it has never seen.
 */
export function explorerAddress(address) {
  return IS_MAINNET && address ? `${EXPLORER}/address/${address}` : null;
}

/**
 * The dWETH faucet, or null if this deployment has none.
 *
 * Front-ends the base token because that is what a visitor needs before they can trade at
 * all — the quote side is reachable by swapping, so one faucet is enough.
 */
export const FAUCET = demo.faucet ?? null;

export const faucetAbi = [
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "AMOUNT", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "waitFor",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  // Carries the timestamp the caller may next claim at, so a rejection can be rendered as
  // a countdown without a second call.
  { type: "error", name: "ClaimTooSoon", inputs: [{ type: "uint256" }] },
];

/**
 * A fresh action for one dive.
 *
 * World ID issues at most one proof per (identity, rp, action), so reusing a single
 * action means a device that refuses to mint a second time — the `nullifier_replayed`
 * dead end. The router commits to a *prefix* instead, so every dive names its own
 * action and gets its own proof.
 *
 * The suffix only has to be unique per identity, and a second-resolution timestamp is:
 * World App requires a fresh liveness check per proof, which takes far longer than a
 * second. It is not a secret and does not need to be unguessable — the nullifier and
 * the taker-bound signal do that work.
 */
export function freshAction() {
  return `${demo.worldIdActionPrefix}-${Math.floor(Date.now() / 1000)}`;
}

/** Does `action` belong to this router's prefix? Mirrors `_isActionAllowed`. */
export function isActionAllowed(action) {
  return typeof action === "string" && action.startsWith(demo.worldIdActionPrefix);
}

/**
 * The credentials this deployment can verify on-chain.
 *
 * `issuerSchemaId` is the dial: it is already maker policy in every guard program, so a
 * passport tier needed no contract change. Both ids were probed against the live verifier —
 * 1 and 9303 are registered. 9303 is ICAO 9303, the passport standard.
 *
 * `tank` (jurisdiction) is absent deliberately. Nationality and age are `identityCheck`
 * *attributes*, and `verify()` has no attribute parameter, so they are attested only in
 * off-chain JSON — the same gap as the presence bit in W-04. A contract can require
 * "holds a passport"; it cannot require "is over 18".
 */
/**
 * `hashToField(abi.encodePacked(address))` — what the guard derives from `ctx.query.taker`
 * and hands to the verifier as `signalHash`.
 *
 * Exported so the client can check whether a returned proof is actually bound to the taker.
 * It matters for the mask: `identityCheck` exposes no `signal` parameter, so a proof from it
 * may commit a different signal — in which case our guard can never verify it. That fails
 * closed rather than open (we always pass our own derived hash), so the symptom is an
 * unusable credential, not a bypass.
 */
export function expectedSignalHash(address) {
  if (!address) return null;
  return BigInt(keccak256(address)) >> 8n;
}

export const CREDENTIALS = {
  wetsuit: {
    key: "wetsuit",
    gear: "Wetsuit",
    idkit: "proof_of_human",
    schemaId: 1,
    attests: "World ID · personhood",
    // On staging, credentials live in different simulators and nothing tells you which.
    simulator: "https://simulator.worldcoin.org/",
  },
  mask: {
    key: "mask",
    gear: "Mask",
    idkit: "passport",
    schemaId: 9303,
    attests: "Passport · document",
    /**
     * Requested as the `passport` credential, carrying a signal — **not** as an Identity Check.
     *
     * Identity Check attesting `document_type: passport` looks like the natural fit and is a
     * dead end here: it exposes no `signal`, and a response from it arrives with no
     * `signal_hash` at all (measured, not inferred). Our guard derives `signalHash` from
     * `ctx.query.taker` and hands it to `verify()`, so a proof that committed no signal can
     * never verify — the credential is unusable as an address-bound gate. W-15.
     *
     * `passport` does carry a signal, and produces the same on-chain schema id (9303), so it
     * is the form that works. The cost is that the identity must actually hold a verified NFC
     * passport — which on staging means the identity-check simulator below, not the
     * proof-of-human one.
     */
    // The identity-check simulator, NOT the proof-of-human one. A passport request against
    // simulator.worldcoin.org fails with `credential_unavailable`, because that identity
    // simply does not hold the credential.
    simulator: "https://simulator.orb.engineer/",
  },
};

/** Band presentation, shared across environments — only the programs differ. */
const BAND_META = {
  surface: { key: "open", label: "Surface", depth: "0 m", feeLabel: "0.30%", needs: [] },
  human: { key: "tiered", label: "Human tier", depth: "−10 m", feeLabel: "0.05%", needs: ["wetsuit"] },
  reef: {
    key: "both",
    label: "The reef",
    depth: "−30 m",
    feeLabel: "0.01%",
    // Program D is two guard instructions, so the taker concatenates two proof payloads in
    // this order — it must match the order the guards appear in the shipped program.
    needs: ["wetsuit", "mask"],
  },
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
    Object.entries(BAND_META)
      // A deployment predating program D has no `both`; drop the band rather than render one
      // that cannot quote.
      .filter(([, meta]) => env.programs[meta.key])
      .map(([band, meta]) => [band, { ...env.programs[meta.key], ...meta }]),
  );
}

/**
 * The strict human-only program, used only to explain a silent fall-through.
 *
 * `JumpIfHumanTaker` cannot revert, so a rejected proof is indistinguishable from no proof.
 * This program runs the same check under `OnlyHumanTaker`, which does revert, and its reason
 * is the only way to say *why* the tiered band priced at the open fee. Not a band of its own
 * — the reef is program D now.
 */
export function diagnosticProgram(environment) {
  const env = ENVIRONMENTS[environment] ?? ENVIRONMENTS[DEFAULT_ENVIRONMENT];
  return env.programs.humanOnly ?? null;
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
