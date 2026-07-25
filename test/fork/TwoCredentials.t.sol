// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";
import { WorldIdGuard, WorldIdGuardArgsBuilder } from "../../src/instructions/WorldIdGuard.sol";
import { ByteHasher } from "../../src/helpers/ByteHasher.sol";
import { SCUBA_OP_ONLY_HUMAN_TAKER } from "../../src/opcodes/ScubaOpcodes.sol";
import { MockWorldIDVerifier } from "../mocks/MockWorldIDVerifier.sol";
import { WorldChainForkBase } from "./WorldChainForkBase.t.sol";

/// @notice Can a taker satisfy TWO credentials today, with no contract change?
///
/// @dev SwapVM programs are composable and `tryChopTakerArgs` advances a cursor, so two
/// guard instructions in one program should consume two proof payloads in sequence. This
/// establishes whether the bitmap is needed for composability at all, or only for doing it
/// in one World App round trip.
contract TwoCredentialsTest is WorldChainForkBase {
    using ByteHasher for bytes;

    string internal constant ACTION = "world-demo-v2";
    uint64 internal constant RP_ID = 3_180_554_207_396_540_622;
    uint64 internal constant SCHEMA_PASSPORT = 9303;
    uint32 internal constant DEEP_FEE = 100_000; // 0.01%

    MockWorldIDVerifier internal verifier;
    ScubaSwapVMRouter internal router;
    address internal human = makeAddr("human");

    function setUp() public override {
        super.setUp();
        verifier = new MockWorldIDVerifier();
        router = new ScubaSwapVMRouter(
            address(aqua), WETH, owner, "ScubaSwapVM", "1", IWorldIDVerifier(address(verifier)), ACTION, RP_ID
        );
    }

    /// @dev Two guards, human then passport, each naming its own schema in program args.
    function _twoCredentialProgram(uint256 salt) private pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(SCUBA_OP_ONLY_HUMAN_TAKER),
            uint8(WorldIdGuardArgsBuilder.POLICY_LENGTH),
            WorldIdGuardArgsBuilder.buildPolicy(SCHEMA_PROOF_OF_HUMAN, 0),
            uint8(SCUBA_OP_ONLY_HUMAN_TAKER),
            uint8(WorldIdGuardArgsBuilder.POLICY_LENGTH),
            WorldIdGuardArgsBuilder.buildPolicy(SCHEMA_PASSPORT, 0),
            hex"70", uint8(4), DEEP_FEE, hex"5000", hex"02", uint8(32), bytes32(salt)
        );
    }

    /// @notice TWO SEPARATE REQUESTS (distinct nonces) — should work.
    function test_twoCredentialsFromSeparateRequests() public {
        ISwapVM.Order memory order = _createOrder(_twoCredentialProgram(1));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        uint64 exp = uint64(block.timestamp + 300);
        bytes memory a = _proof(human, 111, 1001, exp, SCHEMA_PROOF_OF_HUMAN, "world-demo-v2-a");
        bytes memory b = _proof(human, 111, 1002, exp, SCHEMA_PASSPORT, "world-demo-v2-b");

        vm.prank(human);
        (, uint256 out,) = router.swap(order, 10_000e6, _takerData(human, true, false, abi.encodePacked(a, b)));
        assertGt(out, 0, "two credentials from two requests should satisfy two guards");
    }

    /// @notice ONE request — both credentials share nullifier AND nonce, as measured on the
    /// live verifier. The spent set keys on (nullifier, nonce), so the second guard sees the
    /// first guard's entry and rejects.
    function test_twoCredentialsFromOneRequestCollideOnTheSpentSet() public {
        ISwapVM.Order memory order = _createOrder(_twoCredentialProgram(2));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        uint64 exp = uint64(block.timestamp + 300);
        // Same nullifier, same nonce, same action — one multi-credential request.
        bytes memory a = _proof(human, 222, 2001, exp, SCHEMA_PROOF_OF_HUMAN, ACTION);
        bytes memory b = _proof(human, 222, 2001, exp, SCHEMA_PASSPORT, ACTION);

        vm.prank(human);
        vm.expectRevert(abi.encodeWithSelector(WorldIdGuard.WorldIdProofAlreadySpent.selector, 222, 2001));
        router.swap(order, 10_000e6, _takerData(human, true, false, abi.encodePacked(a, b)));
    }

    /// @notice Program D charges less than the human tier, which is the point of demanding a
    /// second credential — a deeper gate has to buy something.
    function test_bothCredentialsPriceBetterThanTheHumanTier() public {
        uint256 amountIn = 10_000e6;
        uint64 exp = uint64(block.timestamp + 300);

        ISwapVM.Order memory deep = _createOrder(_twoCredentialProgram(7));
        _shipDefault(SwapVM(payable(address(router))), deep);
        _fundTaker(address(router), human, USDC, amountIn);
        bytes memory a = _proof(human, 701, 7001, exp, SCHEMA_PROOF_OF_HUMAN, "world-demo-v2-a");
        bytes memory b = _proof(human, 701, 7002, exp, SCHEMA_PASSPORT, "world-demo-v2-b");
        uint256 snap = vm.snapshotState();
        vm.prank(human);
        (, uint256 deepOut,) = router.swap(deep, amountIn, _takerData(human, true, false, abi.encodePacked(a, b)));
        vm.revertToState(snap);

        // Same balance shape, one credential, the human fee.
        ISwapVM.Order memory tier = _createOrder(_humanOnlyProgram(8));
        _shipDefault(SwapVM(payable(address(router))), tier);
        _fundTaker(address(router), human, USDC, amountIn);
        bytes memory c = _proof(human, 801, 8001, exp, SCHEMA_PROOF_OF_HUMAN, "world-demo-v2-c");
        vm.prank(human);
        (, uint256 tierOut,) = router.swap(tier, amountIn, _takerData(human, true, false, c));

        assertGt(deepOut, tierOut, "two credentials must price better than one");
    }

    /// @notice A human proof alone cannot open program D. The second guard has nothing left to
    /// chop, so it fails loudly rather than treating an absent proof as a payload (F-04).
    function test_humanProofAloneCannotOpenProgramD() public {
        ISwapVM.Order memory order = _createOrder(_twoCredentialProgram(9));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        bytes memory only = _proof(human, 901, 9001, uint64(block.timestamp + 300), SCHEMA_PROOF_OF_HUMAN, ACTION);
        vm.prank(human);
        vm.expectRevert(
            abi.encodeWithSelector(
                WorldIdGuard.WorldIdProofMissing.selector, 0, WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH
            )
        );
        router.swap(order, 10_000e6, _takerData(human, true, false, only));
    }

    /// @notice Two human proofs do not satisfy a human+passport program. The second guard
    /// names schema 9303, and the mock keys on the full public-input tuple, so a proof issued
    /// for schema 1 cannot pass it.
    function test_twoHumanProofsDoNotSatisfyPassport() public {
        ISwapVM.Order memory order = _createOrder(_twoCredentialProgram(10));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        uint64 exp = uint64(block.timestamp + 300);
        bytes memory a = _proof(human, 1001, 10_001, exp, SCHEMA_PROOF_OF_HUMAN, "world-demo-v2-a");
        bytes memory b = _proof(human, 1001, 10_002, exp, SCHEMA_PROOF_OF_HUMAN, "world-demo-v2-b");

        vm.prank(human);
        vm.expectRevert(); // the mock rejects a schema mismatch exactly as the real verifier would
        router.swap(order, 10_000e6, _takerData(human, true, false, abi.encodePacked(a, b)));
    }

    function _proof(
        address taker,
        uint256 nullifier,
        uint256 nonce,
        uint64 expiresAtMin,
        uint64 schema,
        string memory action
    ) private returns (bytes memory) {
        uint256[5] memory zk = [uint256(1), 2, 3, 4, uint256(schema)];
        verifier.accept(
            nullifier, bytes(action).hashToField(), RP_ID, nonce,
            abi.encodePacked(taker).hashToField(), expiresAtMin, schema, 0, zk
        );
        return WorldIdGuardArgsBuilder.buildProof(nullifier, nonce, expiresAtMin, zk, action);
    }
}
