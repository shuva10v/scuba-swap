/**
 * World ID RP request signing.
 *
 * An RP signature proves a proof request came from our app. World ID enforces
 * them for all 4.0 requests, so without this the widget will not produce a
 * proof at all.
 *
 * Implemented from the published spec rather than pulled from
 * `@worldcoin/idkit-server` for one reason: the spec ships **deterministic test
 * vectors**, including exact expected signature bytes, and they are only usable
 * against an implementation that lets you inject the nonce and the clock. The
 * SDK's `signRequest` generates both internally, so it can be smoke-tested but
 * never pinned. `test/vectors.test.mjs` reproduces all eight published vectors
 * byte for byte — which is a materially stronger correctness claim than "we
 * called the official function".
 *
 * Spec: https://docs.world.org/world-id/idkit/signatures
 */

import { keccak256, toBytes, toHex, concatBytes } from "viem";
import { sign } from "viem/accounts";

/**
 * Reduce bytes to a BN254 field element.
 *
 * The same `keccak256 >> 8` used by `ByteHasher.sol` and by IDKit's
 * `hashSignal`. The spec is emphatic about one thing: **Keccak-256, not
 * SHA3-256**. They differ only in padding, so a SHA3 implementation produces
 * plausible-looking garbage that fails verification with no clue why.
 *
 * @param {Uint8Array} input
 * @returns {Uint8Array} 32 bytes, always leading 0x00
 */
export function hashToField(input) {
  const digest = BigInt(keccak256(input));
  return toBytes(toHex(digest >> 8n, { size: 32 }));
}

/**
 * Build the message that gets EIP-191 signed.
 *
 * Layout — 49 bytes without an action, 81 with:
 * ```
 *   [0]      0x01                     version
 *   [1..32]  nonce                    32-byte field element
 *   [33..40] created_at               big-endian uint64
 *   [41..48] expires_at               big-endian uint64
 *   [49..80] hashToField(action)      present only for uniqueness proofs
 * ```
 *
 * @param {Uint8Array} nonce 32 bytes
 * @param {bigint|number} createdAt unix seconds
 * @param {bigint|number} expiresAt unix seconds
 * @param {string|null} action
 */
export function computeRpSignatureMessage(nonce, createdAt, expiresAt, action = null) {
  if (nonce.length !== 32) throw new Error(`nonce must be 32 bytes, got ${nonce.length}`);

  const parts = [
    new Uint8Array([0x01]),
    nonce,
    toBytes(toHex(BigInt(createdAt), { size: 8 })),
    toBytes(toHex(BigInt(expiresAt), { size: 8 })),
  ];
  if (action !== null && action !== undefined) {
    parts.push(hashToField(new TextEncoder().encode(action)));
  }

  const msg = concatBytes(parts);
  const expected = action ? 81 : 49;
  if (msg.length !== expected) throw new Error(`message is ${msg.length} bytes, expected ${expected}`);
  return msg;
}

/**
 * EIP-191 digest of an RP message.
 *
 * @dev The prefix carries the **decimal** byte length of the message — "49" or
 * "81" — not a fixed-width or hex encoding. Getting that wrong yields a
 * well-formed signature over the wrong digest, which World ID rejects as
 * impersonation.
 */
export function rpSignatureDigest(msg) {
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  return keccak256(concatBytes([prefix, msg]));
}

/**
 * Sign a proof request.
 *
 * @param {object}  opts
 * @param {string}  opts.signingKeyHex   RP signing key, 32 bytes, 0x optional
 * @param {string}  [opts.action]        omit for session proofs
 * @param {number}  [opts.ttl=300]       seconds
 * @param {Uint8Array} [opts.random]     TEST ONLY — pins the nonce
 * @param {number}  [opts.createdAt]     TEST ONLY — pins the clock
 * @returns {{sig: string, nonce: string, createdAt: number, expiresAt: number}}
 */
export function signRequest({ signingKeyHex, action, ttl = 300, random, createdAt } = {}) {
  if (!signingKeyHex) throw new Error("signingKeyHex is required");

  const normalised = signingKeyHex.startsWith("0x") ? signingKeyHex : `0x${signingKeyHex}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error("signingKeyHex must be exactly 32 bytes of hex");
  }

  const entropy = random ?? crypto.getRandomValues(new Uint8Array(32));
  const nonce = hashToField(entropy);

  const created = createdAt ?? Math.floor(Date.now() / 1000);
  const expires = created + ttl;

  const msg = computeRpSignatureMessage(nonce, created, expires, action ?? null);
  const digest = rpSignatureDigest(msg);

  // Recoverable ECDSA over secp256k1, serialised r(32) || s(32) || v(1) with
  // v = recovery_id + 27. viem's `sign` with `to: "hex"` produces exactly that.
  const sig = sign({ hash: digest, privateKey: normalised, to: "hex" });

  return {
    sig: typeof sig === "string" ? sig : sig.then?.(),
    nonce: toHex(nonce),
    createdAt: created,
    expiresAt: expires,
  };
}

/**
 * Async variant. viem's `sign` is sync in recent versions but has been a promise
 * historically; this shape is safe either way.
 */
export async function signRequestAsync(opts) {
  const out = signRequest(opts);
  return { ...out, sig: await out.sig };
}
