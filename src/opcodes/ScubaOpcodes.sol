// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { AquaOpcodes } from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";

import { WorldIdGuard } from "../instructions/WorldIdGuard.sol";
import { IWorldIDVerifier } from "../interfaces/IWorldIDVerifier.sol";

// Opcode slots ScubaSwap claims in the SwapVM opcode space.
//
// Both live in the `0x20-0x3f` "conditions & access guards" bank, taking the
// next free `_Ix` slots as `src/libs/OpcodeList.sol` instructs:
//   0x27 — next free in the guards sub-bank (0x20-0x2f), alongside
//          OnlyTakerTokenBalanceGte (0x24) and PrivateOrder (0x2b)
//   0x33 — next free in the conditional-jump sub-bank (0x30-0x3f), alongside
//          JumpIfTokenIn (0x31) and JumpIfTokenOut (0x32)
//
// These are third-party allocations in a space 1inch controls. If upstream ever
// fills either slot, deployed ScubaSwap programs would silently change meaning.
// `test/Toolchain.t.sol` asserts both are still `_27`/`_33` upstream and is the
// alarm for exactly that. See FRICTION F-02.
uint256 constant SCUBA_OP_ONLY_HUMAN_TAKER = 0x27;
uint256 constant SCUBA_OP_JUMP_IF_HUMAN = 0x33;

/// @title ScubaOpcodes
/// @notice The stock Aqua instruction set plus ScubaSwap's World ID guards.
/// @dev Extension is additive by construction: we handle only our own opcodes
/// and delegate everything else to `super`, so every stock opcode keeps its
/// number, its arguments and its behaviour. Aqua and SwapVM are never modified.
abstract contract ScubaOpcodes is AquaOpcodes, WorldIdGuard {
    constructor(address aqua, IWorldIDVerifier verifier, string memory actionPrefix, uint64 rpId)
        AquaOpcodes(aqua)
        WorldIdGuard(verifier, actionPrefix, rpId)
    { }

    /// @inheritdoc AquaOpcodes
    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal virtual override {
        if (opcode == SCUBA_OP_ONLY_HUMAN_TAKER) {
            WorldIdGuard._onlyHumanTaker(ctx, args);
        } else if (opcode == SCUBA_OP_JUMP_IF_HUMAN) {
            WorldIdGuard._jumpIfHumanTaker(ctx, args);
        } else {
            // Stock Aqua opcodes, untouched — including the UnknownOpcode revert.
            super._runOpcode(ctx, opcode, args);
        }
    }
}
