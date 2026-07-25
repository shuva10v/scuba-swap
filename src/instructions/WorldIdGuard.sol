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
    /// @dev `signalHash` is deliberately absent: the guard derives it from
    /// `ctx.query.taker` so a taker cannot present someone else's proof.
    function buildProof(uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            nullifier, nonce, expiresAtMin, proof[0], proof[1], proof[2], proof[3], proof[4]
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

    /// @notice World ID 4.0 verifier. Immutable so tests can point at a mock or
    /// at the staging proxy without a code change.
    IWorldIDVerifier public immutable WORLD_ID_VERIFIER;
    /// @notice `hashToField(action)` — NOT plain keccak256. FRICTION W-05.
    uint256 public immutable WORLD_ID_ACTION;
    /// @notice uint64 of the hex tail of the Developer Portal `rp_...` id.
    uint64 public immutable WORLD_ID_RP_ID;

    /// @notice Proofs already consumed, keyed by (nullifier, nonce).
    mapping(bytes32 proofId => bool spent) public spentProofs;

    constructor(IWorldIDVerifier verifier, string memory action, uint64 rpId) {
        WORLD_ID_VERIFIER = verifier;
        WORLD_ID_ACTION = bytes(action).hashToField();
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

        (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof) = _chopProof(ctx);

        _requireFresh(expiresAtMin);
        bytes32 id = proofId(nullifier, nonce);
        require(!spentProofs[id], WorldIdProofAlreadySpent(nullifier, nonce));

        // Reverts on failure. signalHash is derived, never taker-supplied.
        WORLD_ID_VERIFIER.verify(
            nullifier,
            WORLD_ID_ACTION,
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

        bytes calldata raw = ctx.tryChopTakerArgs(WorldIdGuardArgsBuilder.PROOF_LENGTH);
        if (raw.length < WorldIdGuardArgsBuilder.PROOF_LENGTH) return; // no proof: open tier

        (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof) = raw.parseProof();

        if (expiresAtMin < block.timestamp) return; // stale: open tier
        bytes32 id = proofId(nullifier, nonce);
        if (spentProofs[id]) return; // already used: open tier

        try WORLD_ID_VERIFIER.verify(
            nullifier,
            WORLD_ID_ACTION,
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

    /// @dev The check the verifier does not do. Without it a proof is valid
    /// forever and the entire anti-bot property evaporates. FRICTION W-06.
    function _requireFresh(uint64 expiresAtMin) internal view {
        require(expiresAtMin >= block.timestamp, WorldIdProofExpired(expiresAtMin, block.timestamp));
    }

    /// @dev Consume the fixed-size proof payload, failing loudly if short.
    function _chopProof(Context memory ctx)
        private
        pure
        returns (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof)
    {
        bytes calldata raw = ctx.tryChopTakerArgs(WorldIdGuardArgsBuilder.PROOF_LENGTH);
        require(
            raw.length == WorldIdGuardArgsBuilder.PROOF_LENGTH,
            WorldIdProofMissing(raw.length, WorldIdGuardArgsBuilder.PROOF_LENGTH)
        );
        return raw.parseProof();
    }

    /// @dev Mark a proof used — but only outside a staticcall, or `quote()`
    /// would revert. FRICTION F-03.
    function _spend(Context memory ctx, bytes32 id) private {
        if (!ctx.vm.isStaticContext) {
            spentProofs[id] = true;
        }
    }
}
