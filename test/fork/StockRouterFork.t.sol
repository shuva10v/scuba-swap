// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import { ForkBase } from "./ForkBase.t.sol";

/// @title StockRouterForkTest
/// @notice Phase 1 gate: a real swap of real mainnet USDC/WETH through the
/// *stock* `AquaSwapVMRouter`, with zero ScubaSwap code involved.
///
/// The point is to prove the Aqua plumbing — ship, safeBalances, pull, push,
/// order-hash agreement — before any custom instruction exists. When Phase 2's
/// `ScubaSwapVMRouter` lands, these same assertions get re-run against it; any
/// divergence is then unambiguously our fault.
contract StockRouterForkTest is ForkBase {
    AquaSwapVMRouter internal router;

    uint256 internal constant SHIP_USDC = 1_000_000e6;
    uint256 internal constant SHIP_WETH = 250e18;

    function setUp() public override {
        super.setUp();
        router = new AquaSwapVMRouter(AQUA, WETH, owner, "SwapVM", "1.0.0");
    }

    function _router() internal view override returns (SwapVM) {
        return SwapVM(payable(address(router)));
    }

    // ===== Plumbing =====

    function test_shipBindsLiquidityToRouter() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(1));
        bytes32 strategyHash = _ship(router, order, SHIP_USDC, SHIP_WETH);

        (uint256 balA, uint256 balB) = aqua.safeBalances(maker, address(router), strategyHash, TOKEN_A, TOKEN_B);
        assertEq(balA, SHIP_USDC, "USDC not shipped");
        assertEq(balB, SHIP_WETH, "WETH not shipped");

        // Aqua is a registry, not a vault: the tokens never leave the maker.
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "maker USDC should not move on ship");
        assertEq(IERC20(WETH).balanceOf(maker), MAKER_WETH, "maker WETH should not move on ship");
        assertEq(IERC20(USDC).balanceOf(AQUA), 0, "Aqua should custody nothing");
    }

    // ===== The actual swap =====

    /// @notice Exact-in USDC -> WETH through shared Aqua liquidity.
    function test_swapExactInUsdcForWeth() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(2));
        bytes32 strategyHash = _ship(router, order, SHIP_USDC, SHIP_WETH);

        address alice = makeAddr("alice");
        uint256 amountIn = 10_000e6;
        _fundTaker(alice, USDC, amountIn);

        bytes memory td = _takerData(alice, true, true, "");

        // Quote first — this is a genuine staticcall via asView().
        (uint256 qIn, uint256 qOut,) = router.asView().quote(order, amountIn, td);
        assertEq(qIn, amountIn, "exact-in quote must consume the full input");
        assertGt(qOut, 0, "quote returned nothing");

        uint256 makerWethBefore = IERC20(WETH).balanceOf(maker);

        vm.prank(alice);
        (uint256 sIn, uint256 sOut,) = router.swap(order, amountIn, td);

        // The invariant that matters most for Phase 3: quote must equal swap.
        assertEq(sIn, qIn, "swap amountIn diverged from quote");
        assertEq(sOut, qOut, "swap amountOut diverged from quote");

        assertEq(IERC20(USDC).balanceOf(alice), 0, "taker USDC not spent");
        assertEq(IERC20(WETH).balanceOf(alice), sOut, "taker did not receive WETH");
        assertEq(makerWethBefore - IERC20(WETH).balanceOf(maker), sOut, "maker WETH did not move");

        // Aqua balances track the trade: tokenIn up, tokenOut down.
        (uint256 balA, uint256 balB) = aqua.safeBalances(maker, address(router), strategyHash, TOKEN_A, TOKEN_B);
        assertEq(balA, SHIP_USDC + sIn, "Aqua USDC balance did not grow by amountIn");
        assertEq(balB, SHIP_WETH - sOut, "Aqua WETH balance did not shrink by amountOut");
    }

    /// @notice Same trade in the other direction, to prove token ordering and
    /// the 6dp/18dp mismatch are handled.
    function test_swapExactInWethForUsdc() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(3));
        _ship(router, order, SHIP_USDC, SHIP_WETH);

        address bob = makeAddr("bob");
        uint256 amountIn = 5e18;
        _fundTaker(bob, WETH, amountIn);

        bytes memory td = _takerData(bob, true, false, "");

        vm.prank(bob);
        (uint256 sIn, uint256 sOut,) = router.swap(order, amountIn, td);

        assertEq(sIn, amountIn, "exact-in should consume full WETH input");
        assertGt(sOut, 0, "no USDC received");
        assertEq(IERC20(USDC).balanceOf(bob), sOut, "taker USDC balance mismatch");
    }

    /// @notice The 0.30% fee is actually charged.
    /// @dev Compared against a fee-free program over identical shipped balances,
    /// so the curve cancels out and only the fee remains.
    function test_openTierChargesThirtyBps() public {
        ISwapVM.Order memory withFee = _createOrder(_openProgram(4));
        ISwapVM.Order memory noFee = _createOrder(_noFeeProgram(5));
        _ship(router, withFee, SHIP_USDC, SHIP_WETH);
        _ship(router, noFee, SHIP_USDC, SHIP_WETH);

        address carol = makeAddr("carol");
        uint256 amountIn = 10_000e6;
        bytes memory td = _takerData(carol, true, true, "");

        (,uint256 outWithFee,) = router.asView().quote(withFee, amountIn, td);
        (,uint256 outNoFee,) = router.asView().quote(noFee, amountIn, td);

        assertLt(outWithFee, outNoFee, "fee program must return less");

        // Fee is charged on the input leg, so output scales by roughly (1 - fee).
        // Denominator is 1e9, NOT 10_000 — see FRICTION F-11.
        //
        // Only "roughly": xy=k is convex, so shrinking the input by 0.30% moves
        // the output by slightly less than 0.30% (measured ~0.003% off linear).
        // The 0.01% band absorbs that curvature while still being ~100x tighter
        // than the error a wrong fee scale would produce.
        uint256 expected = (outNoFee * (FEE_DENOMINATOR - OPEN_FEE)) / FEE_DENOMINATOR;
        assertApproxEqRel(outWithFee, expected, 1e14, "flat fee is not 0.30%");
    }

    /// @notice Two strategies, same maker, same tokens, one wallet balance.
    /// @dev This is the Aqua property ScubaSwap is built on: programs A/B/C in
    /// Phase 4 all draw on the same capital.
    function test_twoStrategiesShareTheSameMakerWallet() public {
        ISwapVM.Order memory first = _createOrder(_openProgram(6));
        ISwapVM.Order memory second = _createOrder(_openProgram(7));

        bytes32 hash1 = _ship(router, first, SHIP_USDC, SHIP_WETH);
        bytes32 hash2 = _ship(router, second, SHIP_USDC, SHIP_WETH);

        assertTrue(hash1 != hash2, "distinct programs must have distinct hashes");

        // Both strategies report full balances while the maker holds one balance.
        (uint256 a1,) = aqua.safeBalances(maker, address(router), hash1, TOKEN_A, TOKEN_B);
        (uint256 a2,) = aqua.safeBalances(maker, address(router), hash2, TOKEN_A, TOKEN_B);
        assertEq(a1, SHIP_USDC, "strategy 1 balance");
        assertEq(a2, SHIP_USDC, "strategy 2 balance");
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "maker wallet unchanged by either ship");
    }

    // ===== helpers =====

    function _noFeeProgram(uint256 salt) internal pure returns (bytes memory) {
        // `_openProgram` minus the fee instruction; built inline to keep the
        // fee comparison above honest about what differs.
        return abi.encodePacked(hex"5000", hex"02", uint8(32), bytes32(salt));
    }
}
