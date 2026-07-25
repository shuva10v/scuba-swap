/**
 * SwapVM program decoder — turns the shipped bytecode into the instruction rows
 * the dive computer panel displays.
 *
 * Program encoding is `opcode(1) ‖ argsLength(1) ‖ args`, repeated. That single
 * length byte is also why proofs cannot live in a program: 255 bytes is the
 * ceiling and a v4 proof is 160 on its own.
 *
 * Decoding here rather than showing a hex blob is the point of the panel: a
 * judge can see that the guard really is the first instruction, and that the
 * fee that executed is the one the tier claims.
 */

/** Stock opcodes we actually emit, plus the two ScubaSwap claims. */
const OPCODES = {
  0x02: { name: "Salt", note: "makes the order hash unique" },
  0x03: { name: "Jump", note: "branch to a program counter" },
  0x27: { name: "OnlyHumanTaker", note: "World ID gate — reverts if unproven", scuba: true },
  0x33: { name: "JumpIfHumanTaker", note: "branch to the human fee if proven", scuba: true },
  0x50: { name: "XYCSwap", note: "constant-product curve" },
  0x70: { name: "FlatFeeAmountIn", note: "fee on the input leg" },
};

const FEE_DENOMINATOR = 1_000_000_000n; // Fee.BPS is 1e9, not 10_000 (FRICTION F-11)

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const toHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * The program is embedded in the order's `data`, after the maker traits header.
 * Rather than reimplement MakerTraits parsing in JS — which would be a second
 * source of truth for a layout the contracts already own — we locate the program
 * by scanning for a valid instruction stream that runs exactly to the end.
 *
 * A wrong offset produces a stream that overruns or hits an unknown opcode, so
 * "decodes cleanly to the last byte" is a strong signal.
 */
export function decodeProgramFromOrderData(dataHex) {
  const bytes = hexToBytes(dataHex);

  for (let start = 0; start < bytes.length - 1; start++) {
    const rows = tryDecode(bytes, start);
    if (rows) return rows;
  }
  return [];
}

function tryDecode(bytes, start) {
  const rows = [];
  let pc = start;

  while (pc < bytes.length) {
    const opcode = bytes[pc];
    const argsLen = bytes[pc + 1];
    if (argsLen === undefined) return null;

    const spec = OPCODES[opcode];
    if (!spec) return null; // unknown opcode: wrong offset

    const argsEnd = pc + 2 + argsLen;
    if (argsEnd > bytes.length) return null; // overruns: wrong offset

    const args = bytes.slice(pc + 2, argsEnd);
    rows.push({
      pc: pc - start,
      opcode,
      name: spec.name,
      note: spec.note,
      scuba: Boolean(spec.scuba),
      args: toHex(args),
      detail: describe(opcode, args),
    });

    pc = argsEnd;
  }

  // Require at least a curve and a couple of instructions, so a coincidental
  // single-byte match cannot pass.
  return rows.length >= 2 && rows.some((r) => r.opcode === 0x50) ? rows : null;
}

function describe(opcode, args) {
  if (opcode === 0x70 && args.length === 4) {
    const ppb = BigInt(`0x${Array.from(args, (b) => b.toString(16).padStart(2, "0")).join("")}`);
    // Rendered as a percentage because "3000000" means nothing to a viewer, and
    // calling it "bps" would repeat the upstream mistake.
    const pct = Number((ppb * 1_000_000n) / FEE_DENOMINATOR) / 10_000;
    return `${pct.toFixed(2)}%`;
  }
  if (opcode === 0x03 && args.length === 2) return `→ pc ${(args[0] << 8) | args[1]}`;
  if (opcode === 0x33 && args.length >= 2) return `→ pc ${(args[0] << 8) | args[1]} if human`;
  if (opcode === 0x27) return "schema 1 · proof of human";
  return null;
}
