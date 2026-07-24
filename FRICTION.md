# FRICTION.md

Every integration pain point hit while building ScubaSwap on top of 1inch Aqua /
SwapVM and World ID. Newest at the bottom.

---

## SwapVM

### F-01 — No documented extension point for third-party instructions
`docs/` explains how to *compose programs* from stock opcodes, but not how to add
one. There is no `_instructions()` array, no registry, no hook. Extension means
inheriting `AquaOpcodes` and overriding the `_runOpcode` if/else chain with a
`super` fallthrough. Discoverable only by reading `src/opcodes/AquaOpcodes.sol`.

### F-02 — Opcode space is a fully-populated enum with no reservation mechanism
`src/libs/OpcodeList.sol` enumerates all 256 slots, banked by family, with a
comment that new instructions "MUST take the next free `_Ix` slot of its family
bank". For a third party that is a **collision hazard**: if 1inch later allocates
`0x27` upstream, our program bytes silently mean something else. The reserved
bank `0xf0–0xff` is documented as "never allocate (potential 2-byte opcode
escape-prefix)" — an actual 2-byte escape prefix for third-party instructions
would solve this.

### F-03 — `quote()` is not `view`, but is required to behave as if it were
`SwapVM.quote()` is declared `external` (non-view) with only a comment,
`/// @dev Method can be executed in a static-call`. Callers use
`asView().quote(...)`, which *is* a staticcall. An instruction author has to
infer that any `SSTORE` breaks quoting, and the only in-band signal is
`ctx.vm.isStaticContext`. Easy to get wrong; nothing enforces it.

### F-04 — `tryChopTakerArgs` fails open
```solidity
length = Math.min(length, data.length);
```
Asking for 321 bytes when the taker supplied 0 returns an empty slice, not a
revert. A guard instruction that forgets to check `.length` would decode zeros
and — with a naive implementation — treat "no proof" as a valid payload. The
`try` prefix is the only warning.

### F-05 — Program instruction args are capped at 255 bytes
`ContextLib.runLoop` reads a single length byte per instruction. A Groth16 proof
is 256 bytes on its own, so proofs can never be baked into a program — they must
come through `takerArgs`. Fine for our design, but it silently rules out
"maker pins a specific proof" strategies.

### F-06 — `ctx.query.taker` is `msg.sender`, which breaks aggregator routing
The natural World ID signal is the taker address. But `taker` is whoever called
`swap()`, so a user going through an aggregator or a smart account binds the
proof to the *aggregator*. There is no "originator" field in `SwapQuery`
(`tx.origin` is used elsewhere in `Controls._onlyTxOriginTokenBalanceNonZero`,
which is its own can of worms). This is a real design constraint on any
identity-bound instruction, not just ours.

### F-07 — Deployment story assumes you are 1inch
`ignition/parameters/chain-1.json` ships with `aqua: 0x0000…` and
`owner: 0x0000…` placeholders, and no canonical `AquaSwapVMRouter` address is
published anywhere in the repo. Finding the live Aqua address
(`0x499943e74fb0ce105688beee8ef2abec5d936d31`) required a web search plus an
on-chain `rawBalances` probe to confirm.

### F-08 — Neither package is on npm, despite npm badges
`README.md` for both `swap-vm` and `aqua` carries an `npm` shield, but
`npm view @1inch/swap-vm` 404s. Deps must be pulled as git refs. `swap-vm`'s own
`package.json` already does this for `aqua` (`github:1inch/aqua#v1.0.0`).

### F-10 — The released tag and `main` have *incompatible* extension mechanisms
This one cost real time. `swap-vm@v1.0.1` (the newest git tag) dispatches through
a fixed-size array of function pointers returned by `_opcodes()`, which a router
surfaces via `_instructions()`. `main` has since replaced that wholesale with a
banked `enum Opcode` (`src/libs/OpcodeList.sol`, absent from the tag) and an
if/else `_runOpcode` chain.

For a third-party instruction the difference is not cosmetic:

- On `main`, extending is three lines — override `_runOpcode`, handle your
  opcode, `super._runOpcode(...)` for everything else.
- On `v1.0.1`, `_opcodes()` returns a `function(...)[35]` **static memory array
  literal** converted to a dynamic one via assembly. There is no append. To add
  one instruction you must restate all 35 entries in your override, and any
  upstream reordering silently changes the meaning of every deployed program.

Nothing in either README says which mechanism is current, and the tag carries no
deprecation note. Worse, `v1.0.1`'s own `package.json` says `"version": "0.0.6"`
— the git tag and the package version disagree, so neither is a reliable handle.
We pin `main` at commit `0817db4a` and accept the unreleased-code risk, because
the tag's mechanism makes "keep stock opcode bytes stable" impossible to
guarantee.

### F-09 — Hardhat/Foundry hybrid
`swap-vm` has a `foundry.toml` *and* a `hardhat.config.ts`, with remappings
pointing into `node_modules/`. Tests are forge-std `.t.sol` files run through
`npx hardhat test solidity`. Consuming the test helpers (`AquaSwapVMTest`,
`ProgramBuilder`, `CoreInvariants`) from a plain Foundry project requires
recreating that remapping layout by hand.

---

## World ID

### W-01 — A v3 proof carries no liveness or freshness signal
The obvious product requirement — "prove a *live* human is taking this swap" —
is not expressible in World ID v3. An Orb credential is issued once, at the Orb,
and every later proof is a local ZK computation over that stored credential. The
on-chain payload is `(root, groupId, signalHash, nullifierHash, externalNullifier,
proof[8])`: no timestamp, no expiry, no issuance date, no challenge nonce.

Consequences for anyone building a gate on top:

- "Fresh proof per action" is a **UX** gate (a World App round-trip), not a
  cryptographic one. Anyone holding the credential material can mint unlimited
  fresh proofs offline.
- `verifyProof` is `view` and consumes nothing, so replay protection is entirely
  the integrator's problem — you must keep your own spent-nullifier set. Nothing
  in the interface hints at this.
- The nullifier is per-`externalNullifier` (i.e. per app+action), so a
  "one proof per swap" policy and a "one identity per account" policy cannot be
  expressed simultaneously without picking your action granularity carefully.

v4 fixes most of this — `verify(...)` takes `expiresAtMin`, `nonce`, `rpId` and
`credentialGenesisIssuedAtMin` — but v4 was not fully rolled out at build time,
which is why this project is on the v3 legacy router.

### W-02 — Two live protocol versions, two incompatible verifier shapes
`IWorldIDRouter.verifyProof` (v3, Semaphore groups, `uint256[8]` proof) and
`IWorldIDVerifier.verify` (v4, `uint256[5]` proof, no groupId, credential
metadata) share no surface. An integrator has to pick one and hardcode it, or
carry both paths like our PoC's `HumanRegistry` does. `groupId` disappearing in
v4 also means the "which credential tier is acceptable" decision moves from a
call argument to the issuer schema — not a mechanical migration.
