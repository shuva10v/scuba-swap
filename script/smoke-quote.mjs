/**
 * Quotes every shipped program against the demo chain, using the same encoder
 * the frontend uses. Run by script/demo-up.sh as a post-deploy smoke test.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { buildTakerData } from "../packages/sdk/takerArgs.mjs";

const rpc = process.argv[2] ?? "http://127.0.0.1:8545";
const demo = JSON.parse(readFileSync("deployments/demo.json", "utf8"));

const SIG = "quote((address,uint256,bytes),uint256,bytes)(uint256,uint256,bytes32)";
const ONE_WETH = 10n ** 18n;

// WETH is tokenA on World Chain, so selling WETH for USDC is A->B.
const takerData = buildTakerData({ isExactIn: true, isAToB: true });

let failures = 0;
for (const [name, p] of Object.entries(demo.programs)) {
  const order = `(${p.maker},${p.traits},${p.data})`;
  try {
    const out = execFileSync(
      "cast",
      ["call", demo.router, SIG, order, ONE_WETH.toString(), takerData, "--rpc-url", rpc],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim().split(/\s+/).filter((t) => /^[0-9]+$/.test(t));
    const usdc = Number(BigInt(out[1])) / 1e6;
    if (usdc <= 0) throw new Error("zero output");
    console.log(`  ${name.padEnd(10)} 1 WETH -> ${usdc.toFixed(2).padStart(10)} USDC`);
  } catch (e) {
    // humanOnly MUST reject a proofless quote — that is the feature, not a bug.
    const msg = (e.stderr ?? e.message ?? "").toString();
    if (name === "humanOnly" && /WorldIdProofMissing|0x/.test(msg)) {
      console.log(`  ${name.padEnd(10)} correctly rejected a proofless quote`);
    } else {
      console.error(`  ${name.padEnd(10)} FAILED: ${msg.slice(0, 200)}`);
      failures++;
    }
  }
}
process.exit(failures === 0 ? 0 : 1);
