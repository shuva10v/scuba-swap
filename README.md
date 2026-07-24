# ScubaSwap — human-verified swaps inside 1inch Aqua / SwapVM

> EthGlobal Lisbon hackathon project.

A new SwapVM instruction that gates (and prices) a swap on a **World ID proof of
personhood**, so that a single shipped Aqua liquidity balance can serve two
different markets at once:

| Program | Who can take | Fee |
| --- | --- | --- |
| **A — open** | anyone | 0.30% |
| **B — HumanPrice tier** | anyone, humans get a discount | 0.30% / **0.05%** if verified |
| **C — human-only** | verified humans only | 0.05% |

All three run against **the same** `aqua.ship()`-ed USDC/WETH balance on our own
router. No new liquidity, no fork of Aqua, no fork of SwapVM.

---

## 1. Ground truth (verified, not assumed)

### Canonical mainnet addresses

| Contract | Address | Status |
| --- | --- | --- |
| Aqua | `0x499943e74fb0ce105688beee8ef2abec5d936d31` | ✅ verified live — `rawBalances(...)` returns `(0,0)` on mainnet |
| World ID Router v3 (`id.worldcoin.eth`) | `0x163b09b4fE21177c455D850BD815B6D583732432` | ✅ verified live — ENS resolves, 178-byte proxy |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | canonical |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | canonical |

There is **no canonical `AquaSwapVMRouter` address** in the 1inch repos —
`ignition/parameters/chain-1.json` still has `0x0000…` placeholders. Anyone can
deploy their own router against the shared Aqua registry; that is the whole point
of Aqua. So we deploy both the *stock* `AquaSwapVMRouter` (as a control) and our
`ScubaSwapVMRouter` on the fork.

### Corrections to the original design doc

Reading the real `1inch/swap-vm` source turned up five mismatches with the
brainstormed spec. The plan below reflects the corrected reality.

1. **The `_instructions()` array exists on the *tag*, but not on `main`.** Your
   spec matches `swap-vm@v1.0.1`. On `main`, that whole mechanism was replaced by
   a banked `enum Opcode` (`src/libs/OpcodeList.sol`) covering `0x00`–`0xff` and
   an if/else `_runOpcode(Context, uint256 opcode, bytes calldata)` chain. New
   instructions take the *next free slot in their family bank*.

   **We build against `main`, pinned at commit `0817db4a`.** On the tag, adding
   one instruction means restating all 35 entries of a static function-pointer
   array literal — which makes "keep stock opcode bytes stable" impossible to
   guarantee. On `main` it is `super._runOpcode(...)` and done. See FRICTION F-10.
   → we claim `0x27` (`OnlyHumanTaker`) and `0x33` (`JumpIfHumanTaker`) in the
   `0x20–0x3f` "conditions & access guards" bank, locked by a regression test.
2. **The router constructor takes 5 args, not 4:**
   `SwapVM(aqua, weth, owner, name, version)` — `owner` is for `Rescuable`.
3. **It is `ctx.vm.isStaticContext`**, not `ctx.isStaticContext`.
4. **`quote()` is `external` but *not* `view`.** It is *intended* to be
   staticcalled, and the repo's own helpers do exactly that via
   `swapVM.asView().quote(...)`. So any storage write inside an instruction
   reverts during quoting. Static branching is mandatory, not optional.
5. **Program instruction args are capped at 255 bytes** — `runLoop` reads a
   1-byte arg length. A Groth16 proof is `8 * 32 = 256` bytes before root and
   nullifier. Proof data therefore *must* travel in `takerArgs`, which confirms
   the original design. (`takerArgs` is `TakerTraits.instructionsArgs`.)

Also worth knowing:

- `ctx.query.taker == msg.sender` of `swap()`/`quote()`. The World ID **signal
  must be bound to that address**, and if a taker routes through an aggregator
  contract, `taker` is the aggregator. See FRICTION.md.
- `ContextLib.tryChopTakerArgs(ctx, n)` silently returns `min(n, available)`
  bytes. It does **not** revert when the taker supplied nothing — we must check
  the returned length ourselves.
- Neither `@1inch/swap-vm` nor `@1inch/aqua` is published to npm. Both are
  consumed as git deps (`swap-vm@0817db4a` on `main`, `aqua@v1.0.0`).
- The repos build with `solc 0.8.30`, `via_ir = true`, `optimizer_runs = 700`.
  We must match to link against their sources.

---

## 2. Architecture

```
src/
  instructions/WorldIdGuard.sol      — instruction mixin + args builder library
  opcodes/ScubaOpcodes.sol           — AquaOpcodes + WorldIdGuard, overrides _runOpcode
  routers/ScubaSwapVMRouter.sol      — Simulator + SwapVM + ScubaOpcodes
  interfaces/IWorldIDRouter.sol      — v3 router interface (verifyProof)
  helpers/ByteHasher.sol             — hashToField
```

Inheritance mirrors `AquaSwapVMRouter` exactly:

```solidity
contract ScubaSwapVMRouter is Simulator, SwapVM, ScubaOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version,
                IWorldIDRouter worldId, string memory appId, string memory action)
        SwapVM(aqua, weth, owner, name, version)
        ScubaOpcodes(aqua, worldId, appId, action) {}

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
```

```solidity
contract ScubaOpcodes is AquaOpcodes, WorldIdGuard {
    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if      (opcode == SCUBA_ONLY_HUMAN_TAKER)  WorldIdGuard._onlyHumanTaker(ctx, args);
        else if (opcode == SCUBA_JUMP_IF_HUMAN)     WorldIdGuard._jumpIfHumanTaker(ctx, args);
        else super._runOpcode(ctx, opcode, args);   // stock Aqua opcodes, untouched
    }
}
```

### One path: a fresh proof per swap. No verification window.

**Design decision (locked).** There is deliberately **no** `humanVerifiedUntil`
registry and no 30-day grant. A cached verification window would hand a bot a
month of "human" trading off a single proof handed over once. Every swap through
a human-gated program must carry its own proof in `takerArgs`.

```
program args (maker-set):  groupId(1)        — 1 = Orb. Maker picks the credential tier.
takerArgs   (taker-set):   nonce(32) || root(32) || nullifierHash(32) || proof[8](256)   = 352 bytes
```

The instruction:

```solidity
uint256 signalHash = abi.encodePacked(ctx.query.taker).hashToField();

// derived ON-CHAIN — never taken from takerArgs (see below)
uint256 externalNullifier = abi.encodePacked(
    APP_ID_HASH,                       // hashToField(appId), immutable
    ACTION_PREFIX, ctx.query.taker, nonce   // the action preimage
).hashToField();

require(!spentNullifiers[nullifierHash], NullifierAlreadySpent());
WORLD_ID.verifyProof(root, groupId, signalHash, nullifierHash, externalNullifier, proof);
if (!ctx.vm.isStaticContext) {
    spentNullifiers[nullifierHash] = true;   // anti-replay, not a cache
}
```

**Why `spentNullifiers` exists.** `verifyProof` is a `view` call — it consumes
nothing. With zero storage the *same* proof bytes stay valid until the merkle
root ages out (~1 week), which is exactly the bot licence we set out to avoid.
One proof = one swap requires marking the nullifier spent. It is the only storage
in the contract, and it is anti-replay rather than a grant.

**Why the external nullifier must vary per swap — this is mandatory, not
optional.** World ID defines `nullifierHash = H(identity_secret,
externalNullifier)`. With a *fixed* `externalNullifier = hash(appId, "swap")`,
every proof a given human ever produces collapses to the **same** nullifier
hash. Combined with a spent set, that means **one swap per human, ever** — the
gate would brick itself on the second trade. So the action preimage has to carry
per-swap entropy. `nonce` is what makes the design function at all; `taker` rides
along as free binding.

**Why the contract derives it instead of reading it from `takerArgs`.** If the
taker supplied `externalNullifier` directly, they would choose the action string
freely, and the binding to `taker` would be decorative — pick any action, get a
fresh nullifier, swap forever. Deriving it on-chain from data the VM already
holds (`ctx.query.taker`) is what makes the binding real. Only `nonce` is
taker-chosen, and that is fine: each nonce buys exactly one swap, enforced by the
spent set.

**Why `orderHash` is *not* in the preimage.** It is tempting — bind the proof to
one specific strategy. But `orderHash` is only known once the program bytes are
final, so a taker (and our test fixture) could not request a proof from IDKit
until after the strategy exists. That is a chicken-and-egg we cannot afford, and
the marginal security is near zero: the signal already binds the proof to the
taker, and the spent set already makes it single-use, so the only "reuse" a
proof enables is *the same human doing their own swap on another of our
programs*. Documented as a v2 upgrade in §6.

**Deliberately *not* bound: amounts.** `ctx.swap.amountIn` is only populated for
exact-in at guard time (`amountOut` is still 0 — the guard runs before the curve
instruction), so binding amounts would break exact-out flows outright and make
any quote→swap slippage invalidate the proof. `orderHash + taker + nonce` is the
right granularity.

> ⚠️ Off-chain, IDKit takes `action` as a **string** and hashes
> `abi.encodePacked(action)`. Our on-chain preimage must match byte-for-byte, so
> the frontend has to construct the action from the same encoding. Nailing this
> down is a Phase 5 blocker and a near-certain FRICTION entry.

**Static-context rule.** The `spent` write is gated on `!ctx.vm.isStaticContext`
so `quote()` survives its staticcall. Quote/swap consistency holds in both
directions: an unspent nullifier passes both; a spent one reverts both. Neither
touches the `ctx.swap` registers, so amounts are identical.

> ⚠️ **Liveness caveat — be honest about this in the demo.** A World ID **v3**
> Orb proof does *not* attest liveness. The credential is issued once at the Orb;
> proving later is a local ZK computation carrying no timestamp and no freshness
> attestation on-chain. Per-swap proofs buy a *UX* gate (a World App round-trip
> per trade) and remove the long-lived grant — they do not cryptographically
> prove a live human at swap time. The **v4** verifier (`expiresAtMin`, `nonce`,
> `credentialGenesisIssuedAtMin` — already written in the PoC as `verifyHumanV4`)
> is the path to real freshness, and is explicitly out of scope for v1.
> Tracked in FRICTION.md as W-01.

### Guard ordering

The identity instruction **must precede** the fee and swap instructions in every
program, so a rejected taker never reaches curve math. Programs:

```
A  open:        FlatFeeAmountIn(30bps)                → XYCSwap → Salt
B  human tier:  JumpIfHumanTaker(pc=HUMAN)            → FlatFeeAmountIn(30bps) → Jump(pc=SWAP)
                HUMAN: FlatFeeAmountIn(5bps)
                SWAP:  XYCSwap → Salt
C  human only:  OnlyHumanTaker → FlatFeeAmountIn(5bps) → XYCSwap → Salt
```

`JumpIfHumanTaker` mirrors stock `Whitelist._whitelistCoequal` (jump if allowed,
fall through otherwise), so the pattern is already blessed by the repo.

---

## 3. Implementation plan

Estimates assume ~30h budget. Phases 0–4 are the deliverable; 5–6 are stretch.

### Phase 0 — Repo & toolchain (~1h)

- [x] `git init`, first commit (hackathon requires visible incremental history)
- [x] `package.json` with git deps: `swap-vm@0817db4a` (main), `aqua#v1.0.0`,
      `@1inch/solidity-utils@6.9.10`, `@openzeppelin/contracts@5.4.0`,
      `forge-std#v1.11.0`
- [x] `foundry.toml`: solc `0.8.30`, `via_ir = true`, `optimizer_runs = 700`,
      `auto_detect_remappings = false`, `[rpc_endpoints] mainnet`
- [x] `remappings.txt` pointing at `node_modules/`
- [x] `.env.example` (`MAINNET_RPC_URL`) — fallback `https://ethereum-rpc.publicnode.com` works
- [x] `forge build` green against untouched swap-vm sources
- [x] Seed `FRICTION.md` (already started)

### Phase 1 — Fork baseline: stock router, zero custom code (~2h)

Proves the Aqua plumbing before any of our code exists.

- [x] `test/fork/ForkBase.t.sol` — `vm.createSelectFork(MAINNET_RPC_URL)` at latest block
- [x] Constants: real Aqua, WETH, USDC; `deal()` maker balances
- [x] Deploy **stock** `AquaSwapVMRouter(aqua, WETH, owner, "SwapVM", "1.0.0")` on the fork
- [x] Maker `approve(aqua)` + `aqua.ship(router, abi.encode(order), [USDC,WETH], [bal,bal])`
- [x] EOA taker (not `MockTaker`) executes `xycSwap + 30bps` end to end; assert balances
- [x] Same via `asView().quote()`; assert quote == swap

**Exit:** a real swap moves real mainnet USDC/WETH through shared Aqua liquidity.

### Phase 2 — ScubaSwapVMRouter with a dummy opcode (~2h)

Proves extension + program encoding independently of World ID.

- [x] `ScubaOpcodes` overriding `_runOpcode`, `super` fallthrough
- [x] `ScubaSwapVMRouter`
- [x] Temporary `0x27` = always-pass no-op
- [x] Test: every Phase-1 assertion still passes on the new router
- [x] Test: stock opcode bytes unchanged (`XYCSwap` is still `0x50`)
- [x] Test: unknown opcode still reverts `UnknownOpcode`

**Exit:** our router is a strict superset of `AquaSwapVMRouter`.

### Phase 3 — Real World ID guard (~6h)

- [ ] `IWorldIDRouter`, `ByteHasher` (from the PoC, unchanged)
- [ ] `MockWorldIDRouter` — accepts any proof. **Everything below is built
      and tested against this**, so Phase 3 is not blocked on a real proof.
- [ ] Encoding-agreement test: derive `signalHash` / `externalNullifier` in
      Solidity *and* independently off-chain, assert the field elements match.
      This is the one class of bug a mock cannot catch — cross-system encoding
      disagreement with IDKit — and it needs no proof to check.
- [ ] *(when fixture arrives)* one e2e test against the real router at
      `0x163b…`, proving the last mile: signal encoding, groupId, proof
      element order, root validity
- [ ] `EXTERNAL_NULLIFIER` immutable, derived in the constructor from
      `(appId, action)` via the PoC's `ByteHasher` double-`hashToField`
- [ ] `spentNullifiers` mapping + `NullifierAlreadySpent` error
- [ ] `WorldIdGuardArgsBuilder`: pack/parse `root || nullifier || proof[8]` (320B)
- [ ] `_onlyHumanTaker` — `tryChopTakerArgs(320)`, **explicit length check**
      (F-04: it fails open), parse `groupId` from program args
- [ ] `_jumpIfHumanTaker` — conditional-jump variant, mirrors `_whitelistCoequal`
- [ ] Static-context branch: verify always, mark spent only when `!isStaticContext`
- [ ] Negative tests:
  - [ ] no proof supplied at all → revert (**not** silent pass — the F-04 trap)
  - [ ] truncated / short `takerArgs` → revert
  - [ ] proof bound to a different signal (wrong taker) → revert
  - [ ] replayed nullifier, second swap → `NullifierAlreadySpent`
  - [ ] stale/unknown merkle root → revert (World ID `ExpiredRoot`)
  - [ ] wrong `groupId` in program args → revert
  - [ ] guard placed *after* the swap opcode → document why programs must not
- [ ] Test: `quote()` and `swap()` agree on amounts for the same proof payload
- [ ] Test: `quote()` does **not** spend the nullifier (staticcall, then swap works)

**Exit:** a real World ID proof gates a real Aqua swap on a mainnet fork.

### Phase 4 — Strategies A/B/C, invariants, gas (~5h)

- [ ] `ScubaStrategyBuilders` extending the repo's `AquaStrategyBuilders`
- [ ] Program A (open), B (tiered), C (human-only) built with `ProgramBuilder`
- [ ] All three shipped against **one** Aqua balance; test they coexist
- [ ] B: unverified taker pays 30bps, verified taker pays 5bps, same block
- [ ] C: unverified taker reverts, verified taker succeeds
- [ ] `MockWorldIDRouter` — accepts any proof, so tests can mint **distinct
      nullifiers per swap**. The World ID router is a constructor immutable, so
      this needs *no* test-only branch in `WorldIdGuard`: invariant runs point at
      the mock, fork e2e runs point at the real `0x163b…`.
- [ ] `CoreInvariants.assertAllInvariantsWithConfig` on A, B, C
      (note: `assertQuoteSwapConsistencyInvariant` is the one that matters here)
- [ ] Gas snapshot: program A vs C (proof overhead) → `snapshots/`
- [ ] `docs/PROGRAMS.md`-style writeup of the three programs

> **Why the mock is load-bearing:** one proof = one swap, and we have exactly one
> real fixture. The invariant suite performs many swaps per run (additivity,
> monotonicity, batch), so it cannot run on real proofs. Real fixture → dedicated
> e2e fork tests. Mock → invariants. Same contract bytecode either way.

**Exit:** the demo-able artifact.

### Phase 5 — Frontend: **STOP AND DISCUSS** (~4h)

Do not implement before agreeing the flow. Options to present:

- [ ] Write up options for: quote fetch, IDKit v3 / `orbLegacy` widget, packing
      the proof into `takerArgs`, sending `swap()`
- [ ] Decide EOA-taker vs contract-taker (changes the signal binding!)
- [ ] Then implement

### Phase 6 — Stretch

- [ ] Deploy `ScubaSwapVMRouter` to an OP-stack testnet
- [ ] Nullifier rotation / unbinding
- [ ] World ID v4 verifier path (`verifyHumanV4` from the PoC is already written)

Explicitly **out of scope for v1**: document/age/country attestations, selfie
freshness, v4 verifier path.

---

## 4. Risks

| Risk | Mitigation |
| --- | --- |
| Proof fixture's signal address ≠ our test taker address | Prank *as* the fixture address; use an EOA taker (`useTransferFromAndAquaPush`), not `MockTaker` |
| One fixture proof, but invariants need many swaps | `MockWorldIDRouter` for the invariant suite; real router for e2e (see Phase 4) |
| Merkle roots expire ~1 week | Fork at **latest** block; if the root is `latestRoot` it never expires on a frozen fork |
| `via_ir` compile times kill iteration speed | Optional `[profile.fast]` with `via_ir = false` for non-linking tests |
| Public RPC rate limits during fork tests | Foundry fork caching + a real RPC key if the user has one |
| Groth16 verify ~250k gas **on every** human-gated swap | Inherent to the no-cache design. Measure it, report it honestly, and use it to justify the tier split: program A stays cheap for everyone |
| v3 proofs don't attest liveness (W-01) | Out of scope for v1. Say so in the demo; point at the v4 path |

---

## 5. Blocked on — needed from you

1. **The World ID proof fixture** (Phase 3 cannot start without it):
   `root`, `nullifier_hash`, `proof` (as `uint256[8]`), the **signal address**
   the proof was generated for, `app_id`, `action`, and `groupId` (Orb = 1).
2. Confirm the signal encoding matches the PoC:
   `abi.encodePacked(account).hashToField()`.
3. A mainnet RPC URL if you have one (Alchemy/Infura); otherwise
   `https://ethereum-rpc.publicnode.com` is verified working.

---

## 6. Rules of engagement

- Foundry. Git history must show incremental work.
- Official contracts only. **Aqua is never modified.** All custom logic lives in
  `ScubaSwapVMRouter` and its mixins.
- Every World ID / SwapVM integration pain point goes in [FRICTION.md](./FRICTION.md).
