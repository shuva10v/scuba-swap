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

### Deployed addresses (all verified live, not assumed)

**Ethereum mainnet** — where Aqua is canonical:

| Contract | Address |
| --- | --- |
| Aqua | `0x499943E74FB0cE105688beeE8Ef2ABec5D936d31` — confirmed via `rawBalances(...)` |
| WETH / USDC | `0xC02aaA39…6Cc2` / `0xA0b86991…eB48` |

**World Chain (480)** — where World ID 4.0 is canonical:

| Contract | Address |
| --- | --- |
| `WorldIDVerifier` (production) | `0x00000000009E00F9FE82CfeeBB4556686da094d7` |
| `WorldIDVerifier` (staging) | `0x703a6316c975DEabF30b637c155edD53e24657DB` |
| WETH / USDC | `0x42000000…0006` / `0x79A02482…24d1` |
| Aqua | **not deployed** — `eth_getCode` returns `0x` |

**The two do not overlap.** Aqua sits at the same address on Ethereum, Optimism,
Base, Arbitrum and Polygon, and on none of them is there a v4 verifier; World
Chain has the verifier and no Aqua. So one side has to be self-deployed, and we
deploy Aqua on a World Chain fork — permitted explicitly by its licence ("You may
read, use, deploy, and call Aqua"; §4 names hackathons as free use). FRICTION W-07.

The Ethereum suite still runs against *canonical* Aqua, so both claims are proven
on the chain where each can actually be made:

- `ScubaRouterFork.t.sol` (Ethereum) — our router does not disturb real Aqua
- `WorldIdRealProof.t.sol` (World Chain) — our encoding satisfies the real verifier

There is no canonical `AquaSwapVMRouter` anywhere; `chain-1.json` still ships
`0x0000…` placeholders. Anyone deploys their own router against the shared
registry — that is the point of Aqua.

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
  instructions/WorldIdGuard.sol    — guard instructions + args builder
  opcodes/ScubaOpcodes.sol         — AquaOpcodes + WorldIdGuard, overrides _runOpcode
  routers/ScubaSwapVMRouter.sol    — Simulator + SwapVM + ScubaOpcodes
  interfaces/IWorldIDVerifier.sol  — World ID 4.0 verify()
  helpers/ByteHasher.sol           — hashToField
```

Extension is additive: we handle `0x27` and `0x33`, and hand everything else to
`super._runOpcode(...)`, so every stock opcode keeps its number and behaviour.

```solidity
abstract contract ScubaOpcodes is AquaOpcodes, WorldIdGuard {
    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if      (opcode == SCUBA_OP_ONLY_HUMAN_TAKER) _onlyHumanTaker(ctx, args);
        else if (opcode == SCUBA_OP_JUMP_IF_HUMAN)    _jumpIfHumanTaker(ctx, args);
        else super._runOpcode(ctx, opcode, args);
    }
}
```

### World ID 4.0, one fresh proof per swap

We use **v4**, not the v3 legacy router. v3 cannot express liveness at all
(W-01); v4 commits `expiresAtMin` into the proof, which is the only mechanism
either version offers for "a human, recently".

Argument split — the **maker** fixes credential policy in the program, the
**taker** supplies the proof through `takerArgs`, so a taker can never downgrade
the credential the maker demanded:

```
program args (maker):  issuerSchemaId(8) || credentialGenesisIssuedAtMin(32)     =  40 B
taker args   (taker):  nullifier(32) || nonce(32) || expiresAtMin(8) || proof[5](160) = 232 B
                    || actionLen(1) || action(actionLen)                    = 233 + len B
```

`signalHash` is deliberately **not** in the payload — the guard derives it from
`ctx.query.taker`, so handing your proof to a bot buys it nothing unless the bot
also controls your address.

```solidity
require(expiresAtMin >= block.timestamp, WorldIdProofExpired(...));   // the verifier does NOT do this
bytes32 id = proofId(nullifier, nonce);
require(!spentProofs[id], WorldIdProofAlreadySpent(...));

require(_isActionAllowed(action), WorldIdActionNotAllowed());   // prefix, not equality

WORLD_ID_VERIFIER.verify(
    nullifier, action.hashToField(), WORLD_ID_RP_ID, nonce,
    abi.encodePacked(ctx.query.taker).hashToField(),
    expiresAtMin, issuerSchemaId, genesisMin, proof
);

if (!ctx.vm.isStaticContext) spentProofs[id] = true;   // quote() is a staticcall
```

Four things here are load-bearing, and each exists because of something measured
against the live verifier rather than read in a doc.

**The router commits to an action *prefix*, and the taker names the action.** This
looks like a weakening and is the opposite. World ID issues at most one proof per
`(identity, rp, action)`, and the cap is in the *issuer* — no contract can lift it.
So a router pinning one exact action gives each human a single gear-up for the
router's entire lifetime, after which their World App simply refuses to mint and
only a redeploy helps. Committing to `scubaswap-*` instead lets every dive name its
own action and mint a fresh proof, one liveness check each. The security boundary
never was the action: `WORLD_ID_RP_ID` pins the app, `_signalHash(taker)` binds the
proof to the address swapping, `spentProofs` makes it single-use, and `_isFresh`
bounds its life. W-08, W-10.

**`hashToField(action)`, not `keccak256(action)`.** The docs
specify the latter; it exceeds the BN254 modulus and reverts `InvalidAction()`.
Fixed upstream in [worldcoin/developer-docs#147](https://github.com/worldcoin/developer-docs/pull/147). W-05.

**The freshness check is ours to make.** `expiresAtMin` is committed into the
proof — perturb it by one and verification fails — but it is never compared to
`block.timestamp`. Warping a fork shows the real bound is the Merkle-root history
window, about an hour, rather than the proof's own stated lifetime. Without that
one `require`, the anti-bot property this project exists for simply is not there.
W-06.

**The spent set keys on `(nullifier, nonce)`, not `nullifier`.** World ID's own
example contract writes `nullifierUsed[nullifier] = true`, and the docs state
that the same person and action always produce the same nullifier. Correct for a
one-shot mint; for a repeatable action it permits **one swap per human, ever**.
The per-request nonce is what makes a proof single-use while leaving the human
free to trade again. W-08.

Quote and swap stay consistent in both directions: an unspent proof passes both,
a spent one is rejected by both, and neither touches `ctx.swap`.

### Guard ordering

The identity instruction **must precede** the fee and curve instructions, so a
rejected taker never reaches swap math — and so the guard stays outside the
nested `runLoop` that `FlatFeeAmountIn` opens (F-12).

```
A  open:        FlatFee(0.30%) -> XYCSwap -> Salt
C  human-only:  OnlyHumanTaker -> FlatFee(0.05%) -> XYCSwap -> Salt
B  tiered:      JumpIfHumanTaker(pc=54)
                  44: FlatFee(0.30%)      <- fall-through, opens nested loop
                  50: Jump(60)
                  54: FlatFee(0.05%)      <- human branch target
                  60: XYCSwap             <- shared tail
                  62: Salt
```

Program B's jump targets are absolute byte offsets, so any change to an earlier
instruction's argument length silently retargets them. `test_programBLayoutIsIntact`
pins the offsets so that fails first, loudly, instead of surfacing as a mispriced
swap.

`JumpIfHumanTaker` falls through on *any* failure — missing, stale, spent or
invalid proof — because it powers a discount tier, not a gate. Programs that must
reject use `OnlyHumanTaker`, which reverts.

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

- [x] `IWorldIDVerifier`, `ByteHasher`
- [x] `MockWorldIDVerifier` — keys on the full public-input tuple, so it rejects
      perturbations exactly as the real verifier does. **Everything below is built
      and tested against this**, so Phase 3 is not blocked on a real proof.
- [x] Encoding-agreement test: derive `signalHash` / `externalNullifier` in
      Solidity *and* independently off-chain, assert the field elements match.
      This is the one class of bug a mock cannot catch — cross-system encoding
      disagreement with IDKit — and it needs no proof to check.
- [x] *(when fixture arrives)* one e2e test against the real router at
      `0x163b…`, proving the last mile: signal encoding, groupId, proof
      element order, root validity
- [x] Action reduced with `hashToField`, **not** plain keccak256
- [x] `WORLD_ID_ACTION_PREFIX_HASH` immutable — prefix-scoped so a human can dive
      more than once (World ID caps issuance at one proof per action)
- [x] `spentProofs` keyed on `(nullifier, nonce)` — bare nullifier would brick
      repeatable actions (W-08)
- [x] `WorldIdGuardArgsBuilder`: 40B maker policy + 233B taker proof head + action
- [x] `_onlyHumanTaker` — `tryChopTakerArgs(233)` + action, **explicit length checks**
      (F-04: it fails open), plus mandatory `expiresAtMin >= block.timestamp` (W-06)
- [x] `_jumpIfHumanTaker` — conditional-jump variant, mirrors `_whitelistCoequal`
- [x] Static-context branch: verify always, mark spent only when `!isStaticContext`
- [x] Negative tests:
  - [x] no proof supplied at all → revert (**not** silent pass — the F-04 trap)
  - [x] truncated / short `takerArgs` → revert
  - [x] proof bound to a different signal (wrong taker) → revert
  - [x] replayed proof, second swap → `WorldIdProofAlreadySpent`
  - [x] same human swaps again with a fresh proof (the W-08 trap)
  - [x] expired proof → `WorldIdProofExpired`, which the verifier would accept
  - [x] live verifier: real proof verifies, perturbations rejected, root
        window measured at ~1h
  - [x] documented plain-keccak `action` rejected by the live verifier
  - [x] guard placed *after* the swap opcode → document why programs must not
- [x] Test: `quote()` and `swap()` agree on amounts for the same proof payload
- [x] Test: `quote()` does **not** spend the nullifier (staticcall, then swap works)

**Exit:** ✅ a real World ID v4 proof verifies against the live verifier, and the
guard gates real Aqua swaps on a World Chain fork. 43/43 tests green.

### Phase 4 — Strategies A/B/C, invariants, gas (~5h)

- [x] `ScubaStrategyBuilders` extending the repo's `AquaStrategyBuilders`
- [x] Program A (open), B (tiered), C (human-only) built with `ProgramBuilder`
- [x] All three shipped against **one** Aqua balance; test they coexist
- [x] B: unverified taker pays 30bps, verified taker pays 5bps, same block
- [x] C: unverified taker reverts, verified taker succeeds
- [x] `MockWorldIDVerifier` — keys on the full public-input tuple, so tests
      mint a **fresh proof per swap** (`_executeSwap`). The verifier is a
      constructor immutable, so this needs *no* test-only branch in the guard.
- [x] `CoreInvariants.assertAllInvariantsWithConfig` on A, B, C
      (note: `assertQuoteSwapConsistencyInvariant` is the one that matters here)
- [x] Gas snapshot: program A vs C (proof overhead) → `snapshots/`
- [x] `docs/PROGRAMS.md`-style writeup of the three programs

> **Why the mock is load-bearing:** one proof = one swap, and we have exactly one
> real fixture. The invariant suite performs many swaps per run (additivity,
> monotonicity, batch), so it cannot run on real proofs. Real fixture → dedicated
> e2e fork tests. Mock → invariants. Same contract bytecode either way.

**Exit:** ✅ 50/50 tests green. Invariants pass on both the open and the guarded
program; guard overhead measured at ~26k gas.

### Phase 5 — Frontend (~4h)

**Backend and infrastructure: ✅ deployed and live.**

- [x] `packages/sdk/takerArgs.mjs` — one byte-layout encoder shared by the
      frontend and the contracts, cross-checked against Solidity by
      `test/EncodingVectors.t.sol` (byte-for-byte *and* field order)
- [x] `script/demo-up.sh` — anvil fork of World Chain with Aqua, the router and
      all three programs shipped; smoke-tests live quotes through the SDK
- [x] RP signing service (`backend/`) — `signRequest` implemented from the spec
      and pinned against all published test vectors, including exact signature
      bytes
- [x] AWS: Lambda + HTTP API + CloudFront + Route53, one distribution so the SPA
      and `/api/*` are same-origin (no CORS in production)
- [x] **Live at `https://scubaswap.xyz/api/rp-signature`** — verified against the
      deployed endpoint: signs an allowlisted action, refuses a foreign one,
      `no-store` with `x-cache: Miss`, distinct nonces per call
- [ ] Vite + React + wagmi/viem scaffold, config from `deployments/demo.json`
- [ ] Depth panel wired to real `quote()` calls **before** any animation work
- [ ] IDKit with `proofOfHuman()` and `allow_legacy_proofs: false`
- [ ] Diver panel, dive computer, bot bounce

**IDKit correction:** the original sketch said `orbLegacy`, which is the **v3**
preset. Our guard verifies **v4** (`uint256[5]`, `WorldIDVerifier.verify`), so a
v3 proof is structurally unverifiable by it. `allow_legacy_proofs` must stay
**false**, and the SDK hard-rejects any payload that is not `protocol_version
4.0` with a `proof_of_human` credential rather than letting it fail on-chain.

**Still open:** a proof bound to a taker address we specify, for a guard-level
e2e test. Best generated right before the demo — a v4 proof stops verifying about
an hour after capture (W-09).

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
