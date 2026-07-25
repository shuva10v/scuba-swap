/**
 * ScubaSwap — three panels: diver (identity), depth (the trade), dive computer
 * (what actually executed).
 *
 * Flow: connect → live quotes for every band → gear up with World ID → the
 * wetsuit goes on and the human tier unlocks → dive.
 */

import { useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { IDKitRequestWidget, proofOfHuman, setDebug } from "@worldcoin/idkit";

import { BubblesMark } from "./components/Diver";
import DiverPanel from "./components/DiverPanel";
import DepthPanel from "./components/DepthPanel";
import DiveComputer from "./components/DiveComputer";
import WalletMenu, { clearDisconnected, wasDisconnected } from "./components/WalletMenu";
import { DEMO, PROGRAMS, demoChain, erc20Abi, orderTuple, publicClient, routerAbi, walletClientFrom, decodeRevert } from "./lib/chain";
import { WORLD_ID_ENVIRONMENT, fetchRpContext } from "./lib/worldid";
import * as proofStore from "./lib/proofStore";
import { buildTakerData, proofFromIdkitResult } from "../../packages/sdk/takerArgs.mjs";

const APP_ID = import.meta.env.VITE_WORLD_APP_ID ?? "";

// "Verification unavailable / contact the website owner" is World App refusing the
// REQUEST rather than the proof, and the response payload is encrypted to the
// app's key, so it tells an integrator nothing. IDKit's debug mode produces a
// readable report instead; on in dev only.
if (import.meta.env.DEV) setDebug(true);

// Overridable so a failing request can be bisected without editing code.
// `environment` normally derives from the router's verifier — override only to
// test whether a staging/production mismatch is the cause.
const ENV_OVERRIDE = import.meta.env.VITE_WORLD_ENV;

/** Mirrors WorldIdGuard.PROOF_FRESHNESS_WINDOW (15 minutes). */
const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
const REQUIRE_PRESENCE = import.meta.env.VITE_REQUIRE_PRESENCE !== "false";

export default function App() {
  const [address, setAddress] = useState(null);
  const [amount, setAmount] = useState("1");
  const [proof, setProof] = useState(null); // { args, nullifier, expiresAtMin }
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activePc, setActivePc] = useState(null);
  const [failedPc, setFailedPc] = useState(null);
  const [gas, setGas] = useState(null);
  // rp_context is a required widget prop and expires in ~5 min, so it is
  // fetched per gear-up rather than once at load.
  const [rpContext, setRpContext] = useState(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [gearingUp, setGearingUp] = useState(false);

  /**
   * Warn when a proof is past `expiresAtMin` — but never silently discard it.
   *
   * An earlier version cleared the proof whenever `expiresAtMin` was already in
   * the past. That destroyed every proof the instant it arrived: the field lands
   * at roughly the moment of generation, so it is frequently a second or two
   * behind by the time this effect runs. World App reported success, both
   * callbacks logged, and the wetsuit never appeared — with nothing shown to
   * explain it, because the clearing path set no error.
   *
   * Note the name: `expires_at_min` is "expires at, **minimum**" — a lower bound
   * on how long the credential remains valid, not the instant the proof dies.
   * Which is consistent with what the live verifier does: it accepts proofs well
   * past that timestamp (measured at +189s and +314s). ScubaSwap's guard is the
   * thing that enforces `expiresAtMin >= block.timestamp`, so a stale value means
   * the swap will revert — worth warning about, never worth hiding the proof over.
   */
  useEffect(() => {
    if (!proof) return;

    const stale = () =>
      setError(
        "This proof is older than the 15-minute freshness window, so the guard will reject it. " +
          "ScubaSwap enforces freshness even though the verifier does not. Gear up again to dive.",
      );

    const ms = proof.expiresAtMin * 1000 + FRESHNESS_WINDOW_MS - Date.now();
    if (ms <= 0) {
      stale();
      return;
    }
    const t = setTimeout(stale, ms);
    return () => clearTimeout(t);
  }, [proof]);

  /**
   * Restore an existing connection on mount, and follow the wallet afterwards.
   *
   * `eth_accounts` is the right call here, not `eth_requestAccounts`: it returns
   * already-authorised accounts silently, without popping a prompt on every page
   * load. MetaMask persists the authorisation itself, so there is nothing for us
   * to store.
   *
   * Deliberately not localStorage. Caching the address ourselves would let the
   * UI claim "connected" after the user revoked the site in their wallet — the
   * wallet is the source of truth, so we ask it.
   */
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth) return;

    let cancelled = false;

    // An explicit disconnect must survive a refresh, or eth_accounts would
    // silently reconnect and the button would look broken.
    if (wasDisconnected()) return;

    eth
      .request({ method: "eth_accounts" })
      .then((accts) => {
        if (!cancelled && accts?.length) setAddress(accts[0]);
      })
      .catch(() => {
        /* no authorised account; stay disconnected */
      });

    const onAccounts = (accts) => {
      setAddress(accts?.length ? accts[0] : null);
      // A different account means a different signal, so any proof bound to the
      // old address is worthless. Dropping it prevents showing a wetsuit the
      // guard would reject. (proofStore also checks this on restore.)
      setProof(null);
    };
    const onChain = () => {
      // Balances, quotes and the router address are all chain-scoped; a reload is
      // simpler and less error-prone than reconciling every cached read.
      window.location.reload();
    };

    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);

    return () => {
      cancelled = true;
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, []);

  useEffect(() => {
    if (!address || proof) return;
    let cancelled = false;
    proofStore.load({ address, windowMs: FRESHNESS_WINDOW_MS }).then((restored) => {
      if (!cancelled && restored) {
        console.info("[proof] restored from storage");
        setProof(restored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [address, proof]);

  const connect = useCallback(async () => {
    setError(null);
    if (!window.ethereum) {
      setError("No injected wallet found. Import the demo taker key into MetaMask and reload.");
      return;
    }
    try {
      const [acct] = await window.ethereum.request({ method: "eth_requestAccounts" });
      clearDisconnected();
      await window.ethereum
        .request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${demoChain.id.toString(16)}` }] })
        .catch(() => {
          // Chain not added yet — non-fatal, the user may already be on it.
        });
      setAddress(acct);
    } catch (e) {
      setError(e?.message ?? "Wallet connection rejected");
    }
  }, []);

  const programKey = proof ? "human" : "surface";
  // Guarded programs need the proof in takerArgs; the surface program ignores it.
  const takerData = buildTakerData({ isExactIn: true, isAToB: true, instructionsArgs: proof?.args ?? "0x" });

  const gearUp = useCallback(async () => {
    setError(null);
    if (!address) {
      setError("Connect a wallet first — the proof is bound to the address that swaps.");
      return;
    }
    if (!APP_ID) {
      setError(
        "VITE_WORLD_APP_ID is not set. Copy frontend/.env.example to .env.local and set your " +
          "Developer Portal app id (starts with app_, not rp_), then restart the dev server.",
      );
      return;
    }
    setGearingUp(true);
    try {
      setRpContext(await fetchRpContext(DEMO.worldIdAction));
      setWidgetOpen(true);
    } catch (e) {
      setGearingUp(false);
      setError(e.message);
    }
  }, [address]);

  const onProof = useCallback(
    (result) => {
    setError(null);
    try {
      const args = proofFromIdkitResult(result);
      const r = result.responses.find((x) => x.identifier === "proof_of_human");
      const expiresAtMin = Number(r.expires_at_min);
      console.info("[IDKit] parsed →", {
        takerArgsBytes: (args.length - 2) / 2,
        nullifier: `${r.nullifier.slice(0, 12)}…`,
        expiresAtMin,
        validForSeconds: expiresAtMin - Math.floor(Date.now() / 1000),
        presence: result.user_presence_completed,
      });
      const minted = { args, nullifier: r.nullifier, nonce: result.nonce, expiresAtMin };
      setProof(minted);
      proofStore.save(minted, { address });
      setGearingUp(false);
      setWidgetOpen(false);
    } catch (e) {
      // The SDK rejects a v3 payload explicitly rather than letting it fail
      // on-chain as an opaque revert.
      setGearingUp(false);
      setError(e.message);
      }
    },
    [address],
  );

  const dive = useCallback(async () => {
    if (!address) return;
    setBusy(true);
    setError(null);
    setFailedPc(null);
    setActivePc(0);
    setGas(null);

    const program = PROGRAMS[programKey];
    try {
      const wallet = walletClientFrom(window.ethereum);
      const amountIn = BigInt(Math.round(Number(amount) * 1e18));

      // Approve once; the router pulls tokenIn and pushes it into Aqua itself.
      const allowance = await publicClient.readContract({
        address: DEMO.weth,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, DEMO.router],
      });
      if (allowance < amountIn) {
        const hash = await wallet.writeContract({
          account: address,
          address: DEMO.weth,
          abi: erc20Abi,
          functionName: "approve",
          args: [DEMO.router, 2n ** 256n - 1n],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      const hash = await wallet.writeContract({
        account: address,
        address: DEMO.router,
        abi: routerAbi,
        functionName: "swap",
        args: [orderTuple(program), amountIn, takerData],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      setGas(receipt.gasUsed);
      setActivePc(999); // all rows lit
      // The proof was consumed on-chain, so the wetsuit comes off. Reflecting
      // that immediately is more honest than leaving it on until it expires.
      if (proof) {
        setProof(null);
        proofStore.clear();
      }
    } catch (e) {
      const d = decodeRevert(e);
      setError(`${d.message}${d.detail ? ` — ${d.detail}` : ""}`);
      setFailedPc(0); // the guard is always pc 0 in the programs we ship
      setActivePc(null);
    } finally {
      setBusy(false);
    }
  }, [address, amount, programKey, takerData, proof]);

  return (
    <div style={{ maxWidth: 1280, margin: "0 auto", padding: "28px 24px 80px" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 28, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <BubblesMark size={38} />
          <div>
            <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 22, letterSpacing: "-0.02em" }}>ScubaSwap</div>
            <div className="eyebrow" style={{ color: "var(--locked)" }}>
              1inch Aqua × World ID
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Explicitly labelled: an unlabelled truncated address sitting next
              to a Connect button reads as a connected account, which this is
              not — it is the contract the UI is pointed at. */}
          <span className="mono" style={{ fontSize: 11, color: "var(--locked)", textAlign: "right", lineHeight: 1.5 }}>
            <span style={{ opacity: 0.7 }}>router</span> {DEMO.router.slice(0, 6)}…{DEMO.router.slice(-4)}
            <br />
            <span style={{ opacity: 0.7 }}>World Chain fork · chain {DEMO.chainId}</span>
          </span>
          <WalletMenu
            address={address}
            onConnect={connect}
            onDisconnect={() => {
              setAddress(null);
              // A proof is bound to the address that swaps, so it cannot survive
              // a disconnect.
              setProof(null);
              proofStore.clear();
              setError(null);
            }}
          />
        </div>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 300px) minmax(0, 1fr) minmax(280px, 330px)", gap: 24, alignItems: "start" }}>
        <DiverPanel
          address={address}
          proof={proof}
          onGearUp={gearUp}
          gearingUp={gearingUp}
          error={error}
        />

        {rpContext && (
          <IDKitRequestWidget
            /* Remount on a new context rather than reusing a stale bridge
               session, which would silently poll for a proof nobody is sending. */
            key={rpContext.nonce}
            app_id={APP_ID}
            action={DEMO.worldIdAction}
            rp_context={rpContext}
            /* v4 only. `true` would let World App fall back to a 3.0 payload,
               which our guard structurally cannot verify — different proof
               system, different contract. */
            allow_legacy_proofs={false}
            /* Ask World App to check a live human is present. Note the result
               (`user_presence_completed`) is off-chain JSON only: v4's on-chain
               verify() has no presence parameter, so the contract cannot check
               it. Requested because it is the right signal to ask for, not
               because it is enforceable on-chain. */
            require_user_presence={REQUIRE_PRESENCE}
            /* Must match the verifier the router was deployed against — staging
               and production are separate identity trees. Derived, not configured. */
            environment={ENV_OVERRIDE ?? WORLD_ID_ENVIRONMENT}
            preset={proofOfHuman({ signal: address ?? undefined })}
            open={widgetOpen}
            onOpenChange={(o) => {
              setWidgetOpen(o);
              if (!o) setGearingUp(false);
            }}
            handleVerify={(result) => {
              // Fires before onSuccess. Logging both distinguishes "the bridge
              // never returned" from "the bridge returned and our parsing threw".
              console.info("[IDKit] handleVerify", result);
            }}
            onSuccess={(result) => {
              console.info("[IDKit] onSuccess", result);
              onProof(result);
            }}
            onError={(code, debugReport) => {
              setGearingUp(false);
              // The report is the only thing that names the actual cause; put it
              // in the console in full rather than truncating it into the UI.
              console.error("[IDKit]", code, debugReport);

              // World ID caps one proof per (identity, rp, action) at the
              // ISSUANCE layer, so a second gear-up for the same action is
              // refused before any contract is involved. Nothing in our stack is
              // wrong when this happens, so say so rather than implying a fault.
              if (code === "nullifier_replayed" || code === "max_verifications_reached") {
                setError(
                  `World ID has already issued this identity a proof for "${DEMO.worldIdAction}", and it ` +
                    "caps that at one per action — so it will not issue another. Not a ScubaSwap error: " +
                    "the on-chain guard would happily accept a second proof. Register a new action and " +
                    "redeploy with WORLD_ID_ACTION set to it, or use a different World ID.",
                );
                return;
              }

              setError(
                `World ID error: ${code}. Full debug report logged to the console. ` +
                  `Requested env=${ENV_OVERRIDE ?? WORLD_ID_ENVIRONMENT}, ` +
                  `app_id=${APP_ID.slice(0, 12)}…, action=${DEMO.worldIdAction}, ` +
                  `rp_id=${DEMO.worldIdRpId ?? "?"}`,
              );
            }}
          />
        )}

        <DepthPanel
          amount={amount}
          setAmount={setAmount}
          takerData={takerData}
          account={address ?? undefined}
          verified={Boolean(proof)}
          onSwap={dive}
          busy={busy}
        />

        <DiveComputer programKey={programKey} activePc={activePc} failedPc={failedPc} gas={gas} />
      </div>

      <footer className="mono" style={{ marginTop: 40, fontSize: 11.5, color: "var(--locked)", lineHeight: 1.7 }}>
        Every quote on this page is a live <code>quote()</code> against the shipped Aqua
        programs — nothing is simulated. Mask and tank are visual roadmap; v1 attests
        personhood only.
      </footer>
    </div>
  );
}
