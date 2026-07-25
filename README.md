# ScubaSwap — World ID-verified swaps inside 1inch Aqua / SwapVM

> EthGlobal Lisbon hackathon project.

[![tests](https://github.com/shuva10v/scuba-swap/actions/workflows/tests.yml/badge.svg)](https://github.com/shuva10v/scuba-swap/actions/workflows/tests.yml)

Two new SwapVM instructions that gate — and price — a swap on a **World ID proof of
personhood**, so one maker's liquidity can serve several markets at once:

| Program | Opcode | Who can take | Fee |
| --- | --- | --- | --- |
| **A — open** | — | anyone | 0.30% |
| **B — human tier** | `0x33` `JumpIfHumanTaker` | anyone; humans get a discount | 0.30% / **0.05%** if verified |
| **C — human-only** | `0x27` `OnlyHumanTaker` | verified humans only | 0.05% |
| **D — the reef** | `0x27` **twice** | personhood **and** passport | **0.01%** |

All three run against the same maker's `aqua.ship()`-ed balance, backed by tokens that
never leave their wallet. No new liquidity, no fork of Aqua, no fork of SwapVM — the
guard is a mixin on our own router, dispatched through `_runOpcode` with a `super`
fallthrough.

Program D needs no new opcode and no contract change. `tryChopTakerArgs` advances a cursor, so
two `OnlyHumanTaker` instructions consume two proof payloads in sequence — and the credential
type is *already* maker policy (`issuerSchemaId` in program args), so demanding a passport is a
program change, not a Solidity one. Both schema ids were probed against the live verifier:
`1` = proof of human, `9303` = passport (ICAO 9303). The two proofs must come from two separate
World App requests, because both credentials in one request share a nullifier *and* a nonce, so
the second guard would reject the first's spent entry.

The two guards differ in one deliberate way. `OnlyHumanTaker` reverts; `JumpIfHumanTaker`
**cannot**, because it powers a discount rather than a gate, so a missing, stale, spent or
invalid proof all just mean "pay the open price". That asymmetry is the whole design, and
it is also the hardest thing to debug — which is why the UI detects the silent
fall-through and names it.

Verified end to end on World Chain mainnet: see [§0](#0-live).

---

## 0. Live

**[scubaswap.xyz](https://scubaswap.xyz)** — deployed on **World Chain mainnet (480)**,
with a router per World ID environment so both the real World App and the simulator can
be demonstrated without a redeploy.

| | Address |
| --- | --- |
| Router (production verifier) | [`0x8B4685249b298383F5a9c24BAd77cfd5AdFa3af1`](https://worldscan.org/address/0x8B4685249b298383F5a9c24BAd77cfd5AdFa3af1) |
| Router (staging verifier) | [`0x37DFff7873f6094c9747a19bE7FAaC10Af5fB82b`](https://worldscan.org/address/0x37DFff7873f6094c9747a19bE7FAaC10Af5fB82b) |
| Aqua (self-deployed) | [`0x89EaCa90b4e905BD033f8892c27a27C3e175B113`](https://worldscan.org/address/0x89EaCa90b4e905BD033f8892c27a27C3e175B113) |
| `WorldIDVerifier` production / staging | `0x00000000009E00F9FE82CfeeBB4556686da094d7` / `0x703a6316c975DEabF30b637c155edD53e24657DB` |
| `dWETH` / `dUSDC` | [`0x8C8F1D10C96c9C611c963160EDD5BD721F6BACFf`](https://worldscan.org/address/0x8C8F1D10C96c9C611c963160EDD5BD721F6BACFf) / [`0x09C1526a7CbE078378D1F79c5d218030A1C083Dc`](https://worldscan.org/address/0x09C1526a7CbE078378D1F79c5d218030A1C083Dc) |

Aqua is self-deployed because **Aqua and World ID 4.0 do not overlap on any chain**.
Aqua sits at one canonical address on Ethereum, Optimism, Base, Arbitrum and Polygon and
there is no v4 verifier on any of them; World Chain has the verifier and no Aqua. One side
therefore has to be deployed, which Aqua's licence permits explicitly ("You may read, use,
deploy, and call Aqua"; §4 names hackathons as free use). W-07. Aqua itself is never
modified — the guard is a mixin on our own router.

A **faucet** hands out 1 `dWETH` per address per hour, so a visitor can try the guard
without being sent to a block explorer first. Deliberately ungated: requiring a proof to
get the tokens you need in order to test the proof would be a closed loop. The cooldown is
a fairness guard rather than a supply limit — `DemoToken.mint` is permissionless by design,
so anyone can bypass the faucet entirely, which is fine for a token that is worth nothing.

The traded pair is two freely-mintable demo tokens, not canonical WETH/USDC. Shipping
liquidity means granting Aqua an unlimited allowance, and an allowance is only ever as
dangerous as the token behind it — these are worth nothing, so a first live deployment
risks nothing. The 18dp/6dp mismatch is kept deliberately (F-14, F-15).

### The claim, measured on mainnet

Two real swaps from the same non-maker account against the same router:

| | [`0x08e8bda0…`](https://worldscan.org/tx/0x08e8bda02793e7e40c7e62289a177274616350e062c092cd8484d7bdd2ffeb70) | [`0x5f7eb3f9…`](https://worldscan.org/tx/0x5f7eb3f9d4a0ab2227e2e4aafda31ba19ee8ebc6fb36088bc71ef97d10d967da) |
| --- | --- | --- |
| Program | open (0.30%) | tiered (`JumpIfHumanTaker`) |
| Taker args | 22 B — traits only | 275 B — **proof attached** |
| Gas | **114,721** | **514,451** |

A third, on program D — [`0x1f98fde9…`](https://worldscan.org/tx/0x1f98fde9dd6da8c25e55340af4edf87f911abfdc70499f31c8117c543d07a096) —
carries **two** proofs in 528 bytes of taker args and costs **838,297** gas, pricing at
3,999.59 per `dWETH` against the 3,984.03 open quote. The two payloads name different actions
(`scubaswap-1785014247` and `scubaswap-1785015059`), which is the design working as intended:
one World App round trip each, since both credentials in a single request would share a
nullifier and collide on the spent set.

- **399,730 gas** is the on-chain Groth16 verification, within ~1% of the figure the
  test suite predicted. It is the honest cost of the design, and the argument for the
  tier split: the surface stays cheap for everyone. The second verification adds 323,846 —
  cheaper than the first, because the fixed cost of touching the verifier is already paid.
- The proven swap priced at **3,994.01** per `dWETH` against a **3,984.03** open quote —
  the guard verified, the jump was taken, and the discount is real.
- The 275 bytes are exactly the layout: proof (232) ‖ action length (1) ‖ action (20)
  ‖ taker traits (22).

---

## 1. Architecture

Three moving parts. The interesting one is the router; the other two exist because a
World ID 4.0 proof cannot be produced by a contract or requested without a signed
identity.

**Custom Aqua router** — `src/`, Solidity, deployed on World Chain. A `SwapVM` router
with two extra opcodes, `0x27 OnlyHumanTaker` and `0x33 JumpIfHumanTaker`, verifying a
Groth16 proof against the live `WorldIDVerifier` *inside* the swap. Liquidity is
`aqua.ship()`-ed against it and never leaves the maker's wallet. One router per World ID
environment, because the verifier is a constructor immutable and the staging and
production identity trees are separate. Aqua itself is untouched: the guard is a mixin,
dispatched through `_runOpcode` with a `super` fallthrough so every stock opcode keeps its
number.

**Backend** — `backend/` and `infra/`, a single Lambda behind CloudFront. It does exactly
one thing: sign the `rp_context` a v4 proof request requires. That signature *is* the app's
identity, so the key lives in Secrets Manager and is never in the bundle — IDKit also
exports `signRequest`, and calling it client-side would ship the key to every visitor. The
endpoint allowlists action **prefixes** and fails closed if the allowlist is unset,
because without one it is an oracle that lends our RP identity to anyone who asks.

**Frontend** — `frontend/`, Vite + React + viem, same origin as the API so production
needs no CORS. It quotes all three programs live, requests the proof through IDKit, and
packs the taker payload with `packages/sdk/takerArgs.mjs` — the *same* encoder the
contracts are tested against, so the byte layout cannot drift between them
(`test/EncodingVectors.t.sol` asserts it byte-for-byte and in field order). Nothing on the
page is simulated; if the chain is unreachable the bands say so rather than showing a
plausible number.

```
                 IDKit / World App          WorldIDVerifier (World Chain)
                        │                              ▲
                        │ proof                        │ verify()
                        ▼                              │
  frontend ──── rp_context ───▶ backend        custom router ──── ship/pull/push ───▶ Aqua
      │         (signed)        (Lambda)             ▲                                 │
      └──────── swap(order, amount, takerArgs) ──────┘                    maker's wallet
```

Every integration pain point found along the way is logged in
[FRICTION.md](./FRICTION.md) — 16 for Aqua/SwapVM, 14 for World ID.

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

---

## 2. Implementation plan

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
- [x] Vite + React + viem scaffold, config from `deployments/demo.json`
- [x] Depth panel wired to real `quote()` calls **before** any animation work
- [x] IDKit v4 (`IDKitRequestWidget`, `constraints`, `allow_legacy_proofs: false`)
- [x] Diver panel, gear checklist, inline dive-certification card
- [x] Dive computer — the decoded shipped program, with the taken branch highlighted
- [x] **Deployed to World Chain mainnet**, two routers (one verifier each) sharing one
      Aqua and one token pair, with an environment toggle in the page header
- [x] `script/deploy-worldchain.sh` — dry-run by default, reads every immutable back
      from the chain after deploying, reuses existing tokens so a second router does not
      orphan the first
- [x] `script/deploy-frontend.sh` — refuses to publish a config pointing at a local
      fork, or a bundle missing the app id; both refusals verified against the real stack
- [x] `DemoFaucet` + claim button — 1 `dWETH` per address per hour, with the cooldown read
      from the chain and counted down in the button so it says how long rather than just
      refusing
- [x] **Live at [scubaswap.xyz](https://scubaswap.xyz)**

Not in the original plan, and each one a consequence of something measured:

- [x] **Prefix-scoped actions.** World ID issues one proof per `(identity, rp, action)`,
      so a pinned action gave each human a single gear-up per deployment — after which
      their device answered `nullifier_replayed` forever. The router commits to a prefix
      and each dive names `<prefix>-<timestamp>`. W-11.
- [x] **Selectable tier.** The tier used to follow the proof automatically, which meant
      the two prices could never be compared. Tapping a band picks the program the dive
      executes, so the fee difference is read off the chain rather than asserted.
- [x] **Both directions.** `isAToB` is one bit of taker traits and the guard is
      symmetric; only the UI had pinned it. Verified both ways on mainnet.
- [x] Balances polled and batched through Multicall3; insufficient-balance guard
- [x] A warning when the connected account is the maker — Aqua never moves the maker's
      tokens, so a self-trade nets to zero and looks like a broken balance

**IDKit correction:** the original sketch said `orbLegacy`, which is the **v3**
preset. Our guard verifies **v4** (`uint256[5]`, `WorldIDVerifier.verify`), so a
v3 proof is structurally unverifiable by it. `allow_legacy_proofs` stays **false**,
and the SDK hard-rejects any payload that is not `protocol_version 4.0` with a
`proof_of_human` credential rather than letting it fail on-chain.

The request uses `constraints={CredentialRequest("proof_of_human", { signal })}` rather
than the `proofOfHuman` preset — the explicit form, and the only one that *could* express
`genesis_issued_at_min` or `expires_at_min`. Both are deliberately unset: the former is a
public input taken from the maker's program args on chain, so a request-side value that
did not match would fail every verification; the latter would let the client widen the
guard's freshness window from the browser. W-12.

**Resolved:** the guard-level end-to-end test is no longer a fixture problem — it is two
mainnet transactions, above.

### Phase 6 — Stretch

- [x] Deploy `ScubaSwapVMRouter` to an OP-stack chain — done, and to mainnet rather
      than a testnet, because World ID 4.0 exists only on World Chain (W-07)
- [ ] Migrate to **sessions**, the primitive actually designed for a repeatable action.
      Not adopted yet for two reasons, both documented in W-14: a session request cannot
      express an identity check, which rules out the attestation gear on the roadmap; and
      whether a session proof verifies on chain is genuinely unclear, since the on-chain
      page never mentions sessions while the protocol repo says they share the circuits.
- [ ] Mask and tank — age and jurisdiction attestations, the `−30 m` reef tier

Explicitly **out of scope for v1**: document/age/country attestations and selfie
freshness. The **v4 verifier path is not stretch — it is the only path this project ever
used**; the v3 sketch in the original PoC was discarded in Phase 3.

---

## 3. Resolved unknowns

Everything this plan was blocked on is answered, and each answer cost something worth
recording:

1. **The proof fixture.** A staging v4 proof is committed (`test/fixtures/worldid-v4.json`)
   and verified against the live staging verifier. The production one is deliberately
   *not* committed — a production nullifier is a persistent pseudonymous identifier.
2. **Signal encoding.** `abi.encodePacked(account).hashToField()`, pinned against
   externally produced vectors in `test/WorldIdEncoding.t.sol`. IDKit hex-decodes a
   `0x`-prefixed signal to raw bytes, which is byte-for-byte what `encodePacked` produces.
3. **The action mapping.** `hashToField(action)`, **not** `keccak256(action)` as the docs
   said — the latter exceeds the BN254 modulus and reverts `InvalidAction()`. Fixed
   upstream in [worldcoin/developer-docs#147](https://github.com/worldcoin/developer-docs/pull/147). W-05.
4. **RPC.** The public World Chain endpoint works; the frontend records its RPC in the
   deployment config so a mainnet build can never be read over a localhost URL, and reads
   are batched through Multicall3 so polling does not invite a rate limit.

Two facts the verifier taught us that no document states:

- **It does not check expiry.** `expiresAtMin` is committed into the proof — perturb it
  and verification fails — but never compared to `block.timestamp`. A proof verifies fine
  well past it. The freshness bound is ours to enforce, and without it the anti-bot
  property this project exists for is simply absent. W-06.
- **The action is a circuit input; the rp is bound too.** Perturbing the action to a
  different valid field element gives `ProofInvalid`, which is what makes it safe to let
  the taker name it. No substituted `rpId` verifies either — though that test cannot
  fully separate "bound into the proof" from "not registered on this verifier".
