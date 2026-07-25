// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { SCUBA_OP_ONLY_HUMAN_TAKER } from "../../src/opcodes/ScubaOpcodes.sol";

import { MockWorldIDVerifier } from "../mocks/MockWorldIDVerifier.sol";
import { RouterConformance } from "./RouterConformance.t.sol";

/// @title ScubaRouterForkTest
/// @notice Proves `ScubaSwapVMRouter` is a strict superset of the stock router:
/// it adds instructions without disturbing any stock one.
///
/// @dev Runs on an **Ethereum mainnet** fork against the *canonical* Aqua
/// registry, precisely because that is where Aqua is real. World ID is not
/// exercised here — the guard's behaviour lives in the World Chain suite, which
/// is where a v4 verifier actually exists (FRICTION W-07).
///
/// Inherits the whole `RouterConformance` suite, so every assertion that passes
/// against 1inch's untouched `AquaSwapVMRouter` is re-run against ours.
contract ScubaRouterForkTest is RouterConformance {
    ScubaSwapVMRouter internal router;

    function setUp() public override {
        super.setUp();
        router = new ScubaSwapVMRouter(
            AQUA, WETH, owner, "ScubaSwapVM", "1", new MockWorldIDVerifier(), "scubaswap-test", 1
        );
    }

    function _router() internal view override returns (SwapVM) {
        return SwapVM(payable(address(router)));
    }

    // ===== opcode space =====

    /// @notice The stock router rejects our opcode.
    /// @dev Confirms 0x27 really is unallocated upstream — the runtime flip side
    /// of the compile-time assertion in `test/Toolchain.t.sol`.
    function test_stockRouterRejectsScubaOpcode() public {
        SwapVM stock = SwapVM(payable(address(new AquaSwapVMRouter(AQUA, WETH, owner, "SwapVM", "1.0.0"))));

        ISwapVM.Order memory order = _createOrder(_guardedProgramShell(104));
        _ship(stock, order, SHIP_USDC, SHIP_WETH);

        bytes memory td = _takerData(makeAddr("frank"), true, true, "");

        // asView() is itself an external call, so it must be resolved BEFORE
        // expectRevert — otherwise the cheatcode binds to asView() instead of
        // quote() and the test passes vacuously. FRICTION F-13.
        ISwapVM stockView = stock.asView();
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, SCUBA_OP_ONLY_HUMAN_TAKER));
        stockView.quote(order, 10_000e6, td);
    }

    /// @notice Unknown opcodes still revert on our router.
    /// @dev Extension must be additive, not permissive: claiming 0x27 and 0x33
    /// must not turn the dispatcher into a catch-all that ignores garbage.
    function test_unknownOpcodeStillReverts() public {
        // 0x28 — adjacent to ours, deliberately not claimed.
        bytes memory program = abi.encodePacked(hex"2800", hex"5000", hex"02", uint8(32), bytes32(uint256(105)));
        ISwapVM.Order memory order = _createOrder(program);
        _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        bytes memory td = _takerData(makeAddr("grace"), true, true, "");

        ISwapVM routerView = _router().asView();
        vm.expectRevert(abi.encodeWithSelector(AquaOpcodes.UnknownOpcode.selector, 0x28));
        routerView.quote(order, 10_000e6, td);
    }

    // ===== helpers =====

    /// @dev A program carrying opcode 0x27 with a well-formed 40-byte policy.
    /// Used only to prove the *stock* router rejects the opcode; it is never
    /// executed successfully here, so the policy contents are irrelevant.
    function _guardedProgramShell(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(SCUBA_OP_ONLY_HUMAN_TAKER),
            uint8(40),
            uint64(1),
            uint256(0),
            hex"5000",
            hex"02",
            uint8(32),
            bytes32(salt)
        );
    }
}
