/**
 * ScubaSwap taker-args encoding — the single source of truth for byte layout,
 * shared by the frontend and cross-checked against Solidity.
 *
 * This file mirrors `src/instructions/WorldIdGuard.sol`'s
 * `WorldIdGuardArgsBuilder`. The two are kept honest by
 * `test/EncodingVectors.t.sol`, which regenerates the vectors below with Node
 * and asserts the Solidity builder produces identical bytes. If you change a
 * layout here, that test fails — which is the point. A silent disagreement
 * between the packer and the parser surfaces on-chain as `ProofInvalid()` or,
 * worse, as a proof that parses into the wrong fields.
 *
 * Deliberately dependency-free so Node (vector generation) and the browser
 * bundle can both import it without a build step.
 */

/** Byte lengths, matching WorldIdGuardArgsBuilder exactly. */
export const LAYOUT = {
  /** issuerSchemaId(8) || credentialGenesisIssuedAtMin(32) */
  POLICY: 40,
  /** jumpPC(2) || issuerSchemaId(8) || credentialGenesisIssuedAtMin(32) */
  POLICY_WITH_PC: 42,
  /** nullifier(32) || nonce(32) || expiresAtMin(8) || proof[5](160) */
  PROOF: 232,
};

/** Opcodes ScubaSwap claims in the SwapVM opcode space. */
export const OPCODE = {
  ONLY_HUMAN_TAKER: 0x27,
  JUMP_IF_HUMAN: 0x33,
};

class EncodingError extends Error {}

function toBigInt(value, field) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) {
        throw new EncodingError(`${field}: ${value} is not a safe integer — pass a bigint or 0x-string`);
      }
      return BigInt(value);
    }
    if (typeof value === "string") return BigInt(value);
  } catch (e) {
    if (e instanceof EncodingError) throw e;
    throw new EncodingError(`${field}: cannot parse ${JSON.stringify(value)} as an integer`);
  }
  throw new EncodingError(`${field}: unsupported type ${typeof value}`);
}

/** Big-endian, zero-padded, no 0x prefix. Reverts on overflow rather than truncating. */
function pad(value, bytes, field) {
  const v = toBigInt(value, field);
  if (v < 0n) throw new EncodingError(`${field}: negative`);
  const limit = 1n << BigInt(bytes * 8);
  if (v >= limit) {
    throw new EncodingError(`${field}: ${v} does not fit in ${bytes} bytes`);
  }
  return v.toString(16).padStart(bytes * 2, "0");
}

/**
 * Maker policy for the strict guard (opcode 0x27).
 *
 * Note this is *program* data, set by the maker when the strategy is shipped —
 * a taker never supplies it. It is here so tooling can build programs, not so
 * a frontend can send it.
 */
export function buildPolicy({ issuerSchemaId, credentialGenesisIssuedAtMin = 0n }) {
  return `0x${pad(issuerSchemaId, 8, "issuerSchemaId")}${pad(
    credentialGenesisIssuedAtMin,
    32,
    "credentialGenesisIssuedAtMin",
  )}`;
}

/** Maker policy for the conditional-jump guard (opcode 0x33). */
export function buildPolicyWithPC({ jumpPC, issuerSchemaId, credentialGenesisIssuedAtMin = 0n }) {
  return `0x${pad(jumpPC, 2, "jumpPC")}${pad(issuerSchemaId, 8, "issuerSchemaId")}${pad(
    credentialGenesisIssuedAtMin,
    32,
    "credentialGenesisIssuedAtMin",
  )}`;
}

/**
 * Taker proof payload, built straight from an IDKit v4 response.
 *
 * `signalHash` is deliberately NOT part of this payload: the guard derives it
 * on-chain from `ctx.query.taker`. Sending it would be meaningless at best and
 * an attempt to impersonate at worst.
 *
 * @param {object} response  One entry of `idkitResult.responses[]`
 * @returns {`0x${string}`}  232 bytes
 */
export function buildProofArgs(response) {
  const proof = response.proof;
  if (!Array.isArray(proof) || proof.length !== 5) {
    throw new EncodingError(
      `proof must be exactly 5 elements (4 compressed elements + Merkle root), got ${
        Array.isArray(proof) ? proof.length : typeof proof
      }. An 8-element proof is World ID 3.0, which this contract cannot verify.`,
    );
  }
  if (response.signal_hash === undefined) {
    throw new EncodingError(
      "response.signal_hash is missing — the credential request specified no signal. " +
        "ScubaSwap binds proofs to the taker address, so a signal is required.",
    );
  }

  const parts = [
    pad(response.nullifier, 32, "nullifier"),
    pad(response.nonce, 32, "nonce"),
    pad(response.expires_at_min, 8, "expires_at_min"),
    ...proof.map((p, i) => pad(p, 32, `proof[${i}]`)),
  ];

  const hex = `0x${parts.join("")}`;
  const byteLength = (hex.length - 2) / 2;
  if (byteLength !== LAYOUT.PROOF) {
    throw new EncodingError(`encoded ${byteLength} bytes, expected ${LAYOUT.PROOF}`);
  }
  return hex;
}

/**
 * Pull the fields the guard needs out of a raw IDKit result, failing loudly on
 * anything we cannot verify on-chain.
 *
 * The version check is not defensive padding. IDKit's `allow_legacy_proofs`
 * option makes World App fall back to a 3.0 payload, which is a completely
 * different proof system (8 elements, Merkle root, external nullifier) verified
 * by a different contract. Passing one to our guard produces a confusing
 * on-chain revert rather than an obvious client-side error.
 */
export function proofFromIdkitResult(result) {
  if (result?.protocol_version !== "4.0") {
    throw new EncodingError(
      `expected protocol_version "4.0", got ${JSON.stringify(result?.protocol_version)}. ` +
        "Set allow_legacy_proofs: false — ScubaSwap's guard verifies World ID 4.0 only.",
    );
  }

  const response = result.responses?.find((r) => r.identifier === "proof_of_human");
  if (!response) {
    const seen = (result.responses ?? []).map((r) => r.identifier).join(", ") || "none";
    throw new EncodingError(`no "proof_of_human" credential in the response (saw: ${seen})`);
  }

  // The top-level nonce is a public input; it is NOT inside the response entry.
  return buildProofArgs({ ...response, nonce: result.nonce });
}

export { EncodingError };

// ---------------------------------------------------------------------------
// Taker traits
// ---------------------------------------------------------------------------

/** Bit flags, mirroring `TakerTraitsLib`. */
const FLAG = {
  IS_EXACT_IN: 0x0001,
  SHOULD_UNWRAP_WETH: 0x0002,
  HAS_PRE_TRANSFER_IN_CALLBACK: 0x0004,
  HAS_PRE_TRANSFER_OUT_CALLBACK: 0x0008,
  IS_STRICT_THRESHOLD: 0x0010,
  IS_FIRST_TRANSFER_FROM_TAKER: 0x0020,
  USE_TRANSFER_FROM_AND_AQUA_PUSH: 0x0040,
  IS_A_TO_B: 0x0080,
};

/**
 * Builds the `takerTraitsAndData` blob for `quote()` / `swap()`.
 *
 * Layout is `slicesIndexes(20) ‖ flags(2) ‖ <variable sections>` — traits are a
 * `uint176`, i.e. the FIRST 22 bytes. Getting that length wrong reverts
 * `TakerTraitsMissingTraits()`, which is what a 21-byte hand-rolled blob does.
 *
 * Only the subset ScubaSwap's frontend needs is supported: an EOA taker paying
 * with `transferFrom` + Aqua push, an optional threshold, and the guard payload
 * in `instructionsArgs`. Hooks, callbacks, custom recipients, deadlines and
 * signatures are all omitted — an EOA cannot answer a callback, and Aqua orders
 * need no signature.
 *
 * `slicesIndexes` are CUMULATIVE END offsets into the variable tail, packed
 * 16 bits each. With only a threshold and instructionsArgs in play, every index
 * from `to` onwards equals the running total, so they must all be written even
 * though the intervening sections are empty.
 */
export function buildTakerData({
  isExactIn = true,
  isAToB = true,
  threshold = null,
  instructionsArgs = "0x",
} = {}) {
  const thresholdHex = threshold === null ? "" : pad(threshold, 32, "threshold");
  const argsHex = (instructionsArgs ?? "0x").replace(/^0x/, "");
  if (argsHex.length % 2 !== 0) throw new EncodingError("instructionsArgs is not whole bytes");

  const thresholdLen = thresholdHex.length / 2; // 0 or 32
  const argsLen = argsHex.length / 2;

  // index0 = end of threshold; index1..index8 add nothing; index9 = end of
  // instructionsArgs. index9 is the LAST 16-bit field, so `signature` (which
  // follows) is implicitly empty.
  const i0 = thresholdLen;
  const i8 = i0; // to, deadline and all six hook/callback sections are empty
  const i9 = i8 + argsLen;

  let slices = 0n;
  slices |= BigInt(i0) << 0n;
  for (const [idx, shift] of [
    [i8, 16n],
    [i8, 32n],
    [i8, 48n],
    [i8, 64n],
    [i8, 80n],
    [i8, 96n],
    [i8, 112n],
    [i8, 128n],
  ]) {
    slices |= BigInt(idx) << shift;
  }
  slices |= BigInt(i9) << 144n;

  // A threshold is left NON-strict on purpose: strict means "must equal", which
  // for a taker is a min-output guarantee turned into a footgun.
  let flags = FLAG.USE_TRANSFER_FROM_AND_AQUA_PUSH;
  if (isExactIn) flags |= FLAG.IS_EXACT_IN;
  if (isAToB) flags |= FLAG.IS_A_TO_B;

  return `0x${pad(slices, 20, "slicesIndexes")}${pad(flags, 2, "flags")}${thresholdHex}${argsHex}`;
}

export { FLAG };
