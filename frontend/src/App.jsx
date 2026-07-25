/**
 * ScubaSwap — three panels: diver (identity), depth (the trade), dive computer
 * (what actually executed).
 *
 * Flow: connect → live quotes for every band → gear up with World ID → the
 * wetsuit goes on and the human tier unlocks → dive.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { CredentialRequest, IDKitRequestWidget, setDebug } from "@worldcoin/idkit";

import { BubblesMark } from "./components/Diver";
import DiverPanel from "./components/DiverPanel";
import DepthPanel from "./components/DepthPanel";
import DiveComputer from "./components/DiveComputer";
import EnvInfo from "./components/EnvInfo";
import WalletMenu, { clearDisconnected, wasDisconnected } from "./components/WalletMenu";
import {
  AVAILABLE_ENVIRONMENTS,
  DEFAULT_ENVIRONMENT,
  DEMO,
  ENVIRONMENTS,
  IS_MAINNET,
  PAIR,
  demoChain,
  freshAction,
  erc20Abi,
  orderTuple,
  programsFor,
  publicClient,
  routerAbi,
  routerFor,
  walletClientFrom,
  decodeRevert,
} from "./lib/chain";
import { environmentForVerifier, fetchRpContext } from "./lib/worldid";
import * as proofStore from "./lib/proofStore";
import { buildTakerData, proofFromIdkitResult } from "../../packages/sdk/takerArgs.mjs";

const APP_ID = import.meta.env.VITE_WORLD_APP_ID ?? "";
const REPO_URL = "https://github.com/shuva10v/scuba-swap";
const EVENT_URL = "https://ethglobal.com/events/lisbon2026";
// Served by ETHGlobal. 624×333 SVG, so the intrinsic ratio is fixed and width/height
// below are set explicitly to reserve the space — a footer logo that arrives late and
// reflows the row is worse than one that is 30ms slower.
const EVENT_LOGO = "https://ethglobal.storage/events/lisbon2026/logo/default";
const EVENT_LOGO_HEIGHT = 36;
const EVENT_LOGO_WIDTH = Math.round((EVENT_LOGO_HEIGHT * 624) / 333);

// "Verification unavailable / contact the website owner" is World App refusing the
// REQUEST rather than the proof, and the response payload is encrypted to the
// app's key, so it tells an integrator nothing. IDKit's debug mode produces a
// readable report instead; on in dev only.
if (import.meta.env.DEV) setDebug(true);

// Which environment the page starts on. The toggle takes over from here; this only
// picks the initial value, and a stored choice wins over both.
const ENV_OVERRIDE = import.meta.env.VITE_WORLD_ENV;
const ENV_STORAGE_KEY = "scubaswap:environment";

function initialEnvironment() {
  try {
    const stored = localStorage.getItem(ENV_STORAGE_KEY);
    if (stored && ENVIRONMENTS[stored]) return stored;
  } catch {
    /* storage disabled */
  }
  if (ENV_OVERRIDE && ENVIRONMENTS[ENV_OVERRIDE]) return ENV_OVERRIDE;
  return DEFAULT_ENVIRONMENT;
}

/** Mirrors WorldIdGuard.PROOF_FRESHNESS_WINDOW (15 minutes). */
const FRESHNESS_WINDOW_MS = 15 * 60 * 1000;
const REQUIRE_PRESENCE = import.meta.env.VITE_REQUIRE_PRESENCE !== "false";

/**
 * Whether to ask World App for a liveness check.
 *
 * Requested on production, never on staging: the simulator has no camera and no
 * person in front of it, so it cannot complete a presence check and asking for one
 * makes it refuse the whole request. That refusal surfaces as a bare
 * "Something went wrong" with no reason — the response is encrypted to the app's
 * key — so it is worth not asking rather than discovering it each time.
 *
 * `VITE_REQUIRE_PRESENCE=false` still turns it off for production, which is how a
 * failing production request gets bisected.
 */
function presenceRequiredFor(environment) {
  return environment !== "staging" && REQUIRE_PRESENCE;
}

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
  // The action for the dive currently being geared up. Fresh per attempt, and held
  // in state because the rp context, the widget and the proof encoder must all
  // agree on the same string — deriving it three times would produce three
  // different timestamps.
  const [diveAction, setDiveAction] = useState(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [gearingUp, setGearingUp] = useState(false);

  // Which World ID environment — and therefore which router — this page is driving.
  // Must be chosen before gearing up: IDKit takes the environment as a prop and the
  // QR encodes a bridge URL for it, so this decides which World App can answer, not
  // just which contract verifies.
  const [environment, setEnvironment] = useState(initialEnvironment);
  const router = routerFor(environment);
  const programs = programsFor(environment);

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
    proofStore.load({ address, windowMs: FRESHNESS_WINDOW_MS, environment, router }).then((restored) => {
      if (!cancelled && restored) {
        console.info("[proof] restored from storage");
        setProof(restored);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [address, proof, environment, router]);

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

  // The tier is chosen, not derived. It used to follow `proof` automatically, which
  // meant the two prices could never be compared: gearing up silently moved you to
  // the human tier and the surface number became hypothetical. Tapping a band picks
  // the program the dive actually executes, so the fee difference is something you
  // read off the chain rather than take on trust.
  //
  // Gearing up still *promotes* you once — earning the wetsuit and staying at the
  // surface would be a strange default — but never demotes you afterwards.
  const [tier, setTier] = useState("surface");
  // Live quotes, reported up by DepthPanel so the dive computer shows the same
  // figures rather than issuing its own calls.
  const [quotes, setQuotes] = useState({});
  const promotedRef = useRef(false);
  useEffect(() => {
    if (proof && !promotedRef.current) {
      promotedRef.current = true;
      setTier("human");
    }
    if (!proof) promotedRef.current = false;
  }, [proof]);

  const programKey = tier;

  /**
   * The "this dive" summary, straight from the live quotes.
   *
   * Undefined entries stay undefined rather than becoming zero: a band that has not
   * quoted yet, or whose guard refused, must not render as "0.00 USDC" — that reads
   * as a real price of nothing.
   */
  const thisDive = (() => {
    const activeOut = quotes[tier]?.amountOut;
    const surfaceOut = quotes.surface?.amountOut;
    if (activeOut === undefined) return null;
    const money = (v) =>
      Number(formatUnits(v, PAIR.buyDecimals)).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
    let vsSurface = "—";
    if (surfaceOut !== undefined) {
      if (tier === "surface") vsSurface = "baseline";
      else {
        const d = activeOut - surfaceOut;
        vsSurface = `${d >= 0n ? "+" : "−"}${money(d < 0n ? -d : d)} USDC`;
      }
    }
    return { out: money(activeOut), vsSurface };
  })();
  // Guarded programs need the proof in takerArgs; the surface program ignores it.
  const takerData = buildTakerData({ isExactIn: true, isAToB: PAIR.isAToB, instructionsArgs: proof?.args ?? "0x" });

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
      const action = freshAction();
      setDiveAction(action);
      setRpContext(await fetchRpContext(action));
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
      const args = proofFromIdkitResult(result, diveAction);
      const r = result.responses.find((x) => x.identifier === "proof_of_human");
      const expiresAtMin = Number(r.expires_at_min);
      console.info("[IDKit] parsed →", {
        takerArgsBytes: (args.length - 2) / 2,
        nullifier: `${r.nullifier.slice(0, 12)}…`,
        expiresAtMin,
        validForSeconds: expiresAtMin - Math.floor(Date.now() / 1000),
        presence: result.user_presence_completed,
      });
      const minted = { args, nullifier: r.nullifier, nonce: result.nonce, expiresAtMin, action: diveAction };
      setProof(minted);
      proofStore.save(minted, { address, environment, router });
      setGearingUp(false);
      setWidgetOpen(false);
    } catch (e) {
      // The SDK rejects a v3 payload explicitly rather than letting it fail
      // on-chain as an opaque revert.
      setGearingUp(false);
      setError(e.message);
      }
    },
    // diveAction must be a dependency: it changes per gear-up, and a stale closure
    // would encode the proof against the previous dive's action (or null on the
    // first attempt), which the guard would reject as not matching the prefix.
    [address, diveAction, environment, router],
  );

  const dive = useCallback(async () => {
    if (!address) return;
    setBusy(true);
    setError(null);
    setFailedPc(null);
    setActivePc(0);
    setGas(null);

    const program = programs[programKey];
    try {
      const wallet = walletClientFrom(window.ethereum);
      // parseUnits, not float math: `Number(amount) * 1e18` silently loses the low
      // digits above ~2^53 base units, and the sold side is not always 18dp.
      const amountIn = parseUnits(String(amount), PAIR.sellDecimals);

      // Approve once; the router pulls tokenIn and pushes it into Aqua itself.
      const allowance = await publicClient.readContract({
        address: DEMO.weth,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address, router],
      });
      if (allowance < amountIn) {
        const hash = await wallet.writeContract({
          account: address,
          address: DEMO.weth,
          abi: erc20Abi,
          functionName: "approve",
          args: [router, 2n ** 256n - 1n],
        });
        await publicClient.waitForTransactionReceipt({ hash });
      }

      const hash = await wallet.writeContract({
        account: address,
        address: router,
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
        proofStore.clear(environment);
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
    <div style={{ maxWidth: 1560, margin: "0 auto", padding: "28px 32px 44px" }}>
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 24,
          marginBottom: 30,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <BubblesMark size={62} />
          <div>
            <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 30, letterSpacing: "-0.02em", lineHeight: 1 }}>
              ScubaSwap
            </div>
            <div
              className="mono"
              style={{ fontSize: 12, letterSpacing: "0.14em", color: "var(--locked)", marginTop: 6, textTransform: "uppercase" }}
            >
              1inch Aqua × World ID
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {/* Environment switch. Only rendered when the deployment actually has
              more than one router — a single-router config gets no dead control.

              Switching drops the current proof: it was minted against one identity
              tree and the other router's verifier will not accept it. Discarding it
              is the honest move, because the alternative is showing a wetsuit that
              silently prices at the open tier. */}
          {AVAILABLE_ENVIRONMENTS.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <div
              style={{
                display: "flex",
                background: "var(--paper)",
                border: "1px solid var(--edge)",
                borderRadius: 10,
                padding: 4,
                gap: 4,
              }}
            >
              {AVAILABLE_ENVIRONMENTS.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    if (name === environment) return;
                    setEnvironment(name);
                    try {
                      localStorage.setItem(ENV_STORAGE_KEY, name);
                    } catch {
                      /* storage disabled; the choice just will not persist */
                    }
                    // Drop it from *state* only. The stored proof for the env we are
                    // leaving stays on disk, so switching back restores the wetsuit
                    // rather than demanding another liveness check — nothing about
                    // switching invalidates a proof for the tree it was minted in.
                    // The restore effect then loads whatever the new env has, if any.
                    setProof(null);
                    setError(null);
                    setGas(null);
                    setActivePc(null);
                    setFailedPc(null);
                  }}
                  className="mono"
                  style={{
                    border: "none",
                    padding: "7px 14px",
                    borderRadius: 7,
                    fontSize: 13,
                    cursor: name === environment ? "default" : "pointer",
                    background: name === environment ? "var(--hull)" : "transparent",
                    color: name === environment ? "#fff" : "var(--locked)",
                  }}
                  title={
                    name === environment
                      ? `router ${routerFor(name)}`
                      : `switch to the ${name} router (${routerFor(name).slice(0, 8)}…) — discards the current proof`
                  }
                >
                  {name}
                </button>
              ))}
            </div>
            <EnvInfo environment={environment} />
            </div>
          )}

          {/* Inline SVG rather than an icon font or a hosted image — one fewer request
              for a 300-byte glyph, and it inherits currentColor. */}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            aria-label="ScubaSwap on GitHub"
            title="Source on GitHub"
            style={{ display: "flex", alignItems: "center", color: "var(--locked)" }}
          >
            <svg width="19" height="19" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.92-.88-2.92-2.9 0-.58.21-1.06.55-1.43-.05-.13-.24-.66.05-1.37 0 0 .59-.19 1.94.72a5.4 5.4 0 0 1 1.47-.2c.5 0 1 .07 1.47.2 1.35-.92 1.94-.72 1.94-.72.29.71.1 1.24.05 1.37.34.37.55.85.55 1.43 0 2.03-1.15 2.7-2.93 2.9.3.26.57.77.57 1.56 0 1.11-.01 2.01-.01 2.29 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>

          {/* Explicitly labelled: an unlabelled truncated address sitting next
              to a Connect button reads as a connected account, which this is
              not — it is the contract the UI is pointed at. */}
          <span className="mono" style={{ fontSize: 12, color: "var(--locked)", textAlign: "right", lineHeight: 1.5 }}>
            <span style={{ opacity: 0.7 }}>router</span> {router.slice(0, 6)}…{router.slice(-4)}
            <br />
            <span style={{ opacity: 0.7 }}>{IS_MAINNET ? "World Chain" : "World Chain fork"} · chain {DEMO.chainId}</span>
          </span>
          <WalletMenu
            address={address}
            onConnect={connect}
            onDisconnect={() => {
              setAddress(null);
              // A proof is bound to the address that swaps, so it cannot survive a
              // disconnect — in any environment, not just the active one.
              setProof(null);
              proofStore.clearAll();
              setError(null);
            }}
          />
        </div>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "340px minmax(560px, 1fr) 400px",
          gap: 34,
          alignItems: "start",
        }}
      >
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
            action={diveAction}
            rp_context={rpContext}
            /* v4 only. `true` would let World App fall back to a 3.0 payload,
               which our guard structurally cannot verify — different proof
               system, different contract. */
            allow_legacy_proofs={false}
            /* Ask World App to check a live human is present — production only; the
               simulator cannot do it. Note the result (`user_presence_completed`) is
               off-chain JSON only: v4's on-chain verify() has no presence parameter,
               so the contract cannot check it. Requested because it is the right
               signal to ask for, not because it is enforceable on-chain. */
            require_user_presence={presenceRequiredFor(environment)}
            /* Must match the verifier the router was deployed against — staging
               and production are separate identity trees. Derived, not configured. */
            environment={environment}
            /* `constraints` rather than `preset`: same request — one proof_of_human
               credential bound to the taker address — but the explicit form, and the
               only one that can express the other two constraints if we ever need them.

               Both are deliberately left unset, and neither is a free choice:

               `genesis_issued_at_min` is a public input to verify(), taken from the
               *program's* maker policy on chain. Our programs ship 0, so requesting a
               non-zero constraint here would make every proof fail verification until
               the shipped policy matched it.

               `expires_at_min` would be actively harmful. The guard's freshness check
               is `expiresAtMin + 15min >= block.timestamp`, so asking World App for a
               credential valid far into the future would push `expiresAtMin` forward
               and make that check pass for as long as the request asked — turning the
               anti-bot window off from the client side. Leaving it unset yields the
               issuance-time value the window is designed around. */
            constraints={CredentialRequest("proof_of_human", { signal: address ?? undefined })}
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
                  `World ID has already issued this identity a proof for "${diveAction}", and it ` +
                    "caps that at one per action — so it will not issue another. Not a ScubaSwap error: " +
                    "the on-chain guard would happily accept a second proof. Register a new action and " +
                    "redeploy with WORLD_ID_ACTION set to it, or use a different World ID.",
                );
                return;
              }

              setError(
                `World ID error: ${code}. Full debug report logged to the console. ` +
                  `Requested env=${environment}, ` +
                  `app_id=${APP_ID.slice(0, 12)}…, action=${diveAction}, ` +
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
          programs={programs}
          router={router}
          tier={tier}
          setTier={setTier}
          onQuotes={setQuotes}
        />

        <DiveComputer
          programKey={programKey}
          programs={programs}
          activePc={activePc}
          failedPc={failedPc}
          gas={gas}
          thisDive={thisDive}
        />
      </div>

      <footer
        style={{
          marginTop: 40,
          paddingTop: 22,
          borderTop: "1px solid #cbd9de",
          display: "flex",
          alignItems: "center",
          gap: 18,
          flexWrap: "wrap",
        }}
      >
        {/* The real event logo replaces the placeholder mark. It is a wordmark, so the
            separate "ETHGLOBAL" label the design carried next to it is dropped —
            keeping both would say the name twice. */}
        <a
          href={EVENT_URL}
          target="_blank"
          rel="noreferrer noopener"
          style={{ display: "flex", alignItems: "center", gap: 14, textDecoration: "none", color: "var(--abyss)" }}
        >
          <img
            src={EVENT_LOGO}
            alt="ETHGlobal Lisbon 2026"
            width={EVENT_LOGO_WIDTH}
            height={EVENT_LOGO_HEIGHT}
            style={{ display: "block" }}
          />
          <span style={{ fontSize: 15, color: "#4a626c" }}>Built during ETHGlobal Lisbon 2026</span>
        </a>

        <div style={{ flex: 1 }} />

        {/* The claim the whole page rests on, kept in the footer rather than dropped
            for the new links: every figure above is a live call, and the roadmap gear
            is labelled as roadmap. */}
        <span className="mono" style={{ fontSize: 11.5, color: "var(--locked)", lineHeight: 1.7, maxWidth: 520 }}>
          Every quote is a live <code>quote()</code> against the shipped Aqua programs —
          nothing is simulated. Mask and tank are roadmap; v1 attests personhood only.
        </span>

        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            background: "var(--hull)",
            color: "#fff",
            textDecoration: "none",
            borderRadius: 12,
            padding: "13px 20px",
            fontSize: 15,
            fontWeight: 700,
            fontFamily: "var(--display)",
          }}
        >
          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-2.92-.88-2.92-2.9 0-.58.21-1.06.55-1.43-.05-.13-.24-.66.05-1.37 0 0 .59-.19 1.94.72a5.4 5.4 0 0 1 1.47-.2c.5 0 1 .07 1.47.2 1.35-.92 1.94-.72 1.94-.72.29.71.1 1.24.05 1.37.34.37.55.85.55 1.43 0 2.03-1.15 2.7-2.93 2.9.3.26.57.77.57 1.56 0 1.11-.01 2.01-.01 2.29 0 .21.15.46.55.38A7.99 7.99 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
          </svg>
          GitHub repo
        </a>
      </footer>
    </div>
  );
}
