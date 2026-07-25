#!/usr/bin/env node
/**
 * Loads the handler out of the **synthesized Lambda asset** and invokes it,
 * exactly as the runtime would.
 *
 * This exists because of a real outage. The asset's `exclude` list had `"test"`
 * in it, meaning `backend/test/`. CDK matches exclude patterns at every path
 * depth, so it also deleted `node_modules/viem/_esm/actions/test/`, which viem's
 * barrel export imports. Everything synthesized cleanly, deployed cleanly, and
 * then every request returned API Gateway's `{"message":"Internal Server Error"}`
 * because the module graph could not resolve at cold start.
 *
 * `cdk synth` cannot catch that: a Lambda asset is an opaque directory to
 * CloudFormation. Nothing validates that the bundle is *loadable* until the
 * first cold start in production. So we do it here.
 *
 *   cd infra && npm run verify   # run before every deploy
 */

import { readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(import.meta.dirname, "cdk.out");

if (!existsSync(OUT)) {
  console.error("cdk.out is missing — run `npx cdk synth` first.");
  process.exit(1);
}

// The signer asset is the one containing our handler; there are others (the
// S3 auto-delete custom resource, for one).
const asset = readdirSync(OUT)
  .filter((d) => d.startsWith("asset."))
  .map((d) => join(OUT, d))
  .find((d) => existsSync(join(d, "src", "handler.mjs")));

if (!asset) {
  console.error("no synthesized asset contains src/handler.mjs — did the asset layout change?");
  process.exit(1);
}

console.log(`asset: ${asset.replace(`${OUT}/`, "")}`);

process.env.RP_SIGNING_KEY ??= `0x${"ab".repeat(32)}`; // throwaway; never a real key
process.env.ALLOWED_ACTIONS ??= "world-demo-v2";
process.env.RP_ID ??= "rp_verify";

let handler;
try {
  const t0 = Date.now();
  ({ handler } = await import(join(asset, "src", "handler.mjs")));
  console.log(`module graph loaded in ${Date.now() - t0}ms`);
} catch (err) {
  console.error("\nthe bundle does not load — this WOULD have been a production outage:");
  console.error(`  ${err.message}`);
  if (err.code === "ERR_MODULE_NOT_FOUND") {
    console.error("\n  A module is missing from the asset. Check the `exclude` list in");
    console.error("  lib/scubaswap-stack.mjs — patterns match at EVERY path depth, so a");
    console.error("  bare directory name like `test` also strips node_modules/**/test/.");
  }
  process.exit(1);
}

const res = await handler({
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ action: process.env.ALLOWED_ACTIONS.split(",")[0] }),
});

if (res.statusCode !== 200) {
  console.error(`handler returned ${res.statusCode}: ${res.body}`);
  process.exit(1);
}

const body = JSON.parse(res.body);
const sigBytes = (body.signature.length - 2) / 2;
if (sigBytes !== 65) {
  console.error(`signature is ${sigBytes} bytes, expected 65`);
  process.exit(1);
}

console.log(`signed OK — ${sigBytes}-byte signature, nonce ${body.nonce.slice(0, 12)}…`);
console.log("the bundle that will be deployed runs.");
