/**
 * Merges per-environment deployment configs into the two-router config the
 * frontend consumes.
 *
 *   node script/merge-deployments.mjs <out.json> production=<a.json> staging=<b.json>
 *
 * Why a merge step instead of one script that deploys both: a router's verifier is
 * immutable, so "production" and "staging" are two separate routers with two
 * separate sets of shipped programs and two separate Aqua balances. `DeployDemo.s.sol`
 * already does exactly one of those correctly, and teaching it to do two would mean
 * threading a second verifier, a second router and a second program set through a
 * Solidity script that cannot even broadcast its own CREATEs (see its header). Two
 * plain runs plus this file is less machinery and far easier to debug when one of the
 * two fails.
 *
 * Everything outside `environments` must be identical across inputs — same chain,
 * same Aqua, same tokens, same maker, same action prefix. That is asserted rather
 * than assumed: two routers pointed at different token pairs would produce a config
 * where switching environments silently changes what you are trading.
 */
import { readFileSync, writeFileSync } from "node:fs";

const [outPath, ...pairs] = process.argv.slice(2);
if (!outPath || pairs.length === 0) {
  console.error("usage: merge-deployments.mjs <out.json> production=<a.json> [staging=<b.json>]");
  process.exit(2);
}

const VERIFIERS = {
  production: "0x00000000009E00F9FE82CfeeBB4556686da094d7",
  staging: "0x703a6316c975DEabF30b637c155edD53e24657DB",
};

// Fields that describe the deployment as a whole rather than one router.
const SHARED = [
  "chainId",
  "aqua",
  "maker",
  "tokenA",
  "tokenB",
  "weth",
  "usdc",
  "baseDecimals",
  "quoteDecimals",
  "worldIdActionPrefix",
  "worldIdRpId",
  "rpcUrl",
];

const inputs = pairs.map((pair) => {
  const idx = pair.indexOf("=");
  if (idx < 0) throw new Error(`expected name=path, got "${pair}"`);
  const name = pair.slice(0, idx);
  const path = pair.slice(idx + 1);
  if (!VERIFIERS[name]) throw new Error(`unknown environment "${name}" (expected production or staging)`);
  return { name, path, config: JSON.parse(readFileSync(path, "utf8")) };
});

const out = {};
for (const key of SHARED) {
  const values = inputs.map((i) => i.config[key]);
  const [first] = values;
  const differs = values.find((v) => String(v).toLowerCase() !== String(first).toLowerCase());
  if (differs !== undefined && values.length > 1) {
    throw new Error(
      `"${key}" differs between environments (${values.join(" vs ")}). ` +
        "Both routers must share one chain, one Aqua and one token pair, or switching " +
        "environments would change what is being traded.",
    );
  }
  if (first !== undefined) out[key] = first;
}

out.environments = {};
for (const { name, path, config } of inputs) {
  // The router's verifier is the authority on which environment it serves, so a
  // mismatch here means the deploy passed the wrong one and every proof would be
  // requested from the wrong World App.
  const expected = VERIFIERS[name];
  if (config.worldIdVerifier?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${path} is labelled "${name}" but its router verifier is ${config.worldIdVerifier}, ` +
        `not ${expected}`,
    );
  }
  out.environments[name] = {
    router: config.router,
    worldIdVerifier: config.worldIdVerifier,
    programs: config.programs,
  };
}

out.defaultEnvironment = out.environments.production ? "production" : Object.keys(out.environments)[0];

// Sort top-level keys for a stable diff, WITHOUT using JSON.stringify's replacer
// array to do it. Passing an array there is a key *filter* applied at every nesting
// level, not a top-level ordering: it silently wrote `"environments": {}` because
// neither "production" nor "staging" is a top-level key name. Sorting the object
// itself keeps the ordering and touches nothing nested.
const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
writeFileSync(outPath, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`wrote ${outPath}`);
for (const [name, env] of Object.entries(out.environments)) {
  console.log(`  ${name.padEnd(11)} router ${env.router}`);
}
