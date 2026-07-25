/**
 * Pins our RP signer against every test vector World ID publishes.
 *
 * https://docs.world.org/world-id/idkit/signatures#test-vectors
 *
 * These are the reason this signer is implemented rather than imported: the
 * vectors fix the nonce and the clock, so they can only be checked against an
 * implementation that lets both be injected. Reproducing the exact signature
 * bytes proves the whole chain — Keccak vs SHA3, message layout, the decimal
 * EIP-191 length prefix, and the r‖s‖v serialisation — in a way that calling an
 * opaque SDK function cannot.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { toBytes, toHex } from "viem";

import { hashToField, computeRpSignatureMessage, signRequestAsync } from "../src/signRequest.mjs";

/** The vectors' deterministic entropy: bytes 0x00,0x01,…,0x1f. */
const DETERMINISTIC_RANDOM = new Uint8Array(Array.from({ length: 32 }, (_, i) => i));
const VECTOR_KEY = "0xabababababababababababababababababababababababababababababababab";
const VECTOR_CREATED_AT = 1_700_000_000;
const VECTOR_NONCE = "0x008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd";

test("hashToField — published vectors", () => {
  const enc = (s) => new TextEncoder().encode(s);

  assert.equal(
    toHex(hashToField(enc(""))),
    "0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4",
    "empty string",
  );
  assert.equal(
    toHex(hashToField(enc("test_signal"))),
    "0x00c1636e0a961a3045054c4d61374422c31a95846b8442f0927ad2ff1d6112ed",
    "test_signal",
  );
  assert.equal(
    toHex(hashToField(new Uint8Array([0x01, 0x02, 0x03]))),
    "0x00f1885eda54b7a053318cd41e2093220dab15d65381b1157a3633a83bfd5c92",
    "raw bytes",
  );
  assert.equal(
    toHex(hashToField(enc("hello"))),
    "0x001c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36dea",
    "hello",
  );
});

test("hashToField output always starts with 0x00", () => {
  // The >> 8 is what guarantees the result fits BN254's scalar field. This is
  // the same reduction the `action` parameter needs on-chain, where omitting it
  // reverts InvalidAction() — see FRICTION W-05.
  for (const s of ["", "a", "world-demo-v2", "x".repeat(500)]) {
    const out = toHex(hashToField(new TextEncoder().encode(s)));
    assert.equal(out.slice(0, 4), "0x00", `top byte not cleared for ${JSON.stringify(s.slice(0, 12))}`);
  }
});

test("computeRpSignatureMessage — 49 bytes without an action", () => {
  const msg = computeRpSignatureMessage(toBytes(VECTOR_NONCE), VECTOR_CREATED_AT, VECTOR_CREATED_AT + 300, null);

  assert.equal(msg.length, 49);
  assert.equal(
    toHex(msg),
    "0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd" +
      "000000006553f100" +
      "000000006553f22c",
  );
});

test("computeRpSignatureMessage — 81 bytes with an action", () => {
  const msg = computeRpSignatureMessage(
    toBytes(VECTOR_NONCE),
    VECTOR_CREATED_AT,
    VECTOR_CREATED_AT + 300,
    "test-action",
  );

  assert.equal(msg.length, 81);
  assert.equal(
    toHex(msg),
    "0x01008ae1aa597fa146ebd3aa2ceddf360668dea5e526567e92b0321816a4e895bd" +
      "000000006553f100" +
      "000000006553f22c" +
      "00aa0ce59768ae5b1c52f07a9387f14f09f277422c0d2f8a268c7bad0c60a46a",
  );
});

test("signRequest — session proof (no action) reproduces the published signature", async () => {
  const out = await signRequestAsync({
    signingKeyHex: VECTOR_KEY,
    random: DETERMINISTIC_RANDOM,
    createdAt: VECTOR_CREATED_AT,
    ttl: 300,
  });

  assert.equal(out.nonce, VECTOR_NONCE, "nonce");
  assert.equal(
    out.sig,
    "0x14f693175773aed912852a601e9c0fd30f2afe2738d31388316232ce6f64ae9e" +
      "4edbfb19d81c4229ba9c9fca78ede4b28956b7ba4415f08d957cbc1b3bdaa402" +
      "1b",
    "signature",
  );
  assert.equal(out.createdAt, VECTOR_CREATED_AT);
  assert.equal(out.expiresAt, VECTOR_CREATED_AT + 300);
});

test("signRequest — uniqueness proof (with action) reproduces the published signature", async () => {
  const out = await signRequestAsync({
    signingKeyHex: VECTOR_KEY,
    action: "test-action",
    random: DETERMINISTIC_RANDOM,
    createdAt: VECTOR_CREATED_AT,
    ttl: 300,
  });

  assert.equal(out.nonce, VECTOR_NONCE, "nonce");
  assert.equal(
    out.sig,
    "0x05594adb6c1495768a38d523d7d6ee6356b2c31231919198794ed022ade7d08f" +
      "73753f83bd167067d99c9b969d28e9222315837c66af25867b041273a6d5056f" +
      "1b",
    "signature",
  );
});

test("the two vectors differ only by the action, and produce different signatures", async () => {
  // Guards against an implementation that silently drops the action — it would
  // still reproduce the 49-byte vector and look correct.
  const common = { signingKeyHex: VECTOR_KEY, random: DETERMINISTIC_RANDOM, createdAt: VECTOR_CREATED_AT };
  const session = await signRequestAsync(common);
  const uniqueness = await signRequestAsync({ ...common, action: "test-action" });

  assert.equal(session.nonce, uniqueness.nonce, "same entropy must give the same nonce");
  assert.notEqual(session.sig, uniqueness.sig, "action must affect the signature");
});

test("signing key is validated, not silently coerced", async () => {
  await assert.rejects(() => signRequestAsync({ signingKeyHex: "" }), /required/);
  await assert.rejects(() => signRequestAsync({ signingKeyHex: "0xdeadbeef" }), /32 bytes/);
  await assert.rejects(() => signRequestAsync({ signingKeyHex: `0x${"zz".repeat(32)}` }), /32 bytes/);

  // Accepted with or without the 0x prefix, per the spec.
  const withPrefix = await signRequestAsync({ signingKeyHex: VECTOR_KEY, random: DETERMINISTIC_RANDOM, createdAt: 1 });
  const without = await signRequestAsync({ signingKeyHex: VECTOR_KEY.slice(2), random: DETERMINISTIC_RANDOM, createdAt: 1 });
  assert.equal(withPrefix.sig, without.sig);
});

test("nonces are unique across calls when entropy is not injected", async () => {
  const seen = new Set();
  for (let i = 0; i < 32; i++) {
    const { nonce } = await signRequestAsync({ signingKeyHex: VECTOR_KEY, action: "world-demo-v2" });
    assert.equal(seen.has(nonce), false, "nonce repeated");
    seen.add(nonce);
  }
});
