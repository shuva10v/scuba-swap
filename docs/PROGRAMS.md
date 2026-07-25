# ScubaSwap programs

Three strategies, one shipped Aqua balance. A maker keeps a single WETH/USDC
position in their own wallet and publishes all three against it; Aqua tracks
virtual balances, so nothing is duplicated or locked.

| | Who can take | Fee | Opcodes |
| --- | --- | --- | --- |
| **A — open** | anyone | 0.30% | stock only |
| **B — tiered** | anyone; humans priced better | 0.30% / **0.05%** | `0x33` |
| **C — human-only** | verified humans only | 0.05% | `0x27` |

`test_allThreeProgramsShareOneMakerBalance` asserts the shared-balance claim:
three distinct strategy hashes each report the full balance, while the maker's
wallet is untouched and Aqua custodies nothing.

---

## Opcodes

Both take the next free slot in SwapVM's `0x20–0x3f` "conditions & access
guards" bank. Stock opcode numbers are untouched — `ScubaOpcodes` handles only
these two and delegates everything else to `super._runOpcode`.

| Opcode | Name | On failure |
| --- | --- | --- |
| `0x27` | `OnlyHumanTaker` | **reverts** |
| `0x33` | `JumpIfHumanTaker` | **falls through** to the next instruction |

The asymmetry is deliberate. `0x27` is a gate, so a missing or invalid proof must
stop the swap. `0x33` is a discount, so anything short of a valid proof — absent,
stale, already spent, cryptographically invalid — simply means "pay the open
price". A tiered pool that reverted on a malformed proof would be strictly worse
than one without the feature.

### Arguments

The **maker** fixes credential policy in the program; the **taker** supplies the
proof through `takerArgs`. A taker therefore cannot downgrade the credential the
maker demanded.

```
0x27 program args   issuerSchemaId(8) ‖ credentialGenesisIssuedAtMin(32)              =  40 B
0x33 program args   jumpPC(2) ‖ issuerSchemaId(8) ‖ credentialGenesisIssuedAtMin(32)  =  42 B
taker args          nullifier(32) ‖ nonce(32) ‖ expiresAtMin(8) ‖ proof[5](160)       = 232 B
                 ‖  actionLen(1) ‖ action(actionLen)                            = 233 + len B
```

`signalHash` is deliberately absent from the payload — the guard derives it from
`ctx.query.taker`, so a proof is worthless to anyone who does not control the
address it was issued for.

Proofs cannot live in program args at all: `runLoop` reads a single length byte
per instruction, capping them at 255 bytes.

---

## Program A — open

```
70 04 <0.30%>     FlatFeeAmountIn
50 00             XYCSwap
02 20 <salt>      Salt
```

Pure stock opcodes. Serves as the control: it runs identically on 1inch's
`AquaSwapVMRouter` and on ours, which is what `RouterConformance` proves.

## Program C — human-only

```
27 28 <policy>    OnlyHumanTaker      <- guard first
70 04 <0.05%>     FlatFeeAmountIn
50 00             XYCSwap
02 20 <salt>      Salt
```

Guard-first is mandatory, for two reasons. A rejected taker must never reach fee
or curve math. And `FlatFeeAmountIn` **recursively re-enters `runLoop`**, so an
instruction placed after it executes *nested inside* the fee, at a different
point in the amount lifecycle.

`test_guardDoesNotAffectPricing` asserts C quotes identically to an unguarded
0.05% program — the guard decides *who*, never *at what price*.

## Program B — tiered

```
 0  33 2a <pc=54,policy>   JumpIfHumanTaker      -> next 44
44  70 04 <0.30%>          FlatFeeAmountIn       -> next 50   [opens nested runLoop]
50  03 02 <60>             Jump                  -> next 54
54  70 04 <0.05%>          FlatFeeAmountIn       -> next 60   [human branch target]
60  50 00                  XYCSwap               -> next 62   [shared tail]
62  02 20 <salt>           Salt
```

- **Unverified:** guard falls through to 44, pays 0.30%, and the nested loop
  jumps straight past the human fee to the curve at 60.
- **Verified:** guard jumps to 54, pays 0.05%, and the nested loop runs the curve.

Exactly one fee is charged either way.

The jump targets are **absolute byte offsets**, so changing any earlier
instruction's argument length silently retargets them — a mispriced swap rather
than an error. `test_programBLayoutIsIntact` pins the offsets so that breaks
loudly and first.

---

## Verification

Every swap through `0x27` or `0x33` carries its own World ID 4.0 proof. There is
no verification window and no cached "this address is human" flag: a cached grant
would hand a bot weeks of trading off one proof handed over once.

```solidity
require(expiresAtMin >= block.timestamp, WorldIdProofExpired(...));
require(!spentProofs[proofId(nullifier, nonce)], WorldIdProofAlreadySpent(...));
WORLD_ID_VERIFIER.verify(..., abi.encodePacked(ctx.query.taker).hashToField(), ...);
if (!ctx.vm.isStaticContext) spentProofs[id] = true;
```

Three details are load-bearing, each forced by something measured against the
live verifier rather than read in a doc:

1. **The freshness check is ours.** `expiresAtMin` is committed into the proof
   but never compared to `block.timestamp`. Measured, an unchecked proof stays
   valid for about an hour — bounded by Merkle-root history, not by the
   credential. FRICTION W-06.
2. **`spentProofs` keys on `(nullifier, nonce)`.** A bare nullifier is constant
   per identity+action, so spending it would allow one swap per human, ever.
   FRICTION W-08.
3. **`action` is `hashToField`, not `keccak256`.** The documented mapping exceeds
   the BN254 modulus and is rejected. FRICTION W-05, fixed upstream in
   [developer-docs#147](https://github.com/worldcoin/developer-docs/pull/147).

Quote and swap stay consistent in both directions: an unspent proof passes both,
a spent one is rejected by both, and neither touches `ctx.swap`.

---

## Cost

Measured on a World Chain fork, both swaps from an identical starting state
(back-to-back measurement is meaningless — the first swap warms ~36k of storage):

| | gas |
| --- | --- |
| Program A — open | ~143k |
| Program C — guarded | ~169k |
| ScubaSwap's own overhead | **~26k** |

That 26k is argument parsing, the freshness check and the spend-set write — it
does **not** include Groth16 verification, which the mock skips. A bare `verify`
call on the live verifier costs ~397k, so a real guarded swap lands near 540k.

Which is the honest argument for the tiered design: verification is expensive
enough that you would not want it on every swap in a pool, so program A stays
cheap for everyone and only takers who want the discount pay for the proof.
