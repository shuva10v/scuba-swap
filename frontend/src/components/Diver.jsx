/**
 * Diver avatar — transcribed from section 04 of the identity doc.
 *
 * Gear is credential state, and each piece has three states:
 *   on     — proven; the solid group renders
 *   locked — attestation exists but is not implemented (v2); dashed grey outline
 *   off    — not applicable; neither group renders
 *
 * v1 only earns the wetsuit (World ID personhood). Mask (age) and tank
 * (jurisdiction) have no attestation logic behind them and are drawn `off`
 * everywhere in the app: the `locked` dashed rendering, which the identity doc
 * specifies, reads as a broken render rather than a roadmap once it is floating
 * on a body. The roadmap is carried in the checklist and card instead, as flat
 * grey disabled rows. `locked` stays implemented for when those land.
 *
 * Geometry is copied verbatim from the design doc so the app and the identity
 * spec cannot drift.
 */

const GEAR_TRANSITION = { transition: "opacity 260ms ease" };

/** Locked outlines share one stroke treatment; keeping it here avoids drift. */
const lockedStroke = {
  fill: "none",
  stroke: "var(--locked)",
  strokeWidth: 4,
  strokeDasharray: "8 7",
};

/**
 * Gear defaults to `off`, not `locked`. `locked` draws a dashed ghost of absent
 * gear, which reads as a broken render — so it must be opted into explicitly
 * rather than being what a caller gets by forgetting a prop. The depth-panel
 * swimmer was rendering ghost mask and tank purely because it omitted them.
 */
export default function Diver({ wetsuit = "off", mask = "off", tank = "off", width = 260 }) {
  const on = (s) => (s === "on" ? 1 : 0);
  const locked = (s) => (s === "locked" ? 1 : 0);

  // Bubbles and fins are part of *being* geared up, not separate gear — they
  // follow the wetsuit rather than having their own state.
  const suited = on(wetsuit);

  return (
    <svg width={width} height={width * 1.5} viewBox="0 0 200 300" role="img" aria-label={ariaLabel({ wetsuit, mask, tank })}>
      <g opacity={on(tank)} style={GEAR_TRANSITION}>
        <rect x="128" y="70" width="30" height="82" rx="15" fill="var(--midwater)" />
        <rect x="136" y="60" width="14" height="14" rx="3" fill="var(--midwater)" />
        <rect x="118" y="86" width="14" height="6" fill="var(--abyss)" />
      </g>
      <g opacity={locked(tank)} style={GEAR_TRANSITION} {...lockedStroke}>
        <rect x="128" y="70" width="30" height="82" rx="15" />
        <rect x="136" y="60" width="14" height="14" rx="3" />
      </g>

      {/* Always present: the swimmer in trunks. */}
      <g>
        <g fill="var(--skin)">
          <circle cx="100" cy="48" r="27" />
          <rect x="90" y="68" width="20" height="16" />
          <rect x="66" y="80" width="68" height="82" rx="12" />
          <rect x="42" y="84" width="22" height="80" rx="11" />
          <rect x="136" y="84" width="22" height="80" rx="11" />
          <rect x="72" y="176" width="24" height="70" rx="12" />
          <rect x="104" y="176" width="24" height="70" rx="12" />
        </g>
        <rect x="66" y="150" width="68" height="34" rx="6" fill="var(--coral)" />
        <g fill="var(--abyss)">
          <circle cx="90" cy="46" r="4" />
          <circle cx="110" cy="46" r="4" />
        </g>
      </g>

      <g opacity={suited} style={GEAR_TRANSITION}>
        <g fill="var(--abyss)">
          <rect x="64" y="78" width="72" height="106" rx="14" />
          <rect x="40" y="82" width="26" height="86" rx="13" />
          <rect x="134" y="82" width="26" height="86" rx="13" />
          <rect x="70" y="174" width="28" height="74" rx="14" />
          <rect x="102" y="174" width="28" height="74" rx="14" />
          <rect x="86" y="66" width="28" height="18" rx="6" />
        </g>
        <rect x="64" y="112" width="72" height="10" fill="var(--coral)" />
        {/* The green chest square is the "proof accepted" tell. */}
        <rect x="94" y="126" width="12" height="12" fill="var(--verified)" />
      </g>
      <g opacity={locked(wetsuit)} style={GEAR_TRANSITION} {...lockedStroke}>
        <rect x="64" y="78" width="72" height="106" rx="14" />
        <rect x="40" y="82" width="26" height="86" rx="13" />
        <rect x="134" y="82" width="26" height="86" rx="13" />
        <rect x="70" y="174" width="28" height="74" rx="14" />
        <rect x="102" y="174" width="28" height="74" rx="14" />
      </g>

      <g opacity={on(mask)} style={GEAR_TRANSITION}>
        <rect x="66" y="40" width="68" height="9" fill="var(--abyss)" />
        <rect x="72" y="30" width="56" height="32" rx="9" fill="var(--sunlit)" stroke="var(--abyss)" strokeWidth="5" />
      </g>
      <g opacity={locked(mask)} style={GEAR_TRANSITION} {...lockedStroke}>
        <rect x="66" y="40" width="68" height="9" />
        <rect x="72" y="30" width="56" height="32" rx="9" />
      </g>

      <g opacity={suited} fill="var(--sunlit)" style={GEAR_TRANSITION}>
        <circle cx="132" cy="46" r="5" style={{ animation: "bubble-rise 2.6s linear infinite" }} />
        <circle cx="138" cy="52" r="3.5" style={{ animation: "bubble-rise 2.6s linear 0.9s infinite" }} />
        <circle cx="128" cy="56" r="2.5" style={{ animation: "bubble-rise 2.6s linear 1.7s infinite" }} />
      </g>

      <g opacity={suited} fill="var(--verified)" style={GEAR_TRANSITION}>
        <rect x="52" y="244" width="48" height="16" rx="8" />
        <rect x="100" y="244" width="48" height="16" rx="8" />
      </g>
    </svg>
  );
}

/** Screen readers get the gear state, since it carries the whole meaning. */
function ariaLabel({ wetsuit, mask, tank }) {
  if (wetsuit !== "on") return "Unverified swimmer, no gear — surface only";
  const extra = [mask === "on" && "mask", tank === "on" && "tank"].filter(Boolean);
  return extra.length
    ? `Diver wearing wetsuit and ${extra.join(" and ")}`
    : "Diver wearing a wetsuit — verified human, cleared to −10 m";
}

/** The bubbles mark, doubling as favicon and header lockup. */
export function BubblesMark({ size = 32 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label="ScubaSwap">
      <rect width="64" height="64" rx="14" fill="var(--abyss)" />
      <circle cx="24" cy="42" r="10" fill="var(--sunlit)" />
      <circle cx="41" cy="27" r="6.5" fill="var(--verified)" />
      <circle cx="49" cy="15" r="4" fill="var(--coral)" />
    </svg>
  );
}

/**
 * The bot crab. Grey shell, coral claws, no wetsuit — ever.
 *
 * `bouncing` drives a single translateX keyframe against the boundary rule,
 * matching the doc's note that this is deliberately not a physics simulation.
 */
export function Crab({ bouncing = false, size = 86 }) {
  return (
    <svg
      width={size}
      height={size * 0.7}
      viewBox="0 0 120 84"
      role="img"
      aria-label={bouncing ? "Bot turned away at the boundary" : "Bot approaching"}
      style={bouncing ? { animation: "crab-bounce 1.4s ease-in-out" } : undefined}
    >
      <rect x="26" y="24" width="68" height="38" rx="8" fill="var(--locked)" />
      <rect x="38" y="34" width="16" height="10" fill="var(--abyss)" />
      <rect x="66" y="34" width="16" height="10" fill="var(--abyss)" />
      <rect x="34" y="52" width="52" height="6" fill="var(--abyss)" />
      <rect x="6" y="12" width="18" height="18" rx="4" fill="var(--coral)" />
      <rect x="96" y="12" width="18" height="18" rx="4" fill="var(--coral)" />
      <rect x="22" y="28" width="8" height="6" fill="var(--locked)" />
      <rect x="90" y="28" width="8" height="6" fill="var(--locked)" />
      <rect x="32" y="62" width="8" height="14" fill="var(--abyss)" />
      <rect x="56" y="62" width="8" height="14" fill="var(--abyss)" />
      <rect x="80" y="62" width="8" height="14" fill="var(--abyss)" />
      <rect x="44" y="10" width="6" height="14" fill="var(--locked)" />
      <circle cx="47" cy="8" r="5" fill="var(--coral)" />
    </svg>
  );
}
