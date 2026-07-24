// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title Passthrough
/// @notice Phase 2 scaffolding: an instruction that does nothing at all.
///
/// @dev Its only job is to isolate one question — *does a third-party opcode
/// dispatch correctly through our router?* — from the much noisier question of
/// whether World ID verification works. If a Phase 2 test fails, the extension
/// mechanism or the program encoding is wrong, and nothing else can be blamed.
///
/// Phase 3 replaces this with `WorldIdGuard` at the same opcode slot (0x27).
/// It is intentionally not a stubbed-out guard that "always passes": a no-op
/// named `_noop` cannot be mistaken for a security check left switched on.
abstract contract Passthrough {
    /// @notice Consumes no arguments, reads no state, changes nothing.
    /// @dev `internal pure` and unnamed parameters keep this free of any side
    /// effect the VM could observe, in both static and non-static context.
    function _noop(Context memory, /* ctx */ bytes calldata /* args */ ) internal pure { }
}
