// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context, ContextLib } from "@1inch/swap-vm/src/libs/VM.sol";

import { ByteHasher } from "../helpers/ByteHasher.sol";
import { IWorldIDVerifier } from "../interfaces/IWorldIDVerifier.sol";

/// @title WorldIdGuardArgsBuilder
/// @notice Packs and parses the two halves of a World ID guard invocation.
///
/// @dev The split is deliberate. The **maker** fixes credential policy in the
/// program (which credential, how old it may be); the **taker** supplies the
/// proof through `takerArgs`. A taker can therefore never downgrade the
/// credential the maker demanded.
///
/// Proof data cannot live in program args at all: `runLoop` reads a single
/// length byte per instruction, capping them at 255 bytes, and a v4 proof is
/// 160 bytes before the other fields. See FRICTION F-05.
library WorldIdGuardArgsBuilder {
    /// @dev issuerSchemaId(8) || credentialGenesisIssuedAtMin(32)
    uint256 internal constant POLICY_LENGTH = 40;
    /// @dev jumpPC(2) || issuerSchemaId(8) || credentialGenesisIssuedAtMin(32)
    uint256 internal constant POLICY_WITH_PC_LENGTH = 42;
    /// @dev nullifier(32) || nonce(32) || expiresAtMin(8) || proof[5](160)
    uint256 internal constant PROOF_LENGTH = 232;
    /// @dev The fixed head, plus the one-byte length of the action that follows.
    uint256 internal constant PROOF_HEAD_LENGTH = 233;

    /// @dev Longest action string the guard will hash.
    ///
    /// The action is taker-supplied and variable-length, so it needs a bound: it is
    /// hashed twice (once for the prefix check, once for `hashToField`) and an
    /// unbounded string would let a taker inflate the gas cost of a quote. 64 bytes
    /// fits any sane `prefix-<suffix>` and is far below the 255 a single length byte
    /// could express.
    uint256 internal constant MAX_ACTION_LENGTH = 64;

    /// @notice Maker policy for the strict guard (opcode 0x27).
    function buildPolicy(uint64 issuerSchemaId, uint256 credentialGenesisIssuedAtMin)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(issuerSchemaId, credentialGenesisIssuedAtMin);
    }

    /// @notice Maker policy for the conditional-jump guard (opcode 0x33).
    function buildPolicyWithPC(uint16 jumpPC, uint64 issuerSchemaId, uint256 credentialGenesisIssuedAtMin)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(jumpPC, issuerSchemaId, credentialGenesisIssuedAtMin);
    }

    /// @notice Taker proof payload, straight from an IDKit v4 response.
    ///
    /// @dev `signalHash` is deliberately absent: the guard derives it from
    /// `ctx.query.taker` so a taker cannot present someone else's proof.
    ///
    /// `action` *is* taker-supplied, and it must be: World ID issues at most one
    /// proof per (identity, rp, action), so a router pinning one exact action would
    /// give each human exactly one gear-up for the router's whole lifetime. The
    /// taker names the action they minted against and the guard checks it against
    /// the maker's prefix — see the `WORLD_ID_ACTION_PREFIX_HASH` notes for why that
    /// is safe.
    function buildProof(
        uint256 nullifier,
        uint256 nonce,
        uint64 expiresAtMin,
        uint256[5] memory proof,
        string memory action
    ) internal pure returns (bytes memory) {
        require(bytes(action).length <= MAX_ACTION_LENGTH, "action too long");
        return abi.encodePacked(
            nullifier,
            nonce,
            expiresAtMin,
            proof[0],
            proof[1],
            proof[2],
            proof[3],
            proof[4],
            uint8(bytes(action).length),
            action
        );
    }

    function parsePolicy(bytes calldata args)
        internal
        pure
        returns (uint64 issuerSchemaId, uint256 credentialGenesisIssuedAtMin)
    {
        assembly ("memory-safe") {
            issuerSchemaId := shr(192, calldataload(args.offset))
            credentialGenesisIssuedAtMin := calldataload(add(args.offset, 8))
        }
    }

    function parsePolicyWithPC(bytes calldata args)
        internal
        pure
        returns (uint256 jumpPC, uint64 issuerSchemaId, uint256 credentialGenesisIssuedAtMin)
    {
        assembly ("memory-safe") {
            jumpPC := shr(240, calldataload(args.offset))
            issuerSchemaId := shr(192, calldataload(add(args.offset, 2)))
            credentialGenesisIssuedAtMin := calldataload(add(args.offset, 10))
        }
    }

    function parseProof(bytes calldata args)
        internal
        pure
        returns (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof)
    {
        assembly ("memory-safe") {
            nullifier := calldataload(args.offset)
            nonce := calldataload(add(args.offset, 32))
            expiresAtMin := shr(192, calldataload(add(args.offset, 64)))
            // uint256[5] memory is five consecutive words, no length prefix.
            calldatacopy(proof, add(args.offset, 72), 160)
        }
    }

    /// @dev The action length byte that follows the fixed proof head.
    function parseActionLength(bytes calldata args) internal pure returns (uint256 len) {
        assembly ("memory-safe") {
            len := shr(248, calldataload(add(args.offset, PROOF_LENGTH)))
        }
    }
}

/// @title WorldIdGuard
/// @notice SwapVM instructions that gate a swap on a World ID 4.0 proof of
/// personhood, verified on-chain inside the swap.
///
/// @dev Design notes that are not obvious from the code:
///
/// **Freshness is ours to enforce.** `WorldIDVerifier.verify` commits
/// `expiresAtMin` into the proof but never compares it to `block.timestamp` —
/// measured, both fixtures verified minutes after expiry. Without the
/// `_requireFresh` check below, a single proof would gate swaps forever, which
/// is precisely the bot licence this project exists to prevent. FRICTION W-06.
///
/// **The spent set keys on (nullifier, nonce), not nullifier.** World ID's own
/// example contract writes `nullifierUsed[nullifier] = true`, and the docs state
/// plainly that "the same person verifying the same action always produces the
/// same nullifier". For a one-shot mint that is correct. For a *repeatable*
/// action like swapping it would permit one swap per human for all time. The
/// per-request `nonce` is what makes a proof single-use while leaving the human
/// free to trade again with a fresh proof. FRICTION W-08.
///
/// **Storage writes are gated on `!isStaticContext`.** `quote()` is staticcalled
/// via `asView()`, so marking a proof spent there would revert quoting outright.
/// Quote and swap stay consistent in both directions: an unspent proof passes
/// both, a spent one is rejected by both, and neither touches `ctx.swap`.
abstract contract WorldIdGuard {
    using ByteHasher for bytes;
    using ContextLib for Context;
    using WorldIdGuardArgsBuilder for bytes;

    /// @dev Taker supplied no proof, or a truncated one. Explicit because
    /// `tryChopTakerArgs` returns a short slice rather than reverting — a guard
    /// that trusted it would read zeros and treat "no proof" as a payload.
    /// FRICTION F-04.
    error WorldIdProofMissing(uint256 supplied, uint256 required);
    /// @dev Maker policy args are malformed. A short policy would silently
    /// demand issuerSchemaId 0, so this must fail loudly too.
    error WorldIdPolicyMalformed(uint256 supplied, uint256 required);
    /// @dev Proof is past its own expiry. The verifier does NOT check this.
    error WorldIdProofExpired(uint64 expiresAtMin, uint256 timestamp);
    /// @dev This exact proof has already been used for a swap.
    error WorldIdProofAlreadySpent(uint256 nullifier, uint256 nonce);
    /// @dev The taker-supplied action does not start with the maker's prefix.
    error WorldIdActionNotAllowed();

    /// @notice World ID 4.0 verifier. Immutable so tests can point at a mock or
    /// at the staging proxy without a code change.
    IWorldIDVerifier public immutable WORLD_ID_VERIFIER;

    /// @notice `keccak256` of the required action prefix, with its length.
    ///
    /// @dev Not the action itself, and that is the difference between a demo you can
    /// run once and one you can run repeatedly.
    ///
    /// World ID issues at most one proof per (identity, rp, action) — the cap is at
    /// the *issuance* layer, so it is not something a contract can lift. Pinning one
    /// exact action therefore gave each human a single gear-up per router deployment,
    /// after which their device refused to mint and only a redeploy helped. Since a
    /// swap is a repeatable action, that is the wrong shape entirely (FRICTION W-08,
    /// W-10).
    ///
    /// Committing to a prefix instead lets the taker name `"<prefix>-<suffix>"` and
    /// mint a fresh proof per dive. What it costs: any action under this rp sharing
    /// the prefix is accepted, so the prefix must be specific enough not to collide
    /// with some other purpose in the same app.
    ///
    /// The security boundary is unchanged, because it was never the action:
    ///  - `WORLD_ID_RP_ID` still pins the app, so no other app's proof is usable
    ///  - `_signalHash(taker)` still binds the proof to the address swapping
    ///  - `spentProofs` still makes each proof single-use
    ///  - `_isFresh` still bounds its lifetime
    ///
    /// A free choice of suffix means a human can gear up as often as they like — one
    /// World App liveness check each time. That is the intended property: the goal is
    /// "a human is here now", not "this human has traded once".
    ///
    /// Note an exact action is still expressible: pass the whole action as the
    /// prefix, and only that string satisfies the check.
    bytes32 public immutable WORLD_ID_ACTION_PREFIX_HASH;
    /// @notice Length in bytes of the committed prefix.
    uint256 public immutable WORLD_ID_ACTION_PREFIX_LENGTH;

    /// @notice uint64 of the hex tail of the Developer Portal `rp_...` id.
    uint64 public immutable WORLD_ID_RP_ID;

    /// @notice How long after `expiresAtMin` a proof is still accepted.
    ///
    /// @dev Not zero, and that is a correction rather than a loosening.
    /// `expires_at_min` reads as "the credential expires no earlier than T", and
    /// World App sets T to roughly the moment of issuance — so a bare
    /// `T >= block.timestamp` is false within a second or two of minting and no
    /// real taker could ever satisfy it.
    ///
    /// 15 minutes keeps the property that matters: an on-chain freshness bound
    /// the verifier itself does not provide. The verifier's own limit is the
    /// Merkle-root history window, measured at roughly an hour, so this is still
    /// four times tighter than doing nothing — while being long enough to sign a
    /// transaction in.
    uint64 public constant PROOF_FRESHNESS_WINDOW = 15 minutes;

    /// @notice Proofs already consumed, keyed by (nullifier, nonce).
    mapping(bytes32 proofId => bool spent) public spentProofs;

    constructor(IWorldIDVerifier verifier, string memory actionPrefix, uint64 rpId) {
        // An empty prefix would accept every action under the rp. That may be
        // defensible, but it should be a deliberate choice rather than the result of
        // forgetting a constructor argument.
        require(bytes(actionPrefix).length > 0, "empty action prefix");
        require(bytes(actionPrefix).length <= WorldIdGuardArgsBuilder.MAX_ACTION_LENGTH, "action prefix too long");

        WORLD_ID_VERIFIER = verifier;
        WORLD_ID_ACTION_PREFIX_HASH = keccak256(bytes(actionPrefix));
        WORLD_ID_ACTION_PREFIX_LENGTH = bytes(actionPrefix).length;
        WORLD_ID_RP_ID = rpId;
    }

    /// @notice Identifier for one specific proof.
    function proofId(uint256 nullifier, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encode(nullifier, nonce));
    }

    // ===== instructions =====

    /// @notice Opcode 0x27 — revert unless the taker proved personhood.
    /// @dev Must precede fee and curve instructions in a program so a rejected
    /// taker never reaches swap math. It also keeps the guard out of the nested
    /// `runLoop` that `FlatFeeAmountIn` opens. FRICTION F-12.
    /// @param args issuerSchemaId(8) || credentialGenesisIssuedAtMin(32)
    function _onlyHumanTaker(Context memory ctx, bytes calldata args) internal {
        require(
            args.length >= WorldIdGuardArgsBuilder.POLICY_LENGTH,
            WorldIdPolicyMalformed(args.length, WorldIdGuardArgsBuilder.POLICY_LENGTH)
        );
        (uint64 issuerSchemaId, uint256 genesisMin) = args.parsePolicy();

        (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof, uint256 actionId) =
            _chopProof(ctx);

        _requireFresh(expiresAtMin);
        bytes32 id = proofId(nullifier, nonce);
        require(!spentProofs[id], WorldIdProofAlreadySpent(nullifier, nonce));

        // Reverts on failure. signalHash is derived, never taker-supplied.
        WORLD_ID_VERIFIER.verify(
            nullifier,
            actionId,
            WORLD_ID_RP_ID,
            nonce,
            _signalHash(ctx.query.taker),
            expiresAtMin,
            issuerSchemaId,
            genesisMin,
            proof
        );

        _spend(ctx, id);
    }

    /// @notice Opcode 0x33 — jump to `jumpPC` if the taker proved personhood,
    /// otherwise continue. Mirrors stock `Whitelist._whitelistCoequal`.
    /// @dev Falls through on *any* failure rather than reverting: this powers a
    /// discount tier, not a gate, so a missing or bad proof must simply mean
    /// "pay the open price". Programs needing rejection use `_onlyHumanTaker`.
    /// @param args jumpPC(2) || issuerSchemaId(8) || credentialGenesisIssuedAtMin(32)
    function _jumpIfHumanTaker(Context memory ctx, bytes calldata args) internal {
        require(
            args.length >= WorldIdGuardArgsBuilder.POLICY_WITH_PC_LENGTH,
            WorldIdPolicyMalformed(args.length, WorldIdGuardArgsBuilder.POLICY_WITH_PC_LENGTH)
        );
        (uint256 jumpPC, uint64 issuerSchemaId, uint256 genesisMin) = args.parsePolicyWithPC();

        bytes calldata raw = ctx.tryChopTakerArgs(WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH);
        if (raw.length < WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH) return; // no proof: open tier

        // The action is chopped even when it turns out to be unusable, so that the
        // taker-args cursor lands in the same place either way. Leaving it unconsumed
        // would hand the following instruction the action bytes as its own payload.
        bytes calldata action = ctx.tryChopTakerArgs(raw.parseActionLength());
        if (!_isActionAllowed(action)) return; // wrong action: open tier

        (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof) = raw.parseProof();

        if (!_isFresh(expiresAtMin)) return; // stale: open tier
        bytes32 id = proofId(nullifier, nonce);
        if (spentProofs[id]) return; // already used: open tier

        try WORLD_ID_VERIFIER.verify(
            nullifier,
            action.hashToField(),
            WORLD_ID_RP_ID,
            nonce,
            _signalHash(ctx.query.taker),
            expiresAtMin,
            issuerSchemaId,
            genesisMin,
            proof
        ) {
            _spend(ctx, id);
            ctx.setNextPC(jumpPC);
        } catch {
            // Invalid proof: open tier. Deliberately not a revert.
        }
    }

    // ===== internals =====

    /// @dev Binds a proof to the address executing the swap. IDKit hashes a
    /// `0x`-prefixed signal by hex-decoding it to raw bytes, which is byte-for-byte
    /// what `abi.encodePacked(address)` produces — the agreement is pinned by
    /// `test/WorldIdEncoding.t.sol`.
    ///
    /// Note `ctx.query.taker` is `msg.sender`, so a taker routing through an
    /// aggregator would have to bind the proof to the aggregator. FRICTION F-06.
    function _signalHash(address taker) internal pure returns (uint256) {
        return abi.encodePacked(taker).hashToField();
    }

    /// @dev The check the verifier does not do. Without it a proof is bounded only
    /// by the root-history window (~1 hour), and the anti-bot property is
    /// whatever World ID happens to allow. FRICTION W-06.
    ///
    /// Widened to `uint256` before adding: `expiresAtMin` is a taker-supplied
    /// `uint64`, so `expiresAtMin + WINDOW` could otherwise wrap and turn an
    /// ancient proof into a fresh one.
    function _isFresh(uint64 expiresAtMin) internal view returns (bool) {
        return uint256(expiresAtMin) + uint256(PROOF_FRESHNESS_WINDOW) >= block.timestamp;
    }

    function _requireFresh(uint64 expiresAtMin) internal view {
        require(_isFresh(expiresAtMin), WorldIdProofExpired(expiresAtMin, block.timestamp));
    }

    /// @dev Is `action` one the maker allows — i.e. does it start with the committed
    /// prefix?
    ///
    /// Compares hashes rather than bytes so the prefix costs one immutable word
    /// instead of a storage string. The length check is not redundant: without it a
    /// short action would slice out fewer bytes than the prefix and could not match,
    /// but `bytes[:n]` with `n > length` reverts with a bare panic rather than
    /// falling through to the open tier, which would break `_jumpIfHumanTaker`'s
    /// contract of never reverting.
    function _isActionAllowed(bytes calldata action) internal view returns (bool) {
        if (action.length < WORLD_ID_ACTION_PREFIX_LENGTH) return false;
        if (action.length > WorldIdGuardArgsBuilder.MAX_ACTION_LENGTH) return false;
        return keccak256(action[:WORLD_ID_ACTION_PREFIX_LENGTH]) == WORLD_ID_ACTION_PREFIX_HASH;
    }

    /// @dev Consume the proof payload and its action, failing loudly if either is
    /// short or the action is not allowed. Returns the action already reduced to a
    /// field element, since that is the only form the verifier accepts.
    function _chopProof(Context memory ctx)
        private
        view
        returns (
            uint256 nullifier,
            uint256 nonce,
            uint64 expiresAtMin,
            uint256[5] memory proof,
            uint256 actionId
        )
    {
        bytes calldata raw = ctx.tryChopTakerArgs(WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH);
        require(
            raw.length == WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH,
            WorldIdProofMissing(raw.length, WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH)
        );

        uint256 actionLength = raw.parseActionLength();
        bytes calldata action = ctx.tryChopTakerArgs(actionLength);
        // `tryChopTakerArgs` clamps to what is left rather than reverting, so a
        // truncated action arrives as a short slice and must be caught here.
        require(action.length == actionLength, WorldIdProofMissing(action.length, actionLength));
        require(_isActionAllowed(action), WorldIdActionNotAllowed());

        (nullifier, nonce, expiresAtMin, proof) = raw.parseProof();
        actionId = action.hashToField();
    }

    /// @dev Mark a proof used — but only outside a staticcall, or `quote()`
    /// would revert. FRICTION F-03.
    function _spend(Context memory ctx, bytes32 id) private {
        if (!ctx.vm.isStaticContext) {
            spentProofs[id] = true;
        }
    }
}
