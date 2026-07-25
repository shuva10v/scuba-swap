/**
 * Dive computer — the decoded program, one row per instruction.
 *
 * This is the panel that makes the project legible. Anyone can claim "a World ID
 * guard runs before the fee"; this shows the actual shipped bytecode with
 * `OnlyHumanTaker` at pc 0 and the fee that follows it. Rows light up as the
 * swap executes, so the guard is visibly the first thing that runs.
 */

import { useMemo } from "react";

import { decodeProgramFromOrderData } from "../lib/program";

export default function DiveComputer({ programKey, programs, activePc, failedPc, gas, thisDive }) {
  const program = programs[programKey];
  const rows = useMemo(() => decodeProgramFromOrderData(program.data), [program.data]);

  return (
    <aside
      style={{
        background: "var(--abyss)",
        color: "#cfe6ee",
        borderRadius: 18,
        padding: "26px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        minWidth: 0,
      }}
    >
      <header>
        <div className="eyebrow" style={{ color: "var(--sunlit)" }}>
          Dive computer
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "10px 0 0" }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--verified)", flexShrink: 0 }} />
          <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 23, color: "#fff", letterSpacing: "-0.02em" }}>
            {program.label} · {program.depth}
          </div>
        </div>
      </header>

      <div className="mono" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.length === 0 && <div style={{ opacity: 0.6 }}>could not decode program</div>}
        {rows.map((r) => {
          const failed = failedPc === r.pc;
          const active = activePc !== null && activePc !== undefined && r.pc <= activePc && !failed;
          return (
            <div
              key={r.pc}
              style={{
                display: "grid",
                gridTemplateColumns: "34px 20px 1fr auto",
                gap: 8,
                alignItems: "baseline",
                padding: "6px 8px",
                borderRadius: 6,
                background: failed ? "rgba(255,122,77,0.18)" : active ? "rgba(55,211,146,0.14)" : "transparent",
                // Rows dim until reached, so the execution order reads at a glance.
                opacity: failed || active ? 1 : 0.5,
                transition: "background 200ms ease, opacity 200ms ease",
              }}
            >
              <span style={{ opacity: 0.5 }}>pc{String(r.pc).padStart(2, "0")}</span>
              <span style={{ opacity: 0.5 }}>{r.opcode.toString(16).padStart(2, "0")}</span>
              <span style={{ color: failed ? "var(--coral)" : r.scuba ? "var(--verified)" : "#fff" }}>
                {r.name}
                {r.scuba && <span style={{ opacity: 0.55 }}> ◂ scuba</span>}
              </span>
              <span style={{ opacity: 0.7, textAlign: "right" }}>{r.detail ?? ""}</span>
            </div>
          );
        })}
      </div>

      <div style={{ height: 1, background: "#14485a" }} />

      {/* Air gauge = gas. Real measured numbers from the Phase 4 gas report; the
          live figure replaces them once a swap has actually run. */}
      <div>
        <div className="eyebrow" style={{ color: "var(--sunlit)", marginBottom: 8 }}>
          Air · gas
        </div>
        <div className="mono" style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 5 }}>
          <GaugeRow label="surface swap" value="~143k" max={620} n={143} />
          <GaugeRow label="guard overhead" value="~26k" max={620} n={26} accent />
          <GaugeRow label="+ groth16 verify" value="~397k" max={620} n={397} />
          {gas != null && <GaugeRow label="this dive" value={`${Math.round(Number(gas) / 1000)}k`} max={620} n={Number(gas) / 1000} live />}
        </div>
        <div style={{ fontSize: 14, color: "#8fb3bf", marginTop: 18, lineHeight: 1.55, textWrap: "pretty" }}>
          Verification is the expensive part, which is the honest argument for the
          tier split: the surface stays cheap for everyone.
        </div>
      </div>

      {/* What the button in front of you is about to do, in four lines. Separate
          from the gauges above because those are about the protocol and this is
          about the trade — and every value is the live quote, not a projection. */}
      <div style={{ height: 1, background: "#14485a" }} />
      <div>
        <div className="eyebrow" style={{ color: "var(--sunlit)", marginBottom: 12 }}>
          This dive
        </div>
        <div className="mono" style={{ display: "flex", flexDirection: "column", gap: 9, fontSize: 14 }}>
          <Row k="tier" v={program.label} />
          <Row k="fee" v={program.feeLabel} />
          <Row k="you receive" v={thisDive?.out ? `${thisDive.out} USDC` : "—"} accent />
          <Row k="vs surface" v={thisDive?.vsSurface ?? "—"} />
        </div>
      </div>
    </aside>
  );
}

function Row({ k, v, accent }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ color: "#8fb3bf" }}>{k}</span>
      <span style={{ color: accent ? "var(--verified)" : "#fff", textAlign: "right" }}>{v}</span>
    </div>
  );
}

function GaugeRow({ label, value, max, n, accent, live }) {
  const pct = Math.min(100, (n / max) * 100);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 52px", gap: 8, alignItems: "center" }}>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.75, marginBottom: 3 }}>
          <span>{label}</span>
        </div>
        <div style={{ height: 5, background: "rgba(255,255,255,0.12)", borderRadius: 3 }}>
          <div
            style={{
              width: `${pct}%`,
              height: "100%",
              borderRadius: 3,
              background: live ? "var(--sunlit)" : accent ? "var(--verified)" : "var(--midwater)",
              transition: "width 400ms ease",
            }}
          />
        </div>
      </div>
      <span style={{ textAlign: "right", opacity: live ? 1 : 0.8, color: live ? "var(--sunlit)" : undefined }}>{value}</span>
    </div>
  );
}
