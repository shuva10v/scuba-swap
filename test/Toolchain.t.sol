// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

/// @notice Phase 0 gate: proves the dependency graph links and that the opcode
/// numbering we are about to build on is what we think it is.
/// @dev If this file stops compiling, the remappings are wrong — fix that before
/// debugging anything else.
contract ToolchainTest is Test {
    using ProgramBuilder for Program;

    function test_dependenciesLink() public {
        Aqua aqua = new Aqua();
        AquaSwapVMRouter router = new AquaSwapVMRouter(address(aqua), address(0), address(this), "SwapVM", "1.0.0");

        assertEq(address(router.AQUA()), address(aqua), "router must bind to Aqua");
    }

    /// @notice Locks the stock opcode bytes we depend on. Our instructions claim
    /// 0x27 and 0x33; if upstream ever fills those slots, this test is the alarm.
    function test_stockOpcodeNumbering() public pure {
        assertEq(uint256(Opcode.XYCSwap), 0x50, "XYCSwap moved");
        assertEq(uint256(Opcode.FlatFeeAmountIn), 0x70, "FlatFeeAmountIn moved");
        assertEq(uint256(Opcode.Jump), 0x03, "Jump moved");
        assertEq(uint256(Opcode.Salt), 0x02, "Salt moved");

        // Slots ScubaSwap intends to claim must still be unallocated upstream.
        assertEq(uint256(Opcode._27), 0x27, "0x27 no longer free");
        assertEq(uint256(Opcode._33), 0x33, "0x33 no longer free");
    }

    /// @notice Program encoding is `opcode || argsLength(1 byte) || args`.
    /// The 1-byte length is why proofs cannot live in program args (F-05).
    function test_programEncoding() public pure {
        Program p;
        bytes memory encoded = p.build(Opcode.XYCSwap);

        assertEq(encoded.length, 2, "bare instruction is opcode + zero length");
        assertEq(uint8(encoded[0]), 0x50, "opcode byte");
        assertEq(uint8(encoded[1]), 0x00, "args length byte");
    }
}
