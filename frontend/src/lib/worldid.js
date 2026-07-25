/**
 * World ID request wiring.
 */

/**
 * Which environment a verifier address belongs to.
 *
 * The verifier is the authority, not a separate setting. Staging and production are
 * separate identity trees: request a production proof and verify it against the
 * staging proxy (or vice versa) and the call reverts on the Merkle root. Since the
 * verifier is a router immutable, deriving the environment from it removes any way
 * for the two to disagree.
 *
 * With two routers deployed there are two answers, so this takes the verifier as an
 * argument rather than being a module constant.
 */
const BY_ADDRESS = {
  "0x00000000009e00f9fe82cfeebb4556686da094d7": "production",
  "0x703a6316c975deabf30b637c155edd53e24657db": "staging",
};

export function environmentForVerifier(verifier) {
  return BY_ADDRESS[(verifier ?? "").toLowerCase()] ?? "production";
}

/**
 * Fetch an RP signature from our backend.
 *
 * Must be server-side: the signing key is the app's identity, and anyone holding
 * it can mint proof requests World App accepts as ScubaSwap. Note that
 * `@worldcoin/idkit` also exports `signRequest` — calling that here would put the
 * key in the browser bundle, which is exactly the mistake the backend exists to
 * prevent.
 *
 * The context is short-lived (300s), so this is called per gear-up rather than
 * once at load.
 */
export async function fetchRpContext(action) {
  const res = await fetch("/api/rp-signature", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action }),
  });

  const text = await res.text();

  if (!res.ok) {
    // HTML or XML here means CloudFront replaced the Lambda's response with the
    // SPA error page. Distribution-level `errorResponses` apply to every
    // behaviour including /api/*, so the API's own 4xx get swallowed — the fix is
    // a viewer-request function on the default behaviour only. Fixed in
    // infra/lib/scubaswap-stack.mjs; requires a redeploy to take effect.
    const looksLikeMarkup = text.trimStart().startsWith("<");
    if (looksLikeMarkup) {
      throw new Error(
        `The API returned markup, not JSON (${res.status}). CloudFront is replacing ` +
          `/api error responses with the SPA error page — redeploy the stack to apply ` +
          `the routing fix. The request itself did reach the Lambda.`,
      );
    }
    // An empty body on a 500 is what Vite's proxy returns when the upstream
    // refuses the connection, and what API Gateway returns when the Lambda never
    // ran. Either way it is "the service is not reachable", not "the service
    // rejected this" — worth distinguishing, because the fixes are different.
    if (!text.trim()) {
      throw new Error(
        `RP signing service is not reachable (${res.status}). The dev proxy targets ` +
          `https://scubaswap.xyz by default — check that /api/rp-signature is up, or run a ` +
          `local one with \`RP_API=http://127.0.0.1:8787 npm run dev\`.`,
      );
    }

    let detail = text.slice(0, 160);
    try {
      const j = JSON.parse(text);
      detail = j.detail ? `${j.error}: ${j.detail}` : (j.error ?? j.message ?? detail);
    } catch {
      /* keep the raw text */
    }
    throw new Error(`RP signing failed (${res.status}) — ${detail}`);
  }

  const ctx = JSON.parse(text);
  // The widget requires all five fields; a partial context fails inside World
  // App with a much less helpful message than this.
  for (const k of ["rp_id", "nonce", "created_at", "expires_at", "signature"]) {
    if (ctx[k] === undefined || ctx[k] === null) throw new Error(`RP context is missing "${k}"`);
  }
  return ctx;
}
