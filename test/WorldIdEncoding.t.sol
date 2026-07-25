// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { ByteHasher } from "../src/helpers/ByteHasher.sol";

/// @title WorldIdEncodingTest
/// @notice Pins ScubaSwap's on-chain hashing against values produced *outside*
/// Solidity, so a cross-system encoding disagreement fails here rather than as
/// an opaque `ProofInvalid()` at demo time.
///
/// @dev This is the one bug class a mock verifier can never catch. A
/// `MockWorldIDVerifier` accepts whatever we hand it, so it happily confirms a
/// guard that computes `signalHash` in a way IDKit never would. Every expected
/// value below therefore comes from an independent source — either World ID's
/// own published constants or the IDKit `hashSignal` algorithm — never from
/// running this contract and pasting the answer back in.
contract WorldIdEncodingTest is Test {
    using ByteHasher for bytes;

    /// @dev World ID publishes this as the default `signal_hash` for an empty
    /// signal. It is the strongest vector available: an official constant, and
    /// it can only match if `hashToField` is exactly `keccak256 >> 8`.
    uint256 internal constant DOCS_EMPTY_SIGNAL_HASH =
        0x00c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a4;

    // Vectors computed independently of Solidity, from the IDKit `hashSignal`
    // algorithm in idkit-core's hashing.js.
    address internal constant VECTOR_ADDR = 0x1234567890AbcdEF1234567890aBcdef12345678;
    uint256 internal constant VECTOR_ADDR_RAW20 =
        0x005f6174255b44b7ca652c5289d2546de65e4394eb6aa52a40045e01237736d0;
    uint256 internal constant VECTOR_ADDR_ASCII42 =
        0x00955c7192937b6b2bfea66043884b5444eb79840d193d03ce4d9588b3e6ccdc;

    /// @dev hashToField("world-demo-v2") — the value that actually verified
    /// against both live WorldIDVerifier proxies on World Chain.
    uint256 internal constant VECTOR_ACTION_WORLD_DEMO_V2 =
        0x00398153eb6b625bf04bb424b6d37400d99bccc0cc2e777d9c736de1609ef3dd;

    // ===== hashToField itself =====

    /// @notice `hashToField` is exactly `keccak256 >> 8`, per an official vector.
    function test_hashToFieldMatchesWorldIdPublishedConstant() public pure {
        assertEq(bytes("").hashToField(), DOCS_EMPTY_SIGNAL_HASH, "hashToField is not keccak256 >> 8");
    }

    /// @notice Output always fits BN254's scalar field.
    /// @dev The shift is what makes this true, and skipping it is precisely the
    /// documented-but-wrong `action` mapping that reverts `InvalidAction()`.
    function testFuzz_hashToFieldAlwaysFitsTheScalarField(bytes memory value) public pure {
        uint256 BN254_SCALAR_FIELD = 21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;
        assertLt(value.hashToField(), BN254_SCALAR_FIELD, "hashToField escaped the field");
    }

    /// @notice A raw keccak256 does NOT reliably fit the field.
    /// @dev Concretely why FRICTION W-05 exists: this is the exact value the
    /// docs tell you to pass as `action`, and it is larger than the modulus.
    function test_rawKeccakOverflowsTheFieldForOurAction() public pure {
        uint256 BN254_SCALAR_FIELD = 21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;
        uint256 raw = uint256(keccak256(bytes("world-demo-v2")));

        assertGt(raw, BN254_SCALAR_FIELD, "vector no longer demonstrates the overflow");
        assertLt(raw >> 8, BN254_SCALAR_FIELD, "shifted value should fit");
    }

    // ===== signal: agreement with IDKit's hashSignal =====

    /// @notice `abi.encodePacked(address)` matches IDKit's hex-decode branch.
    /// @dev IDKit's `hashSignal` sees a signal starting with `0x` whose tail is
    /// valid hex, so it hex-decodes to the raw 20 address bytes before hashing.
    /// Solidity's `abi.encodePacked(address)` is those same 20 bytes, which is
    /// why both sides agree.
    function test_signalHashMatchesIdkitHexDecodeBranch() public pure {
        assertEq(abi.encodePacked(VECTOR_ADDR).hashToField(), VECTOR_ADDR_RAW20, "signal encoding diverged from IDKit");
    }

    /// @notice The UTF-8 branch produces a completely different value.
    /// @dev IDKit picks its branch by inspecting the signal at runtime: a `0x`
    /// hex string is decoded to bytes, anything else is UTF-8 encoded. Pass an
    /// address as a non-`0x` string and you silently hash 42 ASCII characters
    /// instead of 20 bytes. Nothing on either side would flag it — the proof
    /// simply fails to verify with no indication why. Asserting the two differ
    /// keeps that trap documented in executable form.
    function test_idkitUtf8BranchIsNotInterchangeable() public pure {
        uint256 ascii42 = bytes("0x1234567890AbcdEF1234567890aBcdef12345678").hashToField();

        assertEq(ascii42, VECTOR_ADDR_ASCII42, "ascii vector drifted");
        assertTrue(ascii42 != VECTOR_ADDR_RAW20, "branches must not collide");
    }

    // ===== action =====

    /// @notice The action encoding that verified on-chain.
    /// @dev Guards the fix from FRICTION W-05 / worldcoin/developer-docs#147.
    function test_actionHashMatchesTheValueThatVerifiedOnChain() public pure {
        assertEq(
            bytes("world-demo-v2").hashToField(),
            VECTOR_ACTION_WORLD_DEMO_V2,
            "action encoding diverged from the proven-good value"
        );
    }

    /// @notice Distinct actions give distinct field elements.
    function test_actionHashIsActionSpecific() public pure {
        assertTrue(
            bytes("world-demo-v2").hashToField() != bytes("world-demo").hashToField(), "action hash is not action-specific"
        );
    }
}
