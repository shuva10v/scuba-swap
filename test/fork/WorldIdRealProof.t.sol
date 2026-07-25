// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";
import { ByteHasher } from "../../src/helpers/ByteHasher.sol";

/// @title WorldIdRealProofTest
/// @notice Runs a genuine World ID 4.0 proof, produced by a real device, against
/// the **live** `WorldIDVerifier` on a World Chain fork.
///
/// @dev This is the last mile that mocks structurally cannot cover. `MockWorldID
/// Verifier` checks that we pass the right public inputs; only the real verifier
/// checks that the Groth16 proof is actually valid, that our `uint256[5]`
/// ordering is right, and that our `action` reduction matches what the circuit
/// expects.
///
/// Reads `test/fixtures/worldid-v4.json` rather than hard-coding values, so the
/// committed fixture and the executed test cannot drift apart.
///
/// **Staging fixture only.** A production proof's nullifier is a persistent
/// pseudonymous identifier tied to a real Orb-verified identity — see the
/// fixture header. Both verifiers were measured to behave identically.
contract WorldIdRealProofTest is Test {
    using ByteHasher for bytes;

    address internal constant WORLD_ID_V4_STAGING = 0x703a6316c975DEabF30b637c155edD53e24657DB;

    struct Fixture {
        uint256 nullifier;
        uint256 action;
        uint64 rpId;
        uint256 nonce;
        uint256 signalHash;
        uint64 expiresAtMin;
        uint64 issuerSchemaId;
        uint256 credentialGenesisIssuedAtMin;
        uint256[5] proof;
    }

    IWorldIDVerifier internal verifier;
    Fixture internal fx;

    /// @dev Pinned, unlike every other fork in this repo. A v4 proof stops
    /// verifying about an hour after it is produced — not because of
    /// `expiresAtMin`, which the verifier ignores, but because its Merkle root
    /// ages out of the verifier's root history (measured below). Forking at
    /// `latest` would make this suite pass for one hour and then fail forever.
    /// Pinned to a block whose timestamp (1784976435) is inside the fixture's
    /// root window.
    uint256 internal constant PINNED_BLOCK = 32_820_398;

    function setUp() public {
        vm.createSelectFork(
            vm.envOr("WORLDCHAIN_RPC_URL", string("https://worldchain.drpc.org")), PINNED_BLOCK
        );
        verifier = IWorldIDVerifier(WORLD_ID_V4_STAGING);

        string memory json = vm.readFile("test/fixtures/worldid-v4.json");
        fx.nullifier = vm.parseJsonUint(json, ".solidityArgs.nullifier");
        fx.action = vm.parseJsonUint(json, ".solidityArgs.action");
        fx.rpId = uint64(vm.parseJsonUint(json, ".solidityArgs.rpId"));
        fx.nonce = vm.parseJsonUint(json, ".solidityArgs.nonce");
        fx.signalHash = vm.parseJsonUint(json, ".solidityArgs.signalHash");
        fx.expiresAtMin = uint64(vm.parseJsonUint(json, ".solidityArgs.expiresAtMin"));
        fx.issuerSchemaId = uint64(vm.parseJsonUint(json, ".solidityArgs.issuerSchemaId"));
        fx.credentialGenesisIssuedAtMin = vm.parseJsonUint(json, ".solidityArgs.credentialGenesisIssuedAtMin");

        uint256[] memory p = vm.parseJsonUintArray(json, ".solidityArgs.proof");
        require(p.length == 5, "fixture proof must be uint256[5]");
        for (uint256 i; i < 5; ++i) {
            fx.proof[i] = p[i];
        }
    }

    /// @notice A real proof verifies against the real verifier.
    function test_realProofVerifiesOnLiveVerifier() public view {
        _verify(fx);
    }

    /// @notice The fixture's `action` really is `hashToField`, not raw keccak256.
    /// @dev Recomputes it from the action string rather than trusting the stored
    /// number, so this fails if either the fixture or `ByteHasher` drifts.
    function test_fixtureActionIsHashToFieldOfTheActionString() public view {
        assertEq(fx.action, bytes("world-demo-v2").hashToField(), "fixture action is not hashToField(action)");
    }

    /// @notice The documented mapping is rejected by the live verifier.
    /// @dev FRICTION W-05 / worldcoin/developer-docs#147, asserted against the
    /// real contract rather than reasoned about.
    function test_documentedPlainKeccakActionIsRejected() public {
        Fixture memory bad = fx;
        bad.action = uint256(keccak256(bytes("world-demo-v2")));

        vm.expectRevert(bytes4(0x4a7f394f)); // InvalidAction()
        _verify(bad);
    }

    /// @notice The verifier discriminates — it is not accepting everything.
    /// @dev Without this, `test_realProofVerifiesOnLiveVerifier` would be
    /// satisfied by a verifier that never reverts.
    function test_liveVerifierRejectsPerturbedInputs() public {
        Fixture memory f;

        f = fx;
        f.signalHash ^= 1;
        vm.expectRevert(bytes4(0x7fcdd1f4)); // ProofInvalid()
        _verify(f);

        f = fx;
        f.nonce ^= 1;
        vm.expectRevert(bytes4(0x7fcdd1f4));
        _verify(f);

        f = fx;
        f.nullifier ^= 1;
        vm.expectRevert(bytes4(0x7fcdd1f4));
        _verify(f);

        f = fx;
        f.expiresAtMin += 1;
        vm.expectRevert(bytes4(0x7fcdd1f4));
        _verify(f);

        f = fx;
        f.issuerSchemaId = 2;
        vm.expectRevert(bytes4(0xc7eb504d)); // UnregisteredIssuerSchemaId()
        _verify(f);
    }

    /// @notice The verifier accepts a proof that is past its own `expiresAtMin`.
    /// @dev The single most important behaviour in this file, and the reason
    /// `WorldIdGuard._requireFresh` is not optional. `expiresAtMin` is committed
    /// into the proof — perturbing it reverts, as asserted above — yet it is
    /// never compared to `block.timestamp`. FRICTION W-06.
    function test_liveVerifierAcceptsProofPastItsOwnExpiry() public {
        vm.warp(uint256(fx.expiresAtMin) + 30 minutes);
        assertGt(block.timestamp, fx.expiresAtMin, "warp did not take effect");

        _verify(fx); // no revert
    }

    /// @notice Validity is bounded by Merkle-root history, not by `expiresAtMin`.
    /// @dev Corrects the tempting conclusion that an unchecked proof is valid
    /// *forever*. There IS a time bound — it is simply the wrong one, applied to
    /// the root rather than to the credential, and measured here at roughly an
    /// hour: the fixture verifies at +60 minutes and fails at +70 with
    /// `InvalidMerkleRoot()`.
    ///
    /// So the real replay exposure of an unguarded integration is about an hour,
    /// not infinity — but still one to two orders of magnitude longer than the
    /// proof's own stated lifetime, which is what `_requireFresh` restores.
    function test_proofValidityIsBoundedByRootHistoryNotExpiry() public {
        vm.warp(uint256(fx.expiresAtMin) + 60 minutes);
        _verify(fx); // still inside the root window

        vm.warp(uint256(fx.expiresAtMin) + 70 minutes);
        vm.expectRevert(bytes4(0x9dd854d3)); // InvalidMerkleRoot()
        _verify(fx);
    }

    function _verify(Fixture memory f) private view {
        verifier.verify(
            f.nullifier,
            f.action,
            f.rpId,
            f.nonce,
            f.signalHash,
            f.expiresAtMin,
            f.issuerSchemaId,
            f.credentialGenesisIssuedAtMin,
            f.proof
        );
    }
}
