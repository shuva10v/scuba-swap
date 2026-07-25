/**
 * Depth panel — ocean cross-section, one band per program.
 *
 * Every number here is a real `quote()` against the shipped programs. Nothing is
 * simulated: if the chain is down the bands say so rather than showing a
 * plausible figure, because a fake quote is the one thing that would make the
 * whole demo dishonest.
 */

import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { PAIR, quote } from "../lib/chain";
import Diver, { Crab } from "./Diver";

const BANDS = [
  {
    key: "surface",
    depth: "0 m",
    title: "Surface",
    blurb: "Open pool. Bots welcome. Worst price.",
    bg: "var(--sunlit)",
    fg: "var(--abyss)",
  },
  {
    key: "human",
    depth: "−10 m",
    title: "Human tier",
    blurb: "Wetsuit required. Reduced fee, same liquidity.",
    bg: "var(--midwater)",
    fg: "#fff",
  },
  {
    key: "reef",
    depth: "−30 m",
    title: "The reef",
    blurb: "Human-only pool. No proof, no entry.",
    bg: "var(--abyss)",
    fg: "var(--sunlit)",
  },
];

export default function DepthPanel({ amount, setAmount, takerData, account, verified, onSwap, busy, programs, router }) {
  const [quotes, setQuotes] = useState({});
  const [botBouncing, setBotBouncing] = useState(false);

  const amountIn = safeParse(amount);

  useEffect(() => {
    if (!amountIn) {
      setQuotes({});
      return;
    }
    let live = true;
    (async () => {
      const entries = await Promise.all(
        BANDS.map(async (b) => [b.key, await quote({ router, program: programs[b.key], amountIn, takerData, account })]),
      );
      if (live) setQuotes(Object.fromEntries(entries));
    })();
    return () => {
      live = false;
    };
  }, [amountIn, takerData, account, router, programs]);

  // The diver sinks to the deepest band the gear allows. v1 earns −10 m; the
  // reef stays locked, so the diver never reaches it.
  const diverBand = verified ? 1 : 0;

  const surfaceOut = quotes.surface?.amountOut;
  const humanOut = quotes.human?.amountOut;
  const saved = surfaceOut && humanOut && humanOut > surfaceOut ? humanOut - surfaceOut : null;

  /**
   * Detect the tiered guard falling through.
   *
   * `JumpIfHumanTaker` is built to never revert — a missing, stale, spent or
   * invalid proof all just mean "pay the open price". Correct for a discount tier,
   * but it makes a rejected proof indistinguishable from no proof: the band simply
   * shows the surface number and says nothing.
   *
   * Holding a proof and still pricing at the surface is exactly that case. The
   * reef runs the same check under `OnlyHumanTaker`, which *does* revert, so its
   * error is the reason the tiered band cannot report for itself.
   */
  const fellThrough = verified && surfaceOut !== undefined && humanOut === surfaceOut;
  const fallThroughReason = quotes.reef?.error;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
      <header>
        <div className="eyebrow" style={{ color: "var(--midwater)" }}>
          Depth · live quotes
        </div>
        <h2 style={{ marginTop: 6 }}>Depth is a permission.</h2>
      </header>

      {/* Swap form. Deliberately boring — the metaphor lives in the frame, not
          in the controls a user has to operate. */}
      <div style={{ background: "var(--paper)", borderRadius: 14, padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
        <label className="eyebrow" style={{ color: "var(--locked)" }} htmlFor="amt">
          You pay
        </label>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input
            id="amt"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            className="mono"
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              fontSize: 30,
              fontWeight: 500,
              color: "var(--abyss)",
              background: "transparent",
            }}
          />
          <span className="mono" style={{ fontSize: 15, color: "var(--locked)", flexShrink: 0 }}>
            WETH → USDC
          </span>
        </div>
        {amount && !amountIn && (
          <div className="mono" style={{ fontSize: 12, color: "var(--coral)" }}>
            not a number
          </div>
        )}
      </div>

      {/* Bands */}
      <div style={{ borderRadius: 14, overflow: "hidden" }}>
        {BANDS.map((band, i) => {
          const q = quotes[band.key];
          // Reachable = the gear allows this depth. Surface is always open; the
          // human tier needs a proof; the reef needs attestations that do not
          // exist in v1, so it is permanently out of reach.
          const reachable = i <= diverBand;
          return (
            <div
              key={band.key}
              style={{
                background: band.bg,
                color: band.fg,
                padding: "20px 22px",
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 16,
                alignItems: "center",
                position: "relative",
                minHeight: 118,
                // The green rule the crab bounces off: the boundary between
                // open water and the human tier.
                borderTop: i === 1 ? "3px solid var(--verified)" : "none",
                // Out-of-reach bands read as disabled rather than being hidden —
                // the point is that the depth exists and you have not earned it.
                // Desaturating keeps the ocean structure intact, where swapping in
                // a flat grey would break the gradient the whole metaphor rests on.
                filter: reachable ? "none" : "saturate(0.12)",
                opacity: reachable ? 1 : 0.62,
                transition: "filter 320ms ease, opacity 320ms ease",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span className="mono" style={{ fontSize: 12, opacity: 0.75 }}>
                    {band.depth}
                  </span>
                  <span style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 19 }}>{band.title}</span>
                  <span className="mono" style={{ fontSize: 12, opacity: 0.75 }}>
                    fee {programs[band.key].feeLabel}
                  </span>
                </div>
                <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>{band.blurb}</div>

                {/* Name the silent fall-through, using the reef's reason. */}
                {band.key === "human" && fellThrough && (
                  <div
                    className="mono"
                    style={{
                      marginTop: 8,
                      fontSize: 11.5,
                      background: "rgba(255,122,77,0.22)",
                      borderRadius: 6,
                      padding: "6px 8px",
                      lineHeight: 1.45,
                    }}
                  >
                    ⚠ proof rejected — priced as open
                    {fallThroughReason && <> · {fallThroughReason.message.toLowerCase()}</>}
                  </div>
                )}

                <div className="mono" style={{ marginTop: 10, fontSize: 15 }}>
                  {!amountIn ? (
                    <span style={{ opacity: 0.6 }}>enter an amount</span>
                  ) : q === undefined ? (
                    <span style={{ opacity: 0.6 }}>quoting…</span>
                  ) : q.error ? (
                    <span style={{ opacity: 0.95 }}>
                      ✕ {q.error.message}
                      {q.error.detail && <span style={{ opacity: 0.6 }}> · {q.error.detail}</span>}
                    </span>
                  ) : (
                    <strong style={{ fontSize: 19, fontWeight: 500 }}>
                      {fmt(q.amountOut, PAIR.buyDecimals)} <span style={{ opacity: 0.7, fontSize: 14 }}>USDC</span>
                    </strong>
                  )}
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                {/* The bot lives at the surface and gets turned away at the rule. */}
                {i === 0 && <Crab bouncing={botBouncing} size={70} />}
                {i === diverBand && <Diver wetsuit={verified ? "on" : "off"} width={92} />}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          onClick={onSwap}
          disabled={!amountIn || busy || !account}
          style={{
            background: verified ? "var(--verified)" : "var(--abyss)",
            color: verified ? "var(--abyss)" : "#fff",
            border: "none",
            borderRadius: 10,
            padding: "14px 26px",
            fontFamily: "var(--display)",
            fontWeight: 700,
            fontSize: 16,
            cursor: !amountIn || busy || !account ? "not-allowed" : "pointer",
            opacity: !amountIn || busy || !account ? 0.45 : 1,
            transition: "background 260ms ease",
          }}
        >
          {busy ? "Diving…" : verified ? "Dive to −10 m" : "Swim at surface"}
        </button>

        <button
          onClick={() => {
            setBotBouncing(true);
            setTimeout(() => setBotBouncing(false), 1500);
          }}
          style={{
            background: "transparent",
            border: "1px solid var(--locked)",
            color: "var(--abyss)",
            borderRadius: 10,
            padding: "13px 18px",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Release a bot
        </button>

        {saved && (
          <span className="mono" style={{ fontSize: 13, color: "var(--midwater)" }}>
            +{fmt(saved, PAIR.buyDecimals)} USDC vs surface
          </span>
        )}
      </div>
    </section>
  );
}

function safeParse(v) {
  try {
    // The sold side is not always 18dp — read it from the deployment.
    const n = parseUnits(String(v || "0"), PAIR.sellDecimals);
    return n > 0n ? n : null;
  } catch {
    return null;
  }
}

function fmt(v, decimals) {
  if (v === undefined || v === null) return "—";
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
