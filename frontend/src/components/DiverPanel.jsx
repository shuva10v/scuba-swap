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

import { useState } from "react";
import Diver from "./Diver";

const GEAR = [
  { key: "wetsuit", label: "Wetsuit", attests: "World ID · personhood", depth: "−10 m" },
  { key: "mask", label: "Mask", attests: "Age attestation", depth: "−30 m" },
  { key: "tank", label: "Tank", attests: "Jurisdiction", depth: "−30 m" },
];

export default function DiverPanel({ address, proof, onGearUp, gearingUp, error }) {
  // Open by default: the card matters the moment a proof lands.
  const [showCert, setShowCert] = useState(true);

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
        <div
          style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 26, letterSpacing: "-0.02em", margin: "10px 0 8px" }}
        >
          {title}
        </div>
        <p style={{ fontSize: 15, lineHeight: 1.5, color: "#4a626c", margin: 0, textWrap: "pretty" }}>{blurb}</p>
      </header>

      {/* The diver idles. Ambient motion, and the only animation in the column. */}
      <div
        style={{
          background: "var(--paper)",
          borderRadius: 18,
          padding: "26px 24px 20px",
          display: "flex",
          justifyContent: "center",
        }}
      >
        <div style={{ animation: "bob 4.5s ease-in-out infinite" }}>
          <Diver {...avatarState} width={200} />
        </div>
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
                background: s === "on" ? "#d8f7e8" : s === "locked" ? "#dde6ea" : "var(--paper)",
                border: s === "on" ? "1px solid #9fe8c6" : "1px solid transparent",
                opacity: s === "locked" ? 0.72 : 1,
                padding: "14px 16px",
                borderRadius: 12,
              }}
            >
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  background: s === "on" ? "var(--verified)" : s === "locked" ? "#c3d0d5" : "transparent",
                  border: s === "on" || s === "locked" ? "none" : "1.5px solid var(--locked)",
                }}
              />
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: s === "locked" ? "#5c7480" : "var(--abyss)" }}>
                  {g.label}
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--locked-soft)", marginTop: 3 }}>
                  {g.attests} · {g.depth}
                </div>
              </div>
              <span
                className="mono"
                style={{
                  fontSize: s === "on" ? 12 : 11,
                  fontWeight: s === "on" ? 700 : 400,
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  color: s === "on" ? "var(--verified-deep)" : "var(--locked-soft)",
                  // The v2 marker gets a pill so it reads as a status badge
                  // rather than as a truncated word.
                  ...(s === "locked" && {
                    background: "#cfdadf",
                    padding: "4px 8px",
                    borderRadius: 6,
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
          width: "100%",
          background: proof ? "var(--paper)" : "var(--coral)",
          color: proof ? "var(--abyss)" : "#fff",
          border: proof ? "1px solid var(--edge)" : "none",
          borderRadius: 14,
          padding: 20,
          fontFamily: "var(--display)",
          fontWeight: 700,
          fontSize: 17,
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

      {proof && <CertCard address={address} proof={proof} gearState={gearState} open={showCert} onToggle={() => setShowCert((o) => !o)} />}
    </section>
  );
}

/**
 * Dive certification card — every field a text node so real proof data drops
 * straight in (section 08).
 *
 * Inline and collapsible rather than a modal. As a modal it was a dead end: you
 * could not read the proof's expiry while watching the bands it unlocked, which is
 * exactly the comparison the card exists to support. Open by default, because the
 * moment it becomes interesting is the moment a proof arrives.
 *
 * Everything shown is from the actual IDKit response. The nullifier is truncated
 * for display only: it is a persistent pseudonymous identifier, so rendering it in
 * full on a card built to be shown to an audience would be a privacy footgun.
 */
function CertCard({ address, proof, gearState, open, onToggle }) {
  const rows = [
    ["Diver", address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—"],
    ["Max depth", "−10 m"],
    ["Issued", new Date().toISOString().slice(0, 10)],
    ["Nullifier", proof ? `${proof.nullifier.slice(0, 8)}…${proof.nullifier.slice(-2)}` : "—"],
    ["Expires", proof ? `${new Date(proof.expiresAtMin * 1000).toISOString().slice(11, 19)} UTC` : "—"],
  ];

  return (
    <div style={{ borderRadius: 16, overflow: "hidden", background: "var(--paper)" }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 12,
          background: "var(--abyss)",
          color: "#fff",
          padding: "14px 18px",
          border: "none",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span className="mono" style={{ fontSize: 12, letterSpacing: ".14em", color: "var(--sunlit)", flex: 1 }}>
          DIVE CERTIFICATION
        </span>
        <span className="mono" style={{ fontSize: 12, color: "#9fc3ce" }}>
          {open ? "hide ▴" : "show ▾"}
        </span>
      </button>

      {open && (
        <div style={{ padding: 18 }}>
          <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13 }}>
            {rows.map(([k, v]) => (
              <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                <span style={{ color: "var(--locked-soft)", letterSpacing: ".08em", textTransform: "uppercase" }}>{k}</span>
                <span>{v}</span>
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            {["Wetsuit", "Mask", "Tank"].map((g) => {
              const on = gearState[g.toLowerCase()] === "on";
              return (
                <span
                  key={g}
                  className="mono"
                  style={{
                    fontSize: 12,
                    fontWeight: on ? 700 : 400,
                    background: on ? "var(--verified)" : "var(--mist)",
                    color: on ? "var(--verified-ink)" : "#8fa4ac",
                    padding: "8px 14px",
                    borderRadius: 8,
                  }}
                >
                  {g}
                </span>
              );
            })}
          </div>

          <div
            className="mono"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginTop: 16,
              paddingTop: 14,
              borderTop: "1px solid var(--mist)",
              fontSize: 11,
              color: "var(--locked-soft)",
            }}
          >
            <span style={{ flex: 1 }}>Issued by World ID · verified on 1inch Aqua</span>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--verified)" }} />
            <span style={{ color: "var(--verified-deep)" }}>proof valid</span>
          </div>
        </div>
      )}
    </div>
  );
}
