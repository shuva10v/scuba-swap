/**
 * Handler behaviour, with emphasis on the ways this endpoint can fail *open*.
 *
 * A signing oracle that signs the wrong things is worse than one that is down,
 * so most of these assert refusals rather than successes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_KEY = "0xabababababababababababababababababababababababababababababababab";

/** Fresh module per case — the handler caches the key across warm invocations. */
async function loadHandler(env = {}) {
  for (const k of ["RP_SIGNING_KEY", "RP_SIGNING_KEY_SECRET_ID", "ALLOWED_ACTIONS", "RP_ID"]) {
    delete process.env[k];
  }
  Object.assign(process.env, env);
  const mod = await import(`../src/handler.mjs?t=${Math.random()}`);
  return mod.handler;
}

const post = (body) => ({ requestContext: { http: { method: "POST" } }, body: JSON.stringify(body) });

test("signs an allowlisted action", async () => {
  const handler = await loadHandler({
    RP_SIGNING_KEY: TEST_KEY,
    ALLOWED_ACTIONS: "world-demo-v2",
    RP_ID: "rp_2c23993348beb0ce",
  });

  const res = await handler(post({ action: "world-demo-v2" }));
  assert.equal(res.statusCode, 200);

  const out = JSON.parse(res.body);
  assert.match(out.signature, /^0x[0-9a-f]{130}$/, "65-byte signature");
  assert.match(out.nonce, /^0x00[0-9a-f]{62}$/, "nonce is a field element");
  assert.equal(out.rp_id, "rp_2c23993348beb0ce");
  assert.equal(out.expires_at - out.created_at, 300);

  // snake_case, matching IDKit's rp_context. A camelCase slip here would be
  // silently dropped by the widget.
  assert.deepEqual(
    Object.keys(out).sort(),
    ["created_at", "expires_at", "nonce", "rp_id", "signature"],
  );
});

test("refuses an action that is not allowlisted", async () => {
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "world-demo-v2" });

  const res = await handler(post({ action: "someone-elses-action" }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "action_not_allowed");
});

test("signs a suffixed action under an allowlisted prefix", async () => {
  // The case the demo actually depends on. World ID issues one proof per
  // (identity, rp, action), so every dive names a fresh `<prefix>-<suffix>`. An
  // exact-match allowlist would pass the test above and reject every real request.
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "scubaswap" });

  const res = await handler(post({ action: "scubaswap-1769300000" }));
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).signature, "no signature returned");
});

test("a prefix must match at the start, not anywhere", async () => {
  // Otherwise `evil-scubaswap` would borrow our RP identity for someone else's app.
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "scubaswap" });

  const res = await handler(post({ action: "evil-scubaswap-1" }));
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).error, "action_not_allowed");
});

test("refuses an action longer than the guard will hash", async () => {
  // Signing one would mint a proof no router could accept: the guard caps the
  // action at 64 bytes, so a longer one is rejected on-chain after the user has
  // already burned a liveness check on it.
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "scubaswap" });

  const res = await handler(post({ action: `scubaswap-${"x".repeat(64)}` }));
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, "action_too_long");
});

test("fails CLOSED when the allowlist is unset", async () => {
  // The important one. An unconfigured allowlist must not mean "sign anything" —
  // that would lend our RP identity to any caller.
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY });

  const res = await handler(post({ action: "world-demo-v2" }));
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.parse(res.body).error, "misconfigured");
});

test("never echoes the signing key, on success or failure", async () => {
  const bare = TEST_KEY.slice(2);

  const ok = await (await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" }))(post({ action: "a" }));
  const bad = await (await loadHandler({ RP_SIGNING_KEY: "0xnope", ALLOWED_ACTIONS: "a" }))(post({ action: "a" }));

  for (const res of [ok, bad]) {
    const blob = JSON.stringify(res);
    assert.equal(blob.includes(bare), false, "response contained the raw key");
    assert.equal(blob.includes(TEST_KEY), false, "response contained the prefixed key");
  }
  assert.equal(bad.statusCode, 500);
  assert.equal(JSON.parse(bad.body).error, "signing_failed");
  assert.equal(JSON.parse(bad.body).detail, undefined, "must not describe why signing failed");
});

test("responses are marked no-store", async () => {
  // Each signature carries a single-use nonce. A cached response would hand the
  // same nonce to multiple callers.
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" });
  const res = await handler(post({ action: "a" }));

  assert.match(res.headers["cache-control"], /no-store/);
});

test("rejects non-POST", async () => {
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" });
  const res = await handler({ requestContext: { http: { method: "GET" } } });

  assert.equal(res.statusCode, 405);
});

test("validates ttl bounds and rejects a missing action", async () => {
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" });

  assert.equal((await handler(post({}))).statusCode, 400);
  assert.equal((await handler(post({ action: "a", ttl: 0 }))).statusCode, 400);
  assert.equal((await handler(post({ action: "a", ttl: 100_000 }))).statusCode, 400);
  assert.equal((await handler(post({ action: "a", ttl: 1.5 }))).statusCode, 400);
  assert.equal((await handler(post({ action: "a", ttl: 60 }))).statusCode, 200);
});

test("handles malformed and base64 bodies", async () => {
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" });

  assert.equal((await handler({ requestContext: { http: { method: "POST" } }, body: "{oops" })).statusCode, 400);

  // API Gateway may base64-encode the body depending on content type.
  const b64 = {
    requestContext: { http: { method: "POST" } },
    body: Buffer.from(JSON.stringify({ action: "a" })).toString("base64"),
    isBase64Encoded: true,
  };
  assert.equal((await handler(b64)).statusCode, 200);
});

test("successive calls return different nonces", async () => {
  const handler = await loadHandler({ RP_SIGNING_KEY: TEST_KEY, ALLOWED_ACTIONS: "a" });

  const a = JSON.parse((await handler(post({ action: "a" }))).body);
  const b = JSON.parse((await handler(post({ action: "a" }))).body);

  assert.notEqual(a.nonce, b.nonce, "nonce must not be reused across requests");
  assert.notEqual(a.signature, b.signature);
});
