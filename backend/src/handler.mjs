/**
 * POST /api/rp-signature
 *
 * Signs a World ID proof request so World App will honour it. This is the only
 * server-side component ScubaSwap needs: proof *verification* happens on-chain
 * inside the swap, not here.
 *
 * Threat model, because this endpoint is more sensitive than it looks:
 *
 * - The signing key **is** our app's identity. Anyone holding it can mint proof
 *   requests that World App will accept as coming from ScubaSwap. It is fetched
 *   from Secrets Manager at cold start, held only in memory, and never logged or
 *   returned.
 *
 * - The endpoint is a signing oracle. Without an action allowlist, anyone could
 *   POST an arbitrary action and have us lend our RP identity to their app.
 *   `ALLOWED_ACTIONS` is therefore mandatory, not optional hardening.
 *
 * - Responses must never be cached. Each signature carries a fresh nonce that
 *   World ID uses for replay protection; a shared cached response would hand the
 *   same nonce to every caller. Hence `no-store` here AND a caching-disabled
 *   behaviour on the CloudFront side — belt and braces, because either alone
 *   silently fails open.
 */

import { signRequestAsync } from "./signRequest.mjs";

const DEFAULT_TTL = 300;
const MAX_TTL = 900;

/** Cached across warm invocations; a cold start re-fetches. */
let cachedKey = null;

async function loadSigningKey() {
  if (cachedKey) return cachedKey;

  // Local development: an env var is acceptable because there is no real key.
  if (process.env.RP_SIGNING_KEY) {
    cachedKey = process.env.RP_SIGNING_KEY.trim();
    return cachedKey;
  }

  const secretId = process.env.RP_SIGNING_KEY_SECRET_ID;
  if (!secretId) {
    throw new Error("neither RP_SIGNING_KEY nor RP_SIGNING_KEY_SECRET_ID is set");
  }

  // Imported lazily so local dev and the vector tests need no AWS SDK.
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const client = new SecretsManagerClient({});
  const res = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!res.SecretString) throw new Error("secret has no SecretString");

  // Accept either a bare hex string or {"signingKey": "0x…"}.
  let value = res.SecretString.trim();
  if (value.startsWith("{")) {
    const parsed = JSON.parse(value);
    value = (parsed.signingKey ?? parsed.RP_SIGNING_KEY ?? "").trim();
  }
  if (!value) throw new Error("secret did not contain a signing key");

  cachedKey = value;
  return cachedKey;
}

/**
 * Action prefixes this endpoint will sign for.
 *
 * Prefixes rather than exact strings, because World ID issues at most one proof
 * per (identity, rp, action): a demo on one fixed action lets each person gear up
 * exactly once, ever. The router commits to a prefix and each dive names
 * `<prefix>-<suffix>`, so an exact-match allowlist here would reject every real
 * request while passing the tests.
 *
 * Still an allowlist, and still mandatory. The endpoint signs with our RP
 * identity, so the prefix is what stops it becoming an oracle that lends that
 * identity to anyone who asks. Keep prefixes specific; a prefix of "" or "a"
 * would defeat the point entirely.
 */
function allowedActionPrefixes() {
  const raw = process.env.ALLOWED_ACTIONS;
  if (!raw) return null; // signals a misconfiguration, handled by the caller
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Longest action we will sign. Mirrors the guard's MAX_ACTION_LENGTH. */
const MAX_ACTION_LENGTH = 64;

function reply(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      // A cached RP signature would be replayed across users — see the header
      // comment. This must stay in lockstep with the CloudFront behaviour.
      "cache-control": "no-store, no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
    },
    body: JSON.stringify(body),
  };
}

export async function handler(event) {
  const method = event?.requestContext?.http?.method ?? event?.httpMethod ?? "POST";
  if (method !== "POST") {
    return reply(405, { error: "method_not_allowed", detail: "use POST" });
  }

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "{}");
    body = JSON.parse(raw || "{}");
  } catch {
    return reply(400, { error: "invalid_json" });
  }

  const allow = allowedActionPrefixes();
  if (!allow) {
    // Fail closed. An unconfigured allowlist would otherwise make this a signing
    // oracle for arbitrary actions.
    console.error("ALLOWED_ACTIONS is not configured; refusing to sign");
    return reply(500, { error: "misconfigured", detail: "ALLOWED_ACTIONS is not set" });
  }

  const { action } = body;
  const expected = `expected an action starting with one of: ${allow.join(", ")}`;
  if (typeof action !== "string" || action.length === 0) {
    return reply(400, { error: "action_required", detail: expected });
  }
  // Bounded before the prefix test: the guard refuses to hash an action longer
  // than this, so signing one would produce a proof no router could accept.
  if (Buffer.byteLength(action, "utf8") > MAX_ACTION_LENGTH) {
    return reply(400, { error: "action_too_long", detail: `max ${MAX_ACTION_LENGTH} bytes` });
  }
  if (!allow.some((prefix) => action.startsWith(prefix))) {
    return reply(403, { error: "action_not_allowed", detail: expected });
  }

  let ttl = Number(body.ttl ?? DEFAULT_TTL);
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL) {
    return reply(400, { error: "invalid_ttl", detail: `ttl must be an integer in 1..${MAX_TTL}` });
  }

  let signed;
  try {
    signed = await signRequestAsync({ signingKeyHex: await loadSigningKey(), action, ttl });
  } catch (err) {
    // Deliberately generic to the client: a signing failure can be a malformed
    // key, and echoing the reason risks leaking its shape.
    console.error("signing failed:", err?.message ?? err);
    return reply(500, { error: "signing_failed" });
  }

  // Shaped for IDKit's `rp_context`, whose field names are snake_case while
  // `signRequest` returns camelCase — mapping it here keeps that mismatch out of
  // the frontend. Note `sig` -> `signature`.
  return reply(200, {
    rp_id: process.env.RP_ID ?? null,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  });
}
