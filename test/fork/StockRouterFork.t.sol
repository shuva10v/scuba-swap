// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import { RouterConformance } from "./RouterConformance.t.sol";

/// @title StockRouterForkTest
/// @notice Phase 1 gate: the conformance suite against 1inch's *stock*
/// `AquaSwapVMRouter`, with zero ScubaSwap code in the call path.
///
/// @dev This is the control. It proves the Aqua plumbing — ship, safeBalances,
/// pull/push, order-hash agreement — works before any custom instruction
/// exists, so that when `ScubaRouterForkTest` runs the same assertions, any
/// divergence is unambiguously ours.
contract StockRouterForkTest is RouterConformance {
    AquaSwapVMRouter internal router;

    function setUp() public override {
        super.setUp();
        router = new AquaSwapVMRouter(AQUA, WETH, owner, "SwapVM", "1.0.0");
    }

    function _router() internal view override returns (SwapVM) {
        return SwapVM(payable(address(router)));
    }
}
