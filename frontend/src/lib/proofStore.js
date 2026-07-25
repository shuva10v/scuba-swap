/**
 * Persists the current proof across reloads.
 *
 * Worth doing because a proof costs a World App round-trip, and — since v4
 * nullifiers are one-time per action — a lost proof cannot be re-minted for the
 * same action; you need a fresh one, which means another World App round-trip and
 * another liveness check. Dropping it on every hot reload is genuinely expensive.
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
import { DEMO, isActionAllowed, publicClient, routerAbi } from "./chain";

/**
 * One slot per environment.
 *
 * Scoped rather than global so switching environments does not destroy the proof you
 * already earned: production and staging each hold their own, and flipping back
 * restores the wetsuit instead of demanding another World App round-trip. That matters
 * because a proof is not cheap to replace — a fresh action means a fresh liveness
 * check — and nothing about switching *invalidates* the proof for the environment it
 * was minted against.
 */
const KEY_PREFIX = "scubaswap:proof";
const keyFor = (environment) => `${KEY_PREFIX}:${environment}`;

/** Every slot, for the cases where the proofs really are all worthless. */
const ALL_KEYS = ["production", "staging"].map(keyFor);

/** `keccak256(abi.encode(nullifier, nonce))` — must match `WorldIdGuard.proofId`. */
export function proofId(nullifier, nonce) {
  return keccak256(
    encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [BigInt(nullifier), BigInt(nonce)]),
  );
}

export function save(proof, { address, environment, router }) {
  try {
    localStorage.setItem(
      keyFor(environment),
      JSON.stringify({
        ...proof,
        address: address?.toLowerCase(),
        action: proof.action,
        chainId: DEMO.chainId,
        environment,
        router,
      }),
    );
  } catch {
    /* storage disabled; persistence is a convenience, not a requirement */
  }
}

/** Discard the proof for one environment. */
export function clear(environment) {
  try {
    localStorage.removeItem(keyFor(environment));
  } catch {
    /* ignore */
  }
}

/**
 * Discard every stored proof.
 *
 * For a disconnect or an account change: the signal is derived from the taker
 * address, so a proof bound to the previous account is unusable in *every*
 * environment, not just the active one.
 */
export function clearAll() {
  try {
    // Also sweeps the pre-scoping key, so an upgrade does not leave one behind.
    for (const k of [...ALL_KEYS, KEY_PREFIX]) localStorage.removeItem(k);
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
 *  - issued for an action outside the router's prefix
 *  - past the freshness window — the guard enforces it even though the verifier does not
 *  - already spent on-chain — asked of the router directly, because a redeploy
 *    resets the spent set and only the chain knows the truth
 *
 * @param {object} opts
 * @param {string} opts.address current taker
 * @param {number} opts.windowMs freshness window, mirroring PROOF_FRESHNESS_WINDOW
 */
export async function load({ address, windowMs, environment, router }) {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem(keyFor(environment)) ?? "null");
  } catch {
    return null;
  }
  if (!stored?.args || !address) return null;

  if (stored.address !== address.toLowerCase()) return discard("bound to a different address", environment);
  // A prefix check, not equality: every dive mints its own action, so the stored
  // one will never equal a freshly generated string. What must still hold is that
  // the router would accept it.
  if (!isActionAllowed(stored.action)) return discard(`issued for action "${stored.action}"`, environment);
  if (stored.chainId !== DEMO.chainId) return discard("issued on a different chain", environment);
  // A staging proof is worthless on the production router and vice versa — separate
  // identity trees, and the verifier is immutable per router. Checking the router
  // alone would also catch this, but naming the environment makes the console line
  // say something a human can act on.
  if (stored.environment !== environment) return discard(`issued against ${stored.environment}`, environment);
  if (stored.router?.toLowerCase() !== router?.toLowerCase()) return discard("issued against another router", environment);

  if (stored.expiresAtMin * 1000 + windowMs < Date.now()) {
    return discard("past the freshness window", environment);
  }

  // The router is the only authority on whether this proof is still usable: a
  // redeploy resets `spentProofs`, so a locally "spent" flag would be wrong in
  // both directions.
  try {
    const spent = await publicClient.readContract({
      address: router,
      abi: routerAbi,
      functionName: "spentProofs",
      args: [proofId(stored.nullifier, stored.nonce)],
    });
    if (spent) return discard("already spent on this router", environment);
  } catch {
    // Chain unreachable — restoring optimistically is better than forcing a
    // re-gear, since the dive itself would surface the truth anyway.
  }

  return {
    args: stored.args,
    nullifier: stored.nullifier,
    nonce: stored.nonce,
    expiresAtMin: stored.expiresAtMin,
    action: stored.action,
  };
}

function discard(reason, environment) {
  console.info(`[proof] discarded stored ${environment} proof — ${reason}`);
  clear(environment);
  return null;
}
