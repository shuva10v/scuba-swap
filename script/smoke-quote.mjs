/**
 * Quotes every shipped program against the demo chain, using the same encoder
 * the frontend uses. Run by script/demo-up.sh as a post-deploy smoke test.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildTakerData } from "../packages/sdk/takerArgs.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:8545";
const demo = JSON.parse(readFileSync(process.argv[3] ?? "deployments/demo.json", "utf8"));

const SIG = "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)";

// Which side we sell is a property of the deployment, not a constant. Canonical
// WETH happens to sort before USDC on World Chain, but freshly deployed demo
// tokens land at arbitrary addresses — so read the roles the deploy recorded and
// derive the direction, rather than assuming WETH is tokenA.
const baseDecimals = demo.baseDecimals ?? 18;
const quoteDecimals = demo.quoteDecimals ?? 6;
const isAToB = demo.weth.toLowerCase() === demo.tokenA.toLowerCase();
const ONE_BASE = 10n ** BigInt(baseDecimals);

const takerData = buildTakerData({ isExactIn: true, isAToB });

// One entry per (environment, program). The older flat config had a single router;
// accept both shapes so an existing deployment on disk still smoke-tests.
const deployments = demo.environments
  ? Object.entries(demo.environments).map(([env, e]) => ({ env, router: e.router, programs: e.programs }))
  : [{ env: "", router: demo.router, programs: demo.programs }];

let failures = 0;
for (const { env, router, programs } of deployments) {
if (env) console.log(`  ${env}`);
for (const [name, p] of Object.entries(programs)) {
  const order = `(${p.maker},${p.traits},${p.data})`;
  try {
    const out = execFileSync(
      "cast",
      ["call", router, SIG, order, ONE_BASE.toString(), takerData, "--rpc-url", rpc],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim().split(/\s+/).filter((t) => /^[0-9]+$/.test(t));
    const received = Number(BigInt(out[1])) / 10 ** quoteDecimals;
    if (received <= 0) throw new Error("zero output");
    console.log(`  ${env ? "  " : ""}${name.padEnd(10)} 1 WETH -> ${received.toFixed(2).padStart(12)} USDC`);
  } catch (e) {
    // The guarded programs MUST reject a proofless quote — that is the feature, not a bug.
    // `both` demands two credentials, so it rejects for the same reason humanOnly does: the
    // guard refuses to read an absent proof as a payload (F-04).
    const msg = (e.stderr ?? e.message ?? "").toString();
    if ((name === "humanOnly" || name === "both") && /WorldIdProofMissing|0x/.test(msg)) {
      console.log(`  ${env ? "  " : ""}${name.padEnd(10)} correctly rejected a proofless quote`);
    } else {
      console.error(`  ${env ? "  " : ""}${name.padEnd(10)} FAILED: ${msg.slice(0, 200)}`);
      failures++;
    }
  }
}
}
process.exit(failures === 0 ? 0 : 1);
