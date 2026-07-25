/**
 * The (i) next to the environment toggle.
 *
 * Worth explaining in the UI rather than a README, because picking the wrong side
 * produces the single most confusing failure in this app: World App answers with
 * "Something went wrong" and no reason, or the proof verifies nowhere. The two
 * environments are separate identity trees, so the credential has to come from the
 * matching source — a real World App for production, and for staging the simulator that
 * issues the credential type we ask for. There are two simulators and picking the wrong
 * one is indistinguishable from every other failure, since the error comes back
 * encrypted to the app's key.
 *
 * A click-toggled popover rather than a hover tooltip: it contains a link, and a
 * tooltip that vanishes when the pointer leaves cannot be clicked into.
 */

import { useEffect, useRef, useState } from "react";

// Two different simulators, one per credential family, and they are not
// interchangeable. The wetsuit is a proof of human, which is the worldcoin.org one.
// The orb.engineer simulator issues attestations — the mask and tank on the roadmap.
// Sending a wetsuit request to the attestation simulator fails with an encrypted,
// unreadable payload, indistinguishable from four other misconfigurations.
const SIMULATOR_HUMAN = "https://simulator.worldcoin.org/";
const SIMULATOR_IDENTITY_CHECK = "https://simulator.orb.engineer/";

export default function EnvInfo({ environment }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Dismiss on outside click and on Escape. Both are expected of a popover, and
  // without them the panel covers the toggle it is describing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative", display: "flex", alignItems: "center" }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="What do production and staging mean?"
        aria-expanded={open}
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: "1px solid var(--locked)",
          background: open ? "var(--abyss)" : "transparent",
          color: open ? "#fff" : "var(--locked)",
          fontFamily: "var(--mono)",
          fontSize: 11,
          lineHeight: 1,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          flexShrink: 0,
        }}
      >
        i
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="World ID environments"
          style={{
            position: "absolute",
            top: 26,
            right: 0,
            zIndex: 20,
            width: 310,
            maxWidth: "calc(100vw - 32px)",
            background: "var(--paper)",
            color: "var(--abyss)",
            border: "1px solid var(--mist)",
            borderRadius: 10,
            padding: 14,
            boxShadow: "0 10px 28px rgba(3,26,43,0.18)",
            fontSize: 12.5,
            lineHeight: 1.55,
            textAlign: "left",
          }}
        >
          <div className="eyebrow" style={{ color: "var(--locked)", marginBottom: 8 }}>
            Where the proof comes from
          </div>

          <Row
            name="production"
            active={environment === "production"}
            body={
              <>
                The real <strong>World App</strong>, with your actual Orb-verified credential.
                Includes a liveness check.
              </>
            }
          />
          <Row
            name="staging"
            active={environment === "staging"}
            body={
              <>
                A simulator. Test credentials, no real identity, and no liveness check —
                it cannot do one, so we do not request it.
                <div style={{ marginTop: 6 }}>
                  For the <strong>wetsuit</strong>, use{" "}
                  <Link href={SIMULATOR_HUMAN}>simulator.worldcoin.org</Link>.
                </div>
                <div style={{ marginTop: 4, color: "var(--locked)" }}>
                  <Link href={SIMULATOR_IDENTITY_CHECK}>simulator.orb.engineer</Link> is for{" "}
                  <strong>attestations</strong> — the mask and tank, not the wetsuit. Using
                  it here fails with an unreadable error.
                </div>
              </>
            }
          />

          <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--mist)", color: "var(--locked)" }}>
            Separate identity trees, so a proof from one is rejected by the other. Each
            environment has its own router — pick the side <em>before</em> gearing up, since
            switching discards the current proof.
          </div>
        </div>
      )}
    </div>
  );
}

function Link({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: "var(--blue)", wordBreak: "break-all" }}
    >
      {children}
    </a>
  );
}

function Row({ name, active, body }) {
  return (
    <div style={{ display: "flex", gap: 9, marginBottom: 8 }}>
      <span
        className="mono"
        style={{
          fontSize: 10.5,
          padding: "2px 6px",
          borderRadius: 5,
          flexShrink: 0,
          height: "fit-content",
          // The active side is marked so the panel reads against the current state
          // rather than being a generic glossary.
          background: active ? "var(--abyss)" : "transparent",
          color: active ? "#fff" : "var(--locked)",
          border: active ? "1px solid var(--abyss)" : "1px solid var(--mist)",
        }}
      >
        {name}
      </span>
      <span>{body}</span>
    </div>
  );
}
