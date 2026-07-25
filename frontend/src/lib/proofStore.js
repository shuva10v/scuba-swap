/**
 * Persists the current proof across reloads.
 *
 * Worth doing because a proof costs a World App round-trip, and — since v4
 * nullifiers are one-time per action — a lost proof cannot simply be re-minted:
 * you need a *new action* to get another one. Dropping it on every hot reload is
 * genuinely expensive.
 *
 * A proof is only valid for the exact `(taker, action, chain)` it was issued
 * against, so all three are stored alongside it and a mismatch discards the
 * record rather than showing a wetsuit the guard would reject.
 *
 * The stored `nullifier` is a pseudonymous identifier. It stays in this browser
 * and is never sent anywhere except to the router that already requires it, but
 * it is the reason this is scoped to the demo origin rather than being something
 * to copy into a shared environment.
 */

import { keccak256, encodeAbiParameters } from "viem";
import { DEMO, publicClient, routerAbi } from "./chain";

const KEY = "scubaswap:proof";

/** `keccak256(abi.encode(nullifier, nonce))` — must match `WorldIdGuard.proofId`. */
export function proofId(nullifier, nonce) {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(nullifier), BigInt(nonce)]),
  );
}

export function save(proof, { address }) {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...proof,
        address: address?.toLowerCase(),
        action: DEMO.worldIdAction,
        chainId: DEMO.chainId,
        router: DEMO.router,
      }),
    );
  } catch {
    /* storage disabled; persistence is a convenience, not a requirement */
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Restore a stored proof, or null.
 *
 * Rejects for four separate reasons, each of which would otherwise show a wetsuit
 * that cannot dive:
 *
 *  - bound to a different taker — the signal would not match
 *  - issued for a different action — the router pins one action hash
 *  - past the freshness window — the guard enforces it even though the verifier does not
 *  - already spent on-chain — asked of the router directly, because a redeploy
 *    resets the spent set and only the chain knows the truth
 *
 * @param {object} opts
 * @param {string} opts.address current taker
 * @param {number} opts.windowMs freshness window, mirroring PROOF_FRESHNESS_WINDOW
 */
export async function load({ address, windowMs }) {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
  if (!stored?.args || !address) return null;

  if (stored.address !== address.toLowerCase()) return discard("bound to a different address");
  if (stored.action !== DEMO.worldIdAction) return discard(`issued for action "${stored.action}"`);
  if (stored.chainId !== DEMO.chainId) return discard("issued on a different chain");

  if (stored.expiresAtMin * 1000 + windowMs < Date.now()) {
    return discard("past the freshness window");
  }

  // The router is the only authority on whether this proof is still usable: a
  // redeploy resets `spentProofs`, so a locally "spent" flag would be wrong in
  // both directions.
  try {
    const spent = await publicClient.readContract({
      address: DEMO.router,
      abi: routerAbi,
      functionName: "spentProofs",
      args: [proofId(stored.nullifier, stored.nonce)],
    });
    if (spent) return discard("already spent on this router");
  } catch {
    // Chain unreachable — restoring optimistically is better than forcing a
    // re-gear, since the dive itself would surface the truth anyway.
  }

  return { args: stored.args, nullifier: stored.nullifier, nonce: stored.nonce, expiresAtMin: stored.expiresAtMin };
}

function discard(reason) {
  console.info(`[proof] discarded stored proof — ${reason}`);
  clear();
  return null;
}
