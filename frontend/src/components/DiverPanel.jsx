/**
 * Diver panel — avatar, gear checklist, and the certification card.
 *
 * Section 04 of the identity doc drives the copy: the state title and blurb are
 * a function of which gear is on.
 *
 * One deviation from the doc: the doc renders unearned gear as a dashed outline.
 * In practice that read as a broken render rather than a roadmap — both on the
 * avatar (where ghost gear hovers around the swimmer) and in the list. Unearned
 * gear is therefore not drawn on the avatar at all, and the checklist and card
 * use a flat grey disabled treatment instead of dashes.
 */

import { useEffect, useState } from "react";
import Diver from "./Diver";

const GEAR = [
  { key: "wetsuit", label: "Wetsuit", attests: "World ID · personhood", depth: "−10 m" },
  { key: "mask", label: "Mask", attests: "Age attestation", depth: "−30 m" },
  { key: "tank", label: "Tank", attests: "Jurisdiction", depth: "−30 m" },
];

export default function DiverPanel({ address, proof, onGearUp, gearingUp, error }) {
  const [showCert, setShowCert] = useState(false);

  // v1 earns only the wetsuit.
  //
  // Mask and tank are drawn `off`, not `locked`: a dashed outline of absent gear
  // floating on the avatar reads as a rendering glitch rather than "coming
  // later". The roadmap is carried by the checklist rows and the card chips,
  // which use a flat grey disabled treatment. The Diver component still supports
  // `locked` for when the attestations actually land.
  // Explicit rather than relying on the component default, so the intent is
  // readable here rather than needing a look at Diver's signature.
  const avatarState = { wetsuit: proof ? "on" : "off", mask: "off", tank: "off" };

  // What the checklist and certification card describe, which is a different
  // question from what the avatar wears.
  const gearState = { wetsuit: proof ? "on" : "off", mask: "locked", tank: "locked" };

  const title = proof ? "Wetsuit on · human tier, −10 m" : "Unverified swimmer · surface only";
  const blurb = proof
    ? "Personhood proven. The proof is spent on your next dive — one proof, one swap."
    : "Anyone can swim at the surface. Prove personhood to drop to −10 m and a lower fee.";

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <header>
        <div className="eyebrow" style={{ color: "var(--midwater)" }}>
          Diver
        </div>
        <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 18, marginTop: 4 }}>{title}</div>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: "#4a5f6d", margin: "8px 0 0" }}>{blurb}</p>
      </header>

      <div style={{ background: "var(--paper)", borderRadius: 14, padding: 16, display: "flex", justifyContent: "center" }}>
        <Diver {...avatarState} width={190} />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {GEAR.map((g) => {
          const s = gearState[g.key];
          return (
            <div
              key={g.key}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                gap: 10,
                alignItems: "center",
                padding: "10px 12px",
                borderRadius: 10,
                // A solid grey fill is the whole disabled affordance — no dashed
                // border on top of it. Dashes plus grey is two signals for one
                // state, and it was the dashes that read as broken.
                background: s === "on" ? "rgba(55,211,146,0.12)" : s === "locked" ? "var(--shell)" : "var(--paper)",
                border: "1.5px solid transparent",
              }}
            >
              <span
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: s === "on" ? "var(--verified)" : s === "locked" ? "rgba(138,154,165,0.3)" : "transparent",
                  border: s === "on" || s === "locked" ? "none" : "1.5px solid var(--locked)",
                }}
              />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: s === "locked" ? "var(--locked)" : "var(--abyss)" }}>
                  {g.label}
                </div>
                <div className="mono" style={{ fontSize: 11, color: "var(--locked)" }}>
                  {g.attests} · {g.depth}
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: 10,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: s === "on" ? "var(--verified)" : "var(--locked)",
                  // The v2 marker gets a pill so it reads as a status badge
                  // rather than as a truncated word.
                  ...(s === "locked" && {
                    background: "rgba(138,154,165,0.22)",
                    padding: "3px 7px",
                    borderRadius: 5,
                  }),
                }}
              >
                {s === "on" ? "on" : s === "locked" ? "v2" : "off"}
              </span>
            </div>
          );
        })}
      </div>

      <button
        onClick={onGearUp}
        disabled={gearingUp || !address}
        style={{
          background: proof ? "var(--paper)" : "var(--coral)",
          color: proof ? "var(--abyss)" : "#fff",
          border: proof ? "1px solid var(--locked)" : "none",
          borderRadius: 10,
          padding: "13px 18px",
          fontFamily: "var(--display)",
          fontWeight: 700,
          fontSize: 15,
          cursor: gearingUp || !address ? "not-allowed" : "pointer",
          opacity: gearingUp || !address ? 0.5 : 1,
        }}
      >
        {gearingUp ? "Waiting for World App…" : proof ? "Re-gear (new proof)" : "Gear up with World ID"}
      </button>

      {error && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--coral)", lineHeight: 1.5, background: "rgba(255,122,77,0.1)", padding: "10px 12px", borderRadius: 8 }}>
          {error}
        </div>
      )}

      {proof && (
        <button
          onClick={() => setShowCert(true)}
          style={{ background: "none", border: "none", padding: 0, color: "var(--midwater)", fontSize: 13, cursor: "pointer", textAlign: "left", textDecoration: "underline" }}
        >
          View certification card
        </button>
      )}

      {showCert && (
        <CertCard address={address} proof={proof} avatarState={avatarState} gearState={gearState} onClose={() => setShowCert(false)} />
      )}
    </section>
  );
}

/**
 * Dive certification card — 640 × 363, fully flat, every field a text node so
 * real proof data drops straight in (section 08).
 *
 * Everything shown is from the actual IDKit response. The nullifier is truncated
 * for display only: it is a persistent pseudonymous identifier, so rendering it
 * in full on a shareable card would be a privacy footgun.
 */
function CertCard({ address, proof, avatarState, gearState, onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows = [
    ["Diver", address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"],
    ["Max depth", "−10 m"],
    ["Issued", new Date().toISOString().slice(0, 10)],
    ["Nullifier", proof ? `${proof.nullifier.slice(0, 8)}…${proof.nullifier.slice(-2)}` : "—"],
    ["Expires", proof ? new Date(proof.expiresAtMin * 1000).toISOString().slice(11, 19) + " UTC" : "—"],
  ];

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(10,34,51,0.72)", display: "grid", placeItems: "center", padding: 24, zIndex: 50 }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ width: 640, maxWidth: "100%", background: "var(--paper)", borderRadius: 16, overflow: "hidden", boxShadow: "0 24px 70px rgba(10,34,51,0.4)" }}
      >
        <div style={{ background: "var(--abyss)", color: "#fff", padding: "18px 26px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
          <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 19 }}>ScubaSwap</span>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="eyebrow" style={{ color: "var(--sunlit)" }}>
              Dive certification
            </span>
            {/* Backdrop click and Escape also close, but neither is discoverable. */}
            <button
              onClick={onClose}
              aria-label="Close certification card"
              style={{
                background: "rgba(255,255,255,0.12)",
                border: "none",
                color: "#fff",
                borderRadius: 8,
                width: 30,
                height: 30,
                fontSize: 17,
                lineHeight: 1,
                cursor: "pointer",
              }}
            >
              ×
            </button>
          </div>
        </div>

        <div style={{ padding: 26, display: "grid", gridTemplateColumns: "150px 1fr", gap: 24 }}>
          <Diver {...avatarState} width={130} />
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "grid", gridTemplateColumns: "92px 1fr", gap: 12, alignItems: "baseline" }}>
                <span className="eyebrow" style={{ color: "var(--locked)" }}>
                  {k}
                </span>
                <span className="mono" style={{ fontSize: 13.5 }}>
                  {v}
                </span>
              </div>
            ))}
            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              {["Wetsuit", "Mask", "Tank"].map((g, i) => {
                const s = [gearState.wetsuit, gearState.mask, gearState.tank][i];
                return (
                  <span
                    key={g}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: "5px 9px",
                      borderRadius: 6,
                      background: s === "on" ? "var(--verified)" : "var(--shell)",
                      color: s === "on" ? "var(--abyss)" : "var(--locked)",
                      border: "none",
                    }}
                  >
                    {g}
                  </span>
                );
              })}
            </div>
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--mist)", padding: "14px 26px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="mono" style={{ fontSize: 11, color: "var(--locked)" }}>
            Issued by World ID · verified on 1inch Aqua
          </span>
          <span className="mono" style={{ fontSize: 11, color: "var(--verified)" }}>
            ● proof valid
          </span>
        </div>
      </div>
    </div>
  );
}
