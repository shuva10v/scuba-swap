// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { WorldIdGuardArgsBuilder } from "../src/instructions/WorldIdGuard.sol";

/// @title EncodingVectorsTest
/// @notice Asserts the frontend's packer and the contract's parser agree on
/// byte layout, byte for byte.
///
/// @dev The vectors in `test/fixtures/encoding-vectors.json` are produced by
/// `packages/sdk/generate-vectors.mjs`, which calls the *same* functions the
/// frontend calls. That indirection is the whole point: hand-transcribing the
/// expected bytes into this file would only prove Solidity agrees with a
/// transcription, not with the code that actually ships.
///
/// Regenerate after any layout change:
///     node packages/sdk/generate-vectors.mjs
///
/// A disagreement here is cheap. The same disagreement in production is a proof
/// that either reverts `ProofInvalid()` for no visible reason, or — far worse —
/// parses cleanly into the wrong fields.
contract EncodingVectorsTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("test/fixtures/encoding-vectors.json");
    }

    /// @notice The taker payload — proof head, action length byte and action —
    /// matches the JS packer exactly.
    function test_proofArgsMatchJsPacker() public view {
        uint256[5] memory proof;
        uint256[] memory p = vm.parseJsonUintArray(json, ".inputs.proof");
        for (uint256 i; i < 5; ++i) {
            proof[i] = p[i];
        }

        bytes memory fromSolidity = WorldIdGuardArgsBuilder.buildProof(
            vm.parseJsonUint(json, ".inputs.nullifier"),
            vm.parseJsonUint(json, ".inputs.nonce"),
            uint64(vm.parseJsonUint(json, ".inputs.expiresAtMin")),
            proof,
            vm.parseJsonString(json, ".inputs.action")
        );

        assertEq(fromSolidity, vm.parseJsonBytes(json, ".proofArgs"), "taker proof layout diverged from the frontend");
        assertEq(
            fromSolidity.length,
            WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH + bytes(vm.parseJsonString(json, ".inputs.action")).length,
            "unexpected length"
        );
    }

    function test_policyMatchesJsPacker() public view {
        bytes memory fromSolidity = WorldIdGuardArgsBuilder.buildPolicy(
            uint64(vm.parseJsonUint(json, ".inputs.issuerSchemaId")),
            vm.parseJsonUint(json, ".inputs.credentialGenesisIssuedAtMin")
        );

        assertEq(fromSolidity, vm.parseJsonBytes(json, ".policy"), "policy layout diverged");
        assertEq(fromSolidity.length, WorldIdGuardArgsBuilder.POLICY_LENGTH, "unexpected length");
    }

    function test_policyWithPCMatchesJsPacker() public view {
        bytes memory fromSolidity = WorldIdGuardArgsBuilder.buildPolicyWithPC(
            uint16(vm.parseJsonUint(json, ".inputs.jumpPC")),
            uint64(vm.parseJsonUint(json, ".inputs.issuerSchemaId")),
            vm.parseJsonUint(json, ".inputs.credentialGenesisIssuedAtMin")
        );

        assertEq(fromSolidity, vm.parseJsonBytes(json, ".policyWithPC"), "policy-with-PC layout diverged");
        assertEq(fromSolidity.length, WorldIdGuardArgsBuilder.POLICY_WITH_PC_LENGTH, "unexpected length");
    }

    /// @notice The packed payload round-trips through the contract's parser.
    /// @dev Agreement on *length* is not agreement on *field order*. Two packers
    /// can produce 232 bytes and disagree about which 32 of them are the nonce.
    /// This parses the frontend's own output and checks each field lands where
    /// the guard will look for it.
    function test_frontendPayloadParsesIntoTheRightFields() public view {
        bytes memory packed = vm.parseJsonBytes(json, ".proofArgs");

        (uint256 nullifier, uint256 nonce, uint64 expiresAtMin, uint256[5] memory proof) = this.parse(packed);

        assertEq(nullifier, vm.parseJsonUint(json, ".inputs.nullifier"), "nullifier misplaced");
        assertEq(nonce, vm.parseJsonUint(json, ".inputs.nonce"), "nonce misplaced");
        assertEq(expiresAtMin, uint64(vm.parseJsonUint(json, ".inputs.expiresAtMin")), "expiresAtMin misplaced");

        uint256[] memory expected = vm.parseJsonUintArray(json, ".inputs.proof");
        for (uint256 i; i < 5; ++i) {
            assertEq(proof[i], expected[i], string.concat("proof[", vm.toString(i), "] misplaced"));
        }
    }

    /// @dev `parseProof` takes `bytes calldata`, so it needs an external hop.
    function parse(bytes calldata packed)
        external
        pure
        returns (uint256, uint256, uint64, uint256[5] memory)
    {
        return WorldIdGuardArgsBuilder.parseProof(packed);
    }
}
