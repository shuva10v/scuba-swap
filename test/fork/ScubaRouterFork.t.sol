// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { FeeArgsBuilder } from "@1inch/swap-vm/src/instructions/Fee.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { SCUBA_OP_ONLY_HUMAN_TAKER } from "../../src/opcodes/ScubaOpcodes.sol";

import { RouterConformance } from "./RouterConformance.t.sol";

/// @title ScubaRouterForkTest
/// @notice Phase 2 gate: `ScubaSwapVMRouter` is a strict superset of the stock
/// router — it dispatches a third-party opcode without disturbing any stock one.
///
/// @dev Inherits the entire `RouterConformance` suite, so every Phase 1
/// assertion is re-run here against our router. The tests below add only what
/// is specific to the extension itself.
///
/// The instruction at 0x27 is still `Passthrough._noop` at this phase. That is
/// the point: this file must pass *before* World ID enters the picture, so a
/// Phase 3 failure can only be about World ID.
contract ScubaRouterForkTest is RouterConformance {
    using ProgramBuilder for Program;

    ScubaSwapVMRouter internal router;

    function setUp() public override {
        super.setUp();
        router = new ScubaSwapVMRouter(AQUA, WETH, owner, "ScubaSwapVM", "1");
    }

    function _router() internal view override returns (SwapVM) {
        return SwapVM(payable(address(router)));
    }

    // ===== The extension itself =====

    /// @notice A program containing our opcode executes end to end.
    /// @dev The stock `AquaSwapVMRouter` would revert `UnknownOpcode(0x27)` on
    /// this exact program — asserted in `test_stockRouterRejectsScubaOpcode`.
    function test_scubaOpcodeDispatches() public {
        ISwapVM.Order memory order = _createOrder(_guardedProgram(101));
        _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        address dave = makeAddr("dave");
        uint256 amountIn = 10_000e6;
        _fundTaker(dave, USDC, amountIn);

        bytes memory td = _takerData(dave, true, true, "");

        vm.prank(dave);
        (uint256 sIn, uint256 sOut,) = _router().swap(order, amountIn, td);

        assertEq(sIn, amountIn, "guarded program should still consume full input");
        assertGt(sOut, 0, "guarded program produced no output");
    }

    /// @notice The guard opcode is inert: a guarded program and an unguarded one
    /// over identical balances quote identically.
    /// @dev At Phase 2 the guard is a no-op, so *any* difference would mean our
    /// dispatch is corrupting the VM context — reading taker args it should not
    /// touch, or moving the program counter.
    function test_scubaOpcodeDoesNotPerturbAmounts() public {
        ISwapVM.Order memory guarded = _createOrder(_guardedProgram(102));
        ISwapVM.Order memory plain = _createOrder(_openProgram(103));
        _ship(_router(), guarded, SHIP_USDC, SHIP_WETH);
        _ship(_router(), plain, SHIP_USDC, SHIP_WETH);

        address erin = makeAddr("erin");
        uint256 amountIn = 10_000e6;
        bytes memory td = _takerData(erin, true, true, "");

        (, uint256 outGuarded,) = _router().asView().quote(guarded, amountIn, td);
        (, uint256 outPlain,) = _router().asView().quote(plain, amountIn, td);

        assertEq(outGuarded, outPlain, "no-op guard changed the swap result");
    }

    /// @notice The stock router rejects our opcode.
    /// @dev Confirms 0x27 really is unallocated upstream — the flip side of the
    /// `Toolchain` assertion, checked at runtime rather than at compile time.
    function test_stockRouterRejectsScubaOpcode() public {
        SwapVM stock = SwapVM(payable(address(new AquaSwapVMRouter(AQUA, WETH, owner, "SwapVM", "1.0.0"))));

        ISwapVM.Order memory order = _createOrder(_guardedProgram(104));
        _ship(stock, order, SHIP_USDC, SHIP_WETH);

        address frank = makeAddr("frank");
        bytes memory td = _takerData(frank, true, true, "");

        // asView() is itself an external call, so it must be resolved BEFORE
        // expectRevert — otherwise the cheatcode binds to asView() instead of
        // quote() and the test passes vacuously.
        ISwapVM stockView = stock.asView();
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, SCUBA_OP_ONLY_HUMAN_TAKER));
        stockView.quote(order, 10_000e6, td);
    }

    /// @notice Unknown opcodes still revert on our router.
    /// @dev Extension must be additive, not permissive: claiming 0x27 must not
    /// turn the dispatcher into a catch-all that silently ignores garbage.
    function test_unknownOpcodeStillReverts() public {
        // 0x28 — adjacent to ours, deliberately not claimed.
        bytes memory program = abi.encodePacked(hex"2800", hex"5000", hex"02", uint8(32), bytes32(uint256(105)));
        ISwapVM.Order memory order = _createOrder(program);
        _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        address grace = makeAddr("grace");
        bytes memory td = _takerData(grace, true, true, "");

        ISwapVM routerView = _router().asView();
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, 0x28));
        routerView.quote(order, 10_000e6, td);
    }

    // ===== helpers =====

    /// @notice Program A with the identity guard in front of the fee and swap.
    /// @dev Guard-first is the ordering rule from README §2: a rejected taker
    /// must never reach fee or curve math. It also keeps the guard outside the
    /// nested `runLoop` that `FlatFeeAmountIn` opens — see FRICTION F-12.
    function _guardedProgram(uint256 salt) internal pure returns (bytes memory) {
        Program p;
        return bytes.concat(
            abi.encodePacked(uint8(SCUBA_OP_ONLY_HUMAN_TAKER), uint8(0)),
            p.build(Opcode.FlatFeeAmountIn, FeeArgsBuilder.buildFlatFee(OPEN_FEE)),
            p.build(Opcode.XYCSwap),
            p.build(Opcode.Salt, abi.encodePacked(salt))
        );
    }
}
