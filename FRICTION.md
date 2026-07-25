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

### F-09 — Hardhat/Foundry hybrid
`swap-vm` has a `foundry.toml` *and* a `hardhat.config.ts`, with remappings
pointing into `node_modules/`. Tests are forge-std `.t.sol` files run through
`npx hardhat test solidity`. Consuming the test helpers (`AquaSwapVMTest`,
`ProgramBuilder`, `CoreInvariants`) from a plain Foundry project requires
recreating that remapping layout by hand.

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

### F-11 — `feeBps` is not in bps. `BPS = 1e9`.
Cost us a failing test and a confused debugging detour. Every fee instruction
takes a parameter named `feeBps`, documented as `4 bytes (fee in bps, 1e9 = 100%)`
— but the denominator constant is:

```solidity
uint256 constant BPS = 1e9;
```

So the unit is parts-per-**billion**, and `feeBps = 30` — which any DeFi developer
reads as 0.30% — is actually 0.000003%. The failure mode is the dangerous kind:
**nothing reverts.** `buildFlatFee` only rejects values *above* 1e9, so a maker
who ships a strategy meaning "0.30% fee" gets a working strategy that charges
essentially nothing, and only discovers it by reconciling revenue. 0.30% is
`3_000_000`.

Renaming the parameter to `feePpb`, or making the doc-comment lead with the
denominator instead of the word "bps", would remove the trap entirely.

### F-12 — Fee instructions recursively re-enter `runLoop`
`_flatFeeAmountInXD` does not compute a fee and return. It **calls
`ctx.runLoop()` itself**, so the rest of the program executes *nested inside* the
fee instruction:

```solidity
ctx.swap.amountIn -= fee;
ctx.runLoop();          // <-- the entire remainder of the program runs here
ctx.swap.amountIn += fee;
```

Nothing in the opcode list, the program-composition docs, or the instruction name
suggests that some instructions are wrappers rather than statements. It matters
for any guard instruction: a guard placed *after* a fee opcode runs inside the
nested loop, at a different point in the amount lifecycle than a guard placed
before it. It also explains the otherwise-cryptic
`FeeShouldBeAppliedBeforeSwapAmountsComputation` require. Our rule — identity
guard first, always — is partly a consequence of this.

### F-13 — `asView()` silently swallows `vm.expectRevert`
`SwapVM.asView()` is an *external* function returning `ISwapVM(address(this))`,
and the idiomatic call is `router.asView().quote(...)`. Under Foundry that is two
external calls, so:

```solidity
vm.expectRevert(UnknownOpcode.selector);
router.asView().quote(order, amount, takerData);   // binds to asView(), not quote()
```

`expectRevert` attaches to `asView()`, which never reverts — the test fails with
"next call did not revert as expected", or worse, *passes* vacuously if the
cheatcode is looser. Both of our negative tests hit this. The fix is to hoist:

```solidity
ISwapVM v = router.asView();
vm.expectRevert(UnknownOpcode.selector);
v.quote(order, amount, takerData);
```

The same trap caught `vm.prank` later, in the guard suite: `vm.prank(human);
router.asView().quote(...)` pranks `asView()`, so `quote()` runs as the test
contract and the guard derives a `signalHash` for the wrong address. It surfaced
as `ProofInvalid()` — a failure that looks like broken cryptography rather than a
misplaced cheatcode. Any cheatcode that binds to "the next call" is affected.

A `view`-declared `quote` would have removed the need for `asView()` entirely
(see F-03); the accessor exists only to paper over `quote` not being `view`, and
this is now the third bug traceable to it.

### F-14 — The invariant suite's defaults assume both tokens share decimals
`CoreInvariants` is otherwise a pleasure to reuse — abstract, one `_executeSwap`
hook, configurable. But its defaults are written for an 18/18 pair, and a
WETH(18)/USDC(6) pool trips two of them:

- `symmetryTolerance: 2` (wei). An exact-out quote quantises to whole USDC
  units, so the round trip exactIn -> exactOut -> exactIn cannot recover the
  input more precisely than one output quantum expressed in input terms — about
  2.5e8 wei at 4000 USDC/WETH, eight orders of magnitude above the default.
- `testAmountsExactOut: []` falls back to reusing `testAmounts`. Those are
  denominated in the **input** token, so a pool holding 1e12 USDC gets asked to
  quote 1e18 units out. That surfaces as a bare
  `panic: arithmetic underflow or overflow (0x11)` from inside the VM, with no
  indication that the amount was the problem.

Neither is a bug in the suite, and both are configurable. But nothing in the
config struct's comments hints that the defaults are decimals-specific, and the
second failure mode in particular sends you looking for an overflow in your own
instruction. Worth a note in `TESTING.md` next to the tolerance defaults.

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

v4 fixes most of this on paper — `verify(...)` takes `expiresAtMin`, `nonce`,
`rpId` and `credentialGenesisIssuedAtMin` — and it is why ScubaSwap ultimately
moved to v4. But "on paper" is load-bearing: the freshness parameter is not
actually enforced by the verifier ([W-06](#w-06--the-v4-verifier-does-not-enforce-expiry-you-must)),
and v4 is only deployed on World Chain
([W-07](#w-07--world-id-40-is-world-chain-only-which-may-not-be-where-your-protocol-is)).

### W-02 — Two live protocol versions, two incompatible verifier shapes
`IWorldIDRouter.verifyProof` (v3, Semaphore groups, `uint256[8]` proof) and
`IWorldIDVerifier.verify` (v4, `uint256[5]` proof, no groupId, credential
metadata) share no surface. An integrator has to pick one and hardcode it, or
carry both paths like our PoC's `HumanRegistry` does. `groupId` disappearing in
v4 also means the "which credential tier is acceptable" decision moves from a
call argument to the issuer schema — not a mechanical migration.
### W-03 — Simulator proofs are staging-only and cannot verify on mainnet
The obvious way to get a test fixture is the [World ID simulator](https://simulator.worldcoin.org),
which returns a perfectly well-formed protocol-3.0 response. It is unusable
against the production router, and nothing in the response says so beyond a
quiet `"environment": "staging"`.

Verified rather than assumed — calling the production router at
`0x163b09b4…` with a simulator proof:

```
verifyProof(stagingRoot, 1, signalHash, nullifier, extNullifier, proof)
  -> revert 0xddae3b71 = NonExistentRoot()
```

Staging identities live in a completely separate merkle tree. Per
`world-id-state-bridge/docs/deployments.md` the staging deployment is on
**Ethereum Goerli** — a network that no longer exists — so that document is
itself stale, and there is no `id.staging.worldcoin.eth` ENS record to fall
back on. Working out which chain today's staging tree lives on is left as an
exercise.

Consequences for an integrator targeting mainnet:

- You cannot develop the on-chain leg against the simulator at all. Either you
  hold an Orb-verified World App identity, or your only option is a mock.
- The proof payload itself is shape-correct (`uint256[8]`, 256 bytes,
  `signal_hash` with a zeroed top byte confirming `hashToField`), so every
  encoding check passes and the failure surfaces only as `NonExistentRoot` —
  which reads like a stale-root problem, not a wrong-environment problem.
- The root-freshness gate is the *only* thing that distinguishes the two
  environments on-chain. The Groth16 circuit takes the root as a public input
  and is tree-agnostic, so a staging proof is mathematically valid — it is
  rejected by the registry check, not by the cryptography.

### W-04 — `user_presence_completed` exists, but never reaches the chain
The protocol-3.0 response carries exactly the field an integrator wanting
liveness would hope for:

```json
"user_presence_completed": false
```

It is off-chain JSON. The on-chain payload is `(root, groupId, signalHash,
nullifierHash, externalNullifier, proof[8])` and contains no presence bit, no
timestamp, and no commitment to the surrounding response object. A contract
verifying the proof cannot tell whether presence was completed, and a caller
can simply not forward the flag.

So the presence signal is only trustworthy if you verify **off-chain** through
the Developer Portal API and trust that backend. For a purely on-chain gate —
which is the entire point of `verifyProof` — it does not exist. This is the
concrete form of [W-01](#w-01--a-v3-proof-carries-no-liveness-or-freshness-signal):
the data is produced, and then dropped at the chain boundary.

**v4 does not fix this.** `WorldIDVerifier.verify(...)` has no presence
parameter either, and both of our v4 fixtures carried
`"user_presence_completed": false` yet verified without complaint. The flag
still exists only in the JSON. Whatever freshness a v4 integration gets comes
from `expiresAtMin`, and only if the contract enforces it
([W-06](#w-06--the-v4-verifier-does-not-enforce-expiry-you-must)).

### W-05 — The v4 docs give an `action` value the verifier always rejects
[docs.world.org/world-id/idkit/onchain-verification](https://docs.world.org/world-id/idkit/onchain-verification#2-verifying-uniqueness-proofs-in-worldidverifier-sol-world-id-4-0),
section 2, "Minimal mapping from IDKit result":

> `action` = `keccak256(action)` as `uint256`

Follow that literally and `WorldIDVerifier.verify(...)` reverts
`InvalidAction()` (`0x4a7f394f`), on both the production and staging proxies.

`action` is a circuit public input and must be a BN254 field element
(modulus ≈ 2.188e76). A raw `keccak256` is a full 256-bit value and routinely
exceeds it. For our action string:

```
keccak256("world-demo-v2") ≈ 2.601e76   → above the modulus → InvalidAction()
                      >> 8             → verifies
```

The correct value is the standard `hashToField` reduction,
`uint256(keccak256(action)) >> 8` — which World ID uses everywhere else,
*including the v3 example higher up the same page*
(`abi.encodePacked(signal).hashToField()`). The page contradicts itself: v3
reduces to the field, the v4 mapping list does not.

What made this expensive is the failure shape. Every other parameter maps
exactly as documented, so you get a well-formed call that reverts naming the one
field you copied verbatim, with no hint it needs reducing. Roughly an hour, most
of it spent suspecting `rpId` — the only parameter we did not yet have.

Fix submitted upstream: [worldcoin/developer-docs#147](https://github.com/worldcoin/developer-docs/pull/147).

### W-06 — The v4 verifier does not enforce expiry. You must.
`verify(...)` takes `expiresAtMin`, which reads like the freshness primitive v3
never had. It is **not checked against `block.timestamp`**.

Measured on both proxies: proofs verified fine while their own `expiresAtMin`
was already in the past — by 314s (production) and 189s (staging). The value is
genuinely committed into the proof, so perturbing it by 1 reverts
`ProofInvalid()`; it is simply never compared to the current time.

Validity is not unbounded, though — and the earlier draft of this entry claimed
it was. There *is* a time limit, applied to the wrong thing: the proof's Merkle
root ages out of the verifier's root history. Measured by warping a fork, the
fixture verifies at `expiresAtMin + 60min` and fails at `+70min` with
`InvalidMerkleRoot()`.

So an integrator who maps the parameters exactly as documented — as we initially
did — builds a gate with roughly an **hour** of replay exposure, not infinity,
but still one to two orders of magnitude beyond the proof's own stated lifetime.
The one thing v4 offers over v3 for anti-bot use stays inert unless the
integrating contract adds:

```solidity
require(expiresAtMin >= block.timestamp, ProofExpired());
```

That single line is the difference between "proof of a human, minutes ago" and
"proof that this human once existed". It belongs in the docs' example contract,
which currently stores nullifiers but never looks at `expiresAtMin`.

### W-07 — World ID 4.0 is World Chain only, which may not be where your protocol is
v4's `WorldIDVerifier` is deployed *only* on World Chain (production
`0x00000000009E00F9FE82CfeeBB4556686da094d7`, staging
`0x703a6316c975DEabF30b637c155edD53e24657DB`). v3's `WorldIDRouter` is on
Ethereum, World Chain, Base, Optimism and Polygon.

For ScubaSwap that is a direct conflict: Aqua is deployed at the same address on
Ethereum, Optimism, Base, Arbitrum and Polygon — and **not** on World Chain
(verified: `eth_getCode` returns `0x` on chain 480). So there is no chain where
canonical Aqua and a v4 verifier coexist. You get one of:

- v3 + canonical Aqua on Ethereum — but v3 cannot express liveness at all (W-01),
- v4 + self-deployed Aqua on World Chain — real freshness, non-canonical liquidity.

The choice is forced by deployment topology rather than by anything about the
protocols. A v4 verifier on the chains that already carry the v3 router would
remove it entirely.

Compounding this: a real World App device emits **v4** payloads
(`protocol_version: "4.0"`, `uint256[5]` proof), while the hosted simulator emits
**v3** (`"3.0"`, `uint256[8]`). So the easy fixture source and the real device
disagree on protocol *and* target different chains — see W-03.

### W-08 — The docs' own example bricks any repeatable action
`WorldIDVerifier`'s example contract stores nullifiers for sybil resistance:

```solidity
nullifierUsed[nullifier] = true;
```

and the integration guide states the rule plainly:

> The same person verifying the same action always produces the same nullifier

Both are correct. Together they are a trap. For a one-shot action — mint, claim,
vote — spending the bare nullifier is exactly right. For a **repeatable** action
like swapping, that same line permits **one swap per human, for all time**, and
the second attempt fails with a "duplicate nullifier" error that reads like an
attack rather than a design error.

Nothing in the example flags that it is one-shot-only, and the failure appears
only on a user's *second* interaction — long after the code looks correct.

The per-request `nonce` is the way out: it is a public input, so
`keccak256(nullifier, nonce)` identifies one specific proof rather than one
person. ScubaSwap keys its spent set on that pair, which makes a proof
single-use while leaving the human free to trade again with a fresh one.
`test_humanOnly_sameHumanSwapsAgainWithFreshProof` pins the distinction: both
proofs share a nullifier and differ only in nonce.

### W-09 — A v4 fixture has a one-hour shelf life, which forces a pinned fork
Every other fork in this repo runs at `latest`, because Aqua and the routers do
not care what block they see. A v4 proof does: about an hour after it is
produced its Merkle root leaves the verifier's root history, and it stops
verifying anywhere (see W-06 for the measurement).

A `latest`-block fork therefore produces a suite that passes for one hour after
the fixture is captured and fails permanently thereafter — the worst possible
failure shape, because it looks green when written and broken when reviewed.

`WorldIdRealProof.t.sol` pins World Chain to the block whose timestamp sits
inside the fixture's root window. Worth knowing before generating a fixture for
a demo: it is not a build artefact you capture once, it is closer to a
screenshot with a timestamp.
