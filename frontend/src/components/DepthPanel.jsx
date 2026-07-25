/**
 * Depth panel — ocean cross-section, one band per program, plus the depth ruler.
 *
 * Every number here is a real `quote()` against the shipped programs. Nothing is
 * simulated: if the chain is down the bands say so rather than showing a
 * plausible figure, because a fake quote is the one thing that would make the
 * whole demo dishonest.
 *
 * The bands are selectable, which is new and load-bearing. Tapping one chooses the
 * program the dive will actually execute, so the tier split stops being a claim:
 * you price the same swap through the open program and the tiered one, side by
 * side, and read the fee difference off the chain.
 */

import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { TOKENS, erc20Abi, publicClient, quote } from "../lib/chain";
import Diver, { Crab } from "./Diver";

/** How often live quotes refresh. The header states this, so it has to be true. */
export const QUOTE_REFRESH_MS = 4000;

const BANDS = [
  {
    key: "surface",
    depth: "0 m",
    title: "Surface",
    blurb: "Open pool. Bots welcome. Worst price.",
    bg: "var(--sunlit)",
    ink: "var(--abyss)",
    dim: "#0b4650",
    height: 190,
    rulerTop: -8,
  },
  {
    key: "human",
    depth: "−10 m",
    title: "Human tier",
    blurb: "Wetsuit required. Reduced fee, same liquidity.",
    bg: "var(--midwater)",
    ink: "#fff",
    dim: "#bfe6f2",
    height: 286,
    rulerTop: 182,
  },
  {
    key: "reef",
    depth: "−30 m",
    title: "The reef",
    blurb: "Human-only pool. No proof, no entry.",
    bg: "var(--reef)",
    ink: "#fff",
    dim: "#d3dbde",
    height: 200,
    rulerTop: 472,
  },
];

/** Where the "YOU" marker sits on the ruler, per selected band. */
const MARKER_TOP = { surface: 103, human: 336, reef: 570 };

export default function DepthPanel({
  amount,
  setAmount,
  takerData,
  account,
  verified,
  onSwap,
  busy,
  programs,
  router,
  tier,
  setTier,
  onQuotes,
  side,
  onFlip,
}) {
  const [quotes, setQuotes] = useState({});
  const [balances, setBalances] = useState({});

  const amountIn = safeParse(amount, side.sell.decimals);

  // Both token balances, polled on the same cadence as the quotes.
  //
  // Polled rather than read once, which is the fix for balances that looked like
  // constants: a one-shot read never noticed a mint, an incoming transfer, or a swap
  // made in another tab. `busy` stays a dependency so a dive refreshes immediately
  // instead of waiting out the interval.
  //
  // Keyed on TOKENS rather than on the current direction, so flipping does not restart
  // the poll — the pair is the same two tokens either way.
  useEffect(() => {
    if (!account) {
      setBalances({});
      return;
    }
    let live = true;
    const read = (t) =>
      publicClient.readContract({ address: t.address, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    const run = async () => {
      try {
        const [base, quoteBal] = await Promise.all([read(TOKENS.base), read(TOKENS.quote)]);
        if (live) {
          setBalances({
            [TOKENS.base.address.toLowerCase()]: base,
            [TOKENS.quote.address.toLowerCase()]: quoteBal,
          });
        }
      } catch {
        if (live) setBalances({});
      }
    };
    run();
    const id = setInterval(run, QUOTE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [account, busy]);

  const balanceOf = (t) => balances[t.address.toLowerCase()];
  const sellBalance = balanceOf(side.sell);
  const buyBalance = balanceOf(side.buy);

  /**
   * Does the amount exceed what you hold?
   *
   * Worth catching in the form. The swap would revert on transfer after the wallet
   * prompt and the gas estimate, which reads as a broken app rather than as an amount
   * you cannot afford.
   */
  const insufficient = amountIn !== null && sellBalance !== undefined && amountIn > sellBalance;

  // Quotes refresh on a timer as well as on input. The pool moves, so a figure
  // that was true a minute ago is not a live quote — and the header claims 4s.
  useEffect(() => {
    if (!amountIn) {
      setQuotes({});
      return;
    }
    let live = true;
    const run = async () => {
      const entries = await Promise.all(
        BANDS.map(async (b) => [
          b.key,
          await quote({ router, program: programs[b.key], amountIn, takerData, account }),
        ]),
      );
      if (!live) return;
      const map = Object.fromEntries(entries);
      setQuotes(map);
      // The dive computer needs the same numbers; reporting them up beats quoting
      // twice, which would double the RPC load and could disagree between panels.
      onQuotes?.(map);
    };
    run();
    const id = setInterval(run, QUOTE_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [amountIn, takerData, account, router, programs, onQuotes]);

  const out = (k) => quotes[k]?.amountOut;
  const activeOut = out(tier);
  const surfaceOut = out("surface");
  const humanOut = out("human");

  // The reef is reachable only if its program actually quotes. It is a human-only
  // program, so on chain a wetsuit is enough — but if the guard refuses we say so
  // rather than showing a number nobody can trade against.
  const reefReachable = out("reef") !== undefined;

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

  const activeBand = BANDS.find((b) => b.key === tier);
  const activeQuote = quotes[tier];

  // Rate implied by the live quote, not by a stored price. Derived rather than
  // fetched so it can never disagree with the number above it.
  const rate =
    activeOut !== undefined && amountIn
      ? (Number(formatUnits(activeOut, side.buy.decimals)) / Number(formatUnits(amountIn, side.sell.decimals))).toLocaleString(
          undefined,
          { minimumFractionDigits: 2, maximumFractionDigits: 2 },
        )
      : null;

  const vsSurfaceNote =
    surfaceOut === undefined || activeOut === undefined
      ? null
      : tier === "surface"
        ? "surface pricing"
        : activeOut === surfaceOut
          ? "same as surface"
          : `${activeOut > surfaceOut ? "+" : "−"}${fmt(
              activeOut > surfaceOut ? activeOut - surfaceOut : surfaceOut - activeOut,
              side.buy.decimals,
            )} ${side.buy.symbol} vs surface`;

  return (
    <section style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
        <div className="eyebrow" style={{ color: "var(--midwater)" }}>
          Depth · live quotes
        </div>
        <div style={{ flex: 1 }} />
        <div className="mono" style={{ fontSize: 12, color: "var(--locked)" }}>
          quotes refresh {QUOTE_REFRESH_MS / 1000}s
        </div>
      </div>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.03em", margin: "12px 0 22px" }}>Depth is a permission.</h1>

      {/* The swap form, in the shape every DEX uses: pay above, receive below, the
          direction badge on the seam. Familiar on purpose — the novel thing here is
          the depth metaphor, and it reads better when the controls do not also need
          learning.

          The receive card is `est.` because it is a quote: the price can move between
          the read and the swap. */}
      <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ background: "var(--paper)", borderRadius: 16, padding: "18px 24px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <label className="eyebrow" style={{ color: "var(--locked)", flex: 1 }} htmlFor="amt">
              You pay
            </label>
            {sellBalance !== undefined && (
              <div className="mono" style={{ fontSize: 12, color: "#8fa4ac" }}>
                balance {trim(sellBalance, side.sell.decimals)} {side.sell.symbol}
              </div>
            )}
            {sellBalance !== undefined && sellBalance > 0n && (
              <button
                onClick={() => setAmount(formatUnits(sellBalance, side.sell.decimals))}
                className="mono"
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: ".08em",
                  color: "var(--midwater)",
                  background: "#e2f2f7",
                  border: 0,
                  borderRadius: 6,
                  padding: "5px 9px",
                  cursor: "pointer",
                }}
              >
                MAX
              </button>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
            <input
              id="amt"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: "none",
                fontSize: 44,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                color: "var(--abyss)",
                background: "transparent",
                padding: "4px 0 0",
                fontFamily: "var(--display)",
              }}
            />
            <TokenPill symbol={side.sell.symbol} dot={side.sell.dot} />
          </div>
          {amount && !amountIn && (
            <div className="mono" style={{ fontSize: 12, color: "var(--coral)", marginTop: 6 }}>
              not a number
            </div>
          )}
          {insufficient && (
            <div className="mono" style={{ fontSize: 12, color: "var(--coral)", marginTop: 6 }}>
              more than your {side.sell.symbol} balance
            </div>
          )}
        </div>

        {/* Direction switch, centred on the seam between the two cards. The contract
            always supported both directions — `isAToB` is one bit of taker traits — so
            this was a diagram pretending to be a control. Now it is the control. */}
        <button
          onClick={onFlip}
          aria-label={`Swap direction — sell ${side.buy.symbol} instead`}
          title={`Sell ${side.buy.symbol} instead`}
          style={{
            cursor: "pointer",
            padding: 0,
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 2,
            width: 40,
            height: 40,
            borderRadius: 12,
            background: "var(--abyss)",
            color: "var(--sunlit)",
            border: "4px solid var(--shell)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
          }}
        >
          ↓
        </button>

        <div style={{ background: "var(--paper)", borderRadius: 16, padding: "18px 24px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div className="eyebrow" style={{ color: "var(--locked)", flex: 1 }}>
              You receive (est.)
            </div>
            {buyBalance !== undefined && (
              <div className="mono" style={{ fontSize: 12, color: "#8fa4ac" }}>
                balance {trim(buyBalance, side.buy.decimals)} {side.buy.symbol}
              </div>
            )}
            <div className="mono" style={{ fontSize: 12, color: "var(--midwater)" }}>
              via {activeBand?.title} · {activeBand?.depth}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, marginTop: 4 }}>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                fontSize: 44,
                fontWeight: 700,
                letterSpacing: "-0.02em",
                paddingTop: 4,
                fontFamily: "var(--display)",
                color: activeQuote?.error ? "var(--coral)" : "var(--abyss)",
              }}
            >
              {!amountIn
                ? "0.00"
                : activeQuote === undefined
                  ? "…"
                  : activeQuote.error
                    ? "—"
                    : fmt(activeQuote.amountOut, side.buy.decimals)}
            </div>
            <TokenPill symbol={side.buy.symbol} dot={side.buy.dot} />
          </div>

          {/* Only facts. The design also showed a slippage figure; this build sends no
              min-out on the swap, so quoting one would be inventing a guarantee the
              contract does not make. */}
          <div
            className="mono"
            style={{
              display: "flex",
              gap: 20,
              marginTop: 14,
              paddingTop: 14,
              borderTop: "1px solid #eaf0f2",
              fontSize: 12,
              color: "var(--locked)",
              flexWrap: "wrap",
            }}
          >
            <span>
              rate 1 {side.sell.symbol} = {rate ?? "—"} {side.buy.symbol}
            </span>
            <span>fee {programs[tier].feeLabel}</span>
            {activeQuote?.error ? (
              <span style={{ color: "var(--coral)" }}>{activeQuote.error.message}</span>
            ) : (
              vsSurfaceNote && <span style={{ color: "var(--verified-deep)" }}>{vsSurfaceNote}</span>
            )}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "20px 2px 12px" }}>
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--verified)" }} />
        <div className="mono" style={{ fontSize: 12, letterSpacing: "0.12em", color: "#4a626c" }}>
          TAP A LAYER TO CHANGE DEPTH · CURRENTLY ROUTING AT {BANDS.find((b) => b.key === tier)?.depth}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "62px 1fr", gap: "0 14px" }}>
        {/* Depth ruler. The marker is the only thing that moves, and it moves
            because the selection changed — it is state, not decoration. */}
        <div style={{ position: "relative", borderRight: "2px solid #c3d3d9", margin: "8px 0" }}>
          <div
            style={{
              position: "absolute",
              right: -7,
              top: MARKER_TOP[tier],
              transition: "top .45s cubic-bezier(.4,0,.2,1)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, transform: "translateY(-50%)" }}>
              <span className="mono" style={{ fontSize: 10, fontWeight: 700, color: "#00a06a", letterSpacing: ".1em" }}>
                YOU
              </span>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: "var(--verified)",
                  border: "2px solid var(--shell)",
                }}
              />
            </div>
          </div>
          {BANDS.map((b) => (
            <div
              key={b.key}
              className="mono"
              style={{ position: "absolute", right: 14, top: b.rulerTop, fontSize: 12, color: "#8fa4ac" }}
            >
              {b.depth}
            </div>
          ))}
        </div>

        <div style={{ borderRadius: 16, overflow: "hidden" }}>
          {BANDS.map((band, i) => {
            const q = quotes[band.key];
            const isActive = tier === band.key;
            // The human tier is locked without a wetsuit, and that is a correction
            // rather than a restriction. `JumpIfHumanTaker` falls through for an
            // unproven taker, so selecting this band with no proof routed through the
            // tiered program at the *open* fee — the header said 0.05% and the chain
            // charged 0.30%. Locking it makes the gate match the pricing.
            const locked = band.key === "human" ? !verified : band.key === "reef" ? !reefReachable : false;
            const selectable = !locked;
            const missingGear = band.key === "human" ? ["Wetsuit"] : ["Mask", "Tank"];
            const delta = q?.amountOut !== undefined && activeOut !== undefined ? q.amountOut - activeOut : null;

            return (
              <div key={band.key}>
                {/* The green rule: the boundary between open water and the tier
                    that requires a proof. */}
                {i === 1 && <div style={{ height: 4, background: "var(--verified)" }} />}
                <div
                  onClick={selectable ? () => setTier(band.key) : undefined}
                  role={selectable ? "button" : undefined}
                  tabIndex={selectable ? 0 : undefined}
                  aria-pressed={selectable ? isActive : undefined}
                  onKeyDown={
                    selectable
                      ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setTier(band.key);
                          }
                        }
                      : undefined
                  }
                  style={{
                    position: "relative",
                    background: band.bg,
                    color: band.ink,
                    padding: band.key === "human" ? "30px 28px" : "26px 28px",
                    height: band.height,
                    boxSizing: "border-box",
                    cursor: selectable ? "pointer" : "default",
                    // Unselected bands desaturate rather than hide: the point is that
                    // the depth exists and you are not currently at it.
                    opacity: isActive ? 1 : 0.5,
                    filter: isActive ? "none" : "saturate(0.45)",
                    transition: "opacity .3s, filter .3s",
                  }}
                >
                  {locked && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        background: "repeating-linear-gradient(135deg, #ffffff0f 0 10px, #00000000 10px 20px)",
                      }}
                    />
                  )}

                  <div style={{ position: "relative" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                      <span className="mono" style={{ fontSize: 14, color: band.dim }}>
                        {band.depth}
                      </span>
                      <span
                        style={{
                          fontFamily: "var(--display)",
                          fontSize: 25,
                          fontWeight: 700,
                          letterSpacing: "-0.02em",
                          color: band.key === "surface" ? "var(--abyss)" : "#fff",
                        }}
                      >
                        {band.title}
                      </span>
                      <span className="mono" style={{ fontSize: 14, color: band.dim }}>
                        fee {programs[band.key].feeLabel}
                      </span>
                      {isActive && (
                        <span
                          className="mono"
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 7,
                            background: band.key === "human" ? "var(--verified)" : "var(--abyss)",
                            color: band.key === "human" ? "var(--verified-ink)" : "var(--verified)",
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: ".12em",
                            padding: "6px 11px",
                            borderRadius: 999,
                          }}
                        >
                          ● ROUTING HERE
                        </span>
                      )}
                      {locked && (
                        <span
                          className="mono"
                          style={{
                            display: "inline-flex",
                            background: "#0000002e",
                            color: "#fff",
                            fontSize: 11,
                            fontWeight: 700,
                            letterSpacing: ".12em",
                            padding: "6px 11px",
                            borderRadius: 999,
                          }}
                        >
                          LOCKED
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 16, color: band.dim, marginTop: 8, maxWidth: "calc(100% - 150px)" }}>
                      {band.blurb}
                    </div>

                    {/* Name the silent fall-through, using the reef's reason. */}
                    {band.key === "human" && fellThrough && (
                      <div
                        className="mono"
                        style={{
                          marginTop: 10,
                          fontSize: 11.5,
                          background: "rgba(244,98,58,0.3)",
                          borderRadius: 6,
                          padding: "6px 8px",
                          lineHeight: 1.45,
                          maxWidth: "calc(100% - 150px)",
                        }}
                      >
                        ⚠ proof rejected — priced as open
                        {fallThroughReason && <> · {fallThroughReason.message.toLowerCase()}</>}
                      </div>
                    )}

                    <div
                      style={{
                        display: "flex",
                        alignItems: "baseline",
                        gap: 12,
                        marginTop: band.key === "human" ? 18 : 16,
                        flexWrap: "wrap",
                        maxWidth: "calc(100% - 150px)",
                      }}
                    >
                      {!amountIn ? (
                        <span className="mono" style={{ fontSize: 15, opacity: 0.75 }}>
                          enter an amount
                        </span>
                      ) : q === undefined ? (
                        <span className="mono" style={{ fontSize: 15, opacity: 0.75 }}>
                          quoting…
                        </span>
                      ) : q.error ? (
                        <span className="mono" style={{ fontSize: 14 }}>
                          ✕ {q.error.message}
                          {q.error.detail && <span style={{ opacity: 0.7 }}> · {q.error.detail}</span>}
                        </span>
                      ) : (
                        <>
                          <span
                            className="mono"
                            style={{
                              fontSize: band.key === "human" ? 38 : 30,
                              fontWeight: 700,
                              color: band.key === "surface" ? "var(--abyss)" : "#fff",
                            }}
                          >
                            {fmt(q.amountOut, side.buy.decimals)}
                          </span>
                          <span className="mono" style={{ fontSize: 15, color: band.dim }}>
                            {side.buy.symbol}
                          </span>
                          {!isActive && delta !== null && delta !== 0n && (
                            <span
                              className="mono"
                              style={{
                                fontSize: 14,
                                color: band.key === "surface" ? "#0b4650" : "#eaf7fb",
                                background: band.key === "surface" ? "#ffffff5c" : "#ffffff2e",
                                padding: "4px 9px",
                                borderRadius: 7,
                              }}
                            >
                              {delta > 0n ? "+" : "−"}
                              {fmt(delta < 0n ? -delta : delta, side.buy.decimals)} vs your tier
                            </span>
                          )}
                        </>
                      )}
                    </div>

                    {/* A locked human band still quotes, but at the open fee — the
                        guard fell through. Saying so beats showing a 0.05% header over
                        a 0.30% number. */}
                    {band.key === "human" && locked && amountIn && q?.amountOut !== undefined && (
                      <div className="mono" style={{ fontSize: 12, color: band.dim, marginTop: 10 }}>
                        priced at the open fee — a wetsuit unlocks {programs.human.feeLabel}
                      </div>
                    )}

                    {/* What the tiered band actually does, stated rather than implied. */}
                    {band.key === "human" && (
                      <div
                        className="mono"
                        style={{
                          display: "flex",
                          gap: 22,
                          marginTop: 22,
                          paddingRight: 150,
                          fontSize: 12,
                          color: band.dim,
                          flexWrap: "wrap",
                        }}
                      >
                        <div>
                          <div style={{ letterSpacing: ".1em" }}>ROUTE</div>
                          <div style={{ color: "#fff", marginTop: 5 }}>Aqua · JumpIfHumanTaker</div>
                        </div>
                        <div>
                          <div style={{ letterSpacing: ".1em" }}>PROOF</div>
                          <div style={{ color: "#fff", marginTop: 5 }}>
                            {verified ? "Wetsuit · spent on dive" : "Required · gear up first"}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* The gear this depth is waiting on. Accurate in both cases: v1
                        attests personhood only, so a wetsuit is earnable and the
                        attestations are not. */}
                    {locked && (
                      <div className="mono" style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                        {missingGear.map((g) => (
                          <span
                            key={g}
                            style={{ fontSize: 12, border: "1px solid #ffffff59", borderRadius: 7, padding: "6px 10px" }}
                          >
                            {g} · missing
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* The bot lives at the surface; the diver sits at the tier whose
                      gear they hold. */}
                  <div style={{ position: "absolute", right: 30, top: 40, pointerEvents: "none" }}>
                    {band.key === "surface" && <Crab size={78} />}
                    {band.key === "human" && verified && <Diver wetsuit="on" width={100} />}
                  </div>

                  {isActive && (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        border: "4px solid var(--verified)",
                        borderRadius: i === 0 ? "16px 16px 0 0" : i === BANDS.length - 1 ? "0 0 16px 16px" : 0,
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 26, flexWrap: "wrap" }}>
        <button
          onClick={onSwap}
          disabled={!amountIn || busy || !account || insufficient}
          style={{
            background: "var(--verified)",
            border: 0,
            borderRadius: 14,
            padding: "22px 34px",
            fontFamily: "var(--display)",
            fontSize: 19,
            fontWeight: 700,
            color: "var(--verified-ink)",
            cursor: !amountIn || busy || !account || insufficient ? "not-allowed" : "pointer",
            opacity: !amountIn || busy || !account || insufficient ? 0.45 : 1,
          }}
        >
          {busy
            ? "Diving…"
            : tier === "human"
              ? "Swap · dive to −10 m"
              : tier === "reef"
                ? "Swap · dive to −30 m"
                : "Swap at the surface"}
        </button>

        {/* Only offered when you are not already there — a button that reselects the
            tier you are on would do nothing. */}
        {tier !== "surface" && (
          <button
            onClick={() => setTier("surface")}
            style={{
              background: "var(--paper)",
              border: "1px solid var(--edge)",
              borderRadius: 14,
              padding: "22px 28px",
              fontFamily: "var(--display)",
              fontSize: 17,
              fontWeight: 700,
              color: "var(--abyss)",
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          >
            Swap on the surface instead
          </button>
        )}

        {surfaceOut !== undefined && humanOut !== undefined && humanOut !== surfaceOut && (
          <div className="mono" style={{ fontSize: 15, color: "var(--midwater)" }}>
            {humanOut > surfaceOut ? "+" : "−"}
            {fmt(humanOut > surfaceOut ? humanOut - surfaceOut : surfaceOut - humanOut, side.buy.decimals)}{" "}
            {side.buy.symbol}
            {tier === "human" ? " vs surface" : " available at −10 m"}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Token chip. Deliberately without the usual chevron: this deployment ships one
 * pair, so a dropdown affordance would promise a picker that does not exist.
 */
function TokenPill({ symbol, dot }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        background: "#eff5f7",
        borderRadius: 999,
        padding: "9px 16px 9px 10px",
        flexShrink: 0,
      }}
    >
      <span style={{ width: 26, height: 26, borderRadius: "50%", background: dot }} />
      <span style={{ fontSize: 17, fontWeight: 700, fontFamily: "var(--display)" }}>{symbol}</span>
    </div>
  );
}

/** Balance display — enough digits to be useful, not enough to wrap the row. */
function trim(v, decimals) {
  const n = Number(formatUnits(v, decimals));
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 3 });
}

function safeParse(v, sellDecimals) {
  try {
    // The sold side is not always 18dp — read it from the deployment.
    const n = parseUnits(String(v || "0"), sellDecimals);
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
