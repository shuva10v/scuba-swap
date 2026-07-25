/**
 * Wallet button with a copy/disconnect menu.
 *
 * Disconnecting from a dapp is awkward by design: EIP-1193 gives a page no way
 * to revoke its own authorisation, so "disconnect" can mean two different things.
 * This does both, in order:
 *
 *  1. `wallet_revokePermissions` — MetaMask-specific and the only real
 *     disconnect. After it, the wallet genuinely no longer authorises the site.
 *  2. Clear local state and record the intent, for wallets without step 1.
 *
 * Step 2 needs the persisted flag because the app restores connections with
 * `eth_accounts` on mount. Without it, disconnecting then refreshing would
 * silently reconnect — the button would appear broken.
 *
 * Note the flag only ever records "the user asked to stay disconnected". It is
 * never used to claim the opposite: a cached *connected* state could contradict
 * the wallet, and the wallet must win.
 */

import { useEffect, useRef, useState } from "react";

import { explorerAddress } from "../lib/chain";

const DISCONNECTED_KEY = "scubaswap:disconnected";

export function wasDisconnected() {
  try {
    return localStorage.getItem(DISCONNECTED_KEY) === "1";
  } catch {
    return false; // private mode / storage disabled
  }
}

export function clearDisconnected() {
  try {
    localStorage.removeItem(DISCONNECTED_KEY);
  } catch {
    /* ignore */
  }
}

function rememberDisconnected() {
  try {
    localStorage.setItem(DISCONNECTED_KEY, "1");
  } catch {
    /* ignore */
  }
}

export default function WalletMenu({ address, onConnect, onDisconnect }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!address) {
    return (
      <button onClick={onConnect} style={btn(false)}>
        Connect wallet
      </button>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  const disconnect = async () => {
    setOpen(false);
    try {
      // The only real disconnect. Unsupported outside MetaMask, hence the catch.
      await window.ethereum?.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }],
      });
    } catch {
      /* not supported — the flag below is the fallback */
    }
    rememberDisconnected();
    onDisconnect();
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button onClick={() => setOpen((o) => !o)} style={btn(true)} className="mono" aria-expanded={open} aria-haspopup="menu">
        <span style={{ color: "var(--verified)", marginRight: 6 }}>●</span>
        {address.slice(0, 6)}…{address.slice(-4)}
        <span style={{ marginLeft: 8, opacity: 0.5, fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            minWidth: 268,
            background: "var(--paper)",
            borderRadius: 12,
            boxShadow: "0 14px 44px rgba(10,34,51,0.22)",
            padding: 8,
            zIndex: 60,
          }}
        >
          <div style={{ padding: "8px 10px 10px" }}>
            <div className="eyebrow" style={{ color: "var(--locked)", marginBottom: 5 }}>
              Connected
            </div>
            {/* Full address, not truncated — truncation is fine as a button label
                but useless when the point is to read or verify it. */}
            <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all", lineHeight: 1.5 }}>
              {address}
            </div>
          </div>

          <button role="menuitem" onClick={copy} style={item()}>
            {copied ? "Copied" : "Copy address"}
          </button>
          {/* Only on mainnet — the explorer has no view of a local fork, so on the fork
              this would link to an account it has never seen. */}
          {explorerAddress(address) && (
            <a
              role="menuitem"
              href={explorerAddress(address)}
              target="_blank"
              rel="noreferrer noopener"
              style={{ ...item(), display: "block", textDecoration: "none" }}
            >
              View on worldscan ↗
            </a>
          )}
          <button role="menuitem" onClick={disconnect} style={{ ...item(), color: "var(--coral)" }}>
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function btn(connected) {
  return {
    background: connected ? "var(--paper)" : "var(--abyss)",
    color: connected ? "var(--abyss)" : "#fff",
    border: connected ? "1px solid var(--locked)" : "none",
    borderRadius: 10,
    padding: "11px 16px",
    fontSize: 13.5,
    fontWeight: 600,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
  };
}

function item() {
  return {
    display: "block",
    width: "100%",
    textAlign: "left",
    background: "none",
    border: "none",
    borderRadius: 8,
    padding: "10px 10px",
    fontSize: 13,
    fontFamily: "var(--ui)",
    color: "var(--abyss)",
    cursor: "pointer",
  };
}
