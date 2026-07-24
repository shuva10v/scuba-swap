// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";

import { ScubaOpcodes } from "../opcodes/ScubaOpcodes.sol";

/// @title ScubaSwapVMRouter
/// @notice A SwapVM router whose instruction set is the stock Aqua set plus
/// ScubaSwap's World ID identity guards.
///
/// @dev Deliberately a strict superset of the stock `AquaSwapVMRouter`: same
/// constructor shape, same `_dispatch`, same inheritance order
/// (`Simulator, SwapVM, <opcodes>`). Any program that runs on the stock router
/// runs here byte-for-byte identically — `test/fork/ScubaRouterFork.t.sol`
/// re-runs the entire Phase 1 suite against this contract to prove it.
///
/// Makers ship liquidity to this router through the canonical Aqua registry;
/// neither Aqua nor SwapVM is forked or modified.
contract ScubaSwapVMRouter is Simulator, SwapVM, ScubaOpcodes {
    /// @param aqua Canonical Aqua registry
    /// @param weth WETH, for unwrapping support
    /// @param owner Rescue-funds owner (see `Rescuable`)
    /// @param name EIP-712 domain name
    /// @param version EIP-712 domain version
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
        ScubaOpcodes(aqua)
    { }

    /// @dev Dispatches an opcode to its handler for VM execution
    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
