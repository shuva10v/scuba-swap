/**
 * "Claim dWETH" — the step before the interesting part.
 *
 * A visitor with an empty wallet cannot exercise any of this, and the guard is the point,
 * so the faucet is deliberately ungated: requiring a proof to get tokens you need in order
 * to test the proof would be a closed loop.
 *
 * The cooldown is read from the chain and counted down locally, so the button says how long
 * rather than just refusing. Only rendered when the sold token is the one the faucet fronts.
 */

import { useCallback, useEffect, useState } from "react";
import { FAUCET, faucetAbi, publicClient, walletClientFrom, decodeRevert } from "../lib/chain";

export default function ClaimButton({ account, token, onClaimed }) {
  const [wait, setWait] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    if (!FAUCET || !account) {
      setWait(null);
      return;
    }
    try {
      const w = await publicClient.readContract({
        address: FAUCET,
        abi: faucetAbi,
        functionName: "waitFor",
        args: [account],
      });
      setWait(Number(w));
    } catch {
      setWait(null);
    }
  }, [account]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Tick locally rather than re-reading every second. The contract is the authority on
  // whether a claim is allowed — this only decides what the label says, and a wrong guess
  // costs a rejected click, not a wrong balance.
  useEffect(() => {
    if (!wait) return;
    const id = setInterval(() => setWait((w) => (w === null ? null : Math.max(0, w - 1))), 1000);
    return () => clearInterval(id);
  }, [wait !== null && wait > 0]);

  const claim = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const wallet = walletClientFrom(window.ethereum);
      const hash = await wallet.writeContract({
        account,
        address: FAUCET,
        abi: faucetAbi,
        functionName: "claim",
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refresh();
      onClaimed?.();
    } catch (e) {
      const d = decodeRevert(e);
      setError(d.message === "ClaimTooSoon" ? "already claimed — wait for the cooldown" : d.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [account, refresh, onClaimed]);

  if (!FAUCET || !account) return null;

  const ready = wait === 0 || wait === null;

  return (
    <>
      <button
        onClick={claim}
        disabled={busy || !ready}
        title={ready ? `Claim 1 ${token.symbol} from the demo faucet` : "Faucet cooldown"}
        className="mono"
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: ".08em",
          color: ready ? "var(--verified-deep)" : "var(--locked-soft)",
          background: ready ? "#d8f7e8" : "var(--mist)",
          border: 0,
          borderRadius: 6,
          padding: "5px 9px",
          cursor: busy || !ready ? "default" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "CLAIMING…" : ready ? `CLAIM ${token.symbol}` : `CLAIM IN ${fmtWait(wait)}`}
      </button>
      {error && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--coral)", width: "100%", marginTop: 6 }}>
          {error}
        </div>
      )}
    </>
  );
}

/** mm:ss under an hour, otherwise whole minutes — a two-digit second count on a 60-minute
 *  wait is precision nobody reads. */
function fmtWait(s) {
  if (s >= 3600) return `${Math.ceil(s / 60)}m`;
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
