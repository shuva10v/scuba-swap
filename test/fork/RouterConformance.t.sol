// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { ForkBase } from "./ForkBase.t.sol";

/// @title RouterConformance
/// @notice The behaviour every ScubaSwap-compatible router must exhibit, run
/// against real mainnet USDC/WETH and the canonical Aqua registry.
///
/// @dev Deliberately written against `_router()` rather than a concrete type.
/// `StockRouterForkTest` runs it against 1inch's untouched `AquaSwapVMRouter`;
/// `ScubaRouterForkTest` runs the identical assertions against ours. Matching
/// results are the proof that `ScubaSwapVMRouter` is a strict *superset* — it
/// adds instructions without perturbing any stock behaviour.
///
/// Every test ships its own strategy with a distinct salt, so the suite is
/// order-independent and no two tests collide on an order hash.
abstract contract RouterConformance is ForkBase {
    uint256 internal constant SHIP_USDC = 1_000_000e6;
    uint256 internal constant SHIP_WETH = 250e18;

    // ===== Plumbing =====

    function test_shipBindsLiquidityToRouter() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(1));
        bytes32 strategyHash = _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        (uint256 balA, uint256 balB) =
            aqua.safeBalances(maker, address(_router()), strategyHash, TOKEN_A, TOKEN_B);
        assertEq(balA, SHIP_USDC, "USDC not shipped");
        assertEq(balB, SHIP_WETH, "WETH not shipped");

        // Aqua is a registry, not a vault: the tokens never leave the maker.
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "maker USDC should not move on ship");
        assertEq(IERC20(WETH).balanceOf(maker), MAKER_WETH, "maker WETH should not move on ship");
        assertEq(IERC20(USDC).balanceOf(AQUA), 0, "Aqua should custody nothing");
    }

    // ===== Swaps =====

    /// @notice Exact-in USDC -> WETH through shared Aqua liquidity.
    function test_swapExactInUsdcForWeth() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(2));
        bytes32 strategyHash = _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        address alice = makeAddr("alice");
        uint256 amountIn = 10_000e6;
        _fundTaker(alice, USDC, amountIn);

        bytes memory td = _takerData(alice, true, true, "");

        // Quote first — a genuine staticcall via asView().
        (uint256 qIn, uint256 qOut,) = _router().asView().quote(order, amountIn, td);
        assertEq(qIn, amountIn, "exact-in quote must consume the full input");
        assertGt(qOut, 0, "quote returned nothing");

        uint256 makerWethBefore = IERC20(WETH).balanceOf(maker);

        vm.prank(alice);
        (uint256 sIn, uint256 sOut,) = _router().swap(order, amountIn, td);

        // The invariant that matters most once the guard lands in Phase 3.
        assertEq(sIn, qIn, "swap amountIn diverged from quote");
        assertEq(sOut, qOut, "swap amountOut diverged from quote");

        assertEq(IERC20(USDC).balanceOf(alice), 0, "taker USDC not spent");
        assertEq(IERC20(WETH).balanceOf(alice), sOut, "taker did not receive WETH");
        assertEq(makerWethBefore - IERC20(WETH).balanceOf(maker), sOut, "maker WETH did not move");

        // Aqua balances track the trade: tokenIn up, tokenOut down.
        (uint256 balA, uint256 balB) =
            aqua.safeBalances(maker, address(_router()), strategyHash, TOKEN_A, TOKEN_B);
        assertEq(balA, SHIP_USDC + sIn, "Aqua USDC balance did not grow by amountIn");
        assertEq(balB, SHIP_WETH - sOut, "Aqua WETH balance did not shrink by amountOut");
    }

    /// @notice Same trade the other way, proving token ordering and the
    /// 6dp/18dp mismatch are handled.
    function test_swapExactInWethForUsdc() public {
        ISwapVM.Order memory order = _createOrder(_openProgram(3));
        _ship(_router(), order, SHIP_USDC, SHIP_WETH);

        address bob = makeAddr("bob");
        uint256 amountIn = 5e18;
        _fundTaker(bob, WETH, amountIn);

        bytes memory td = _takerData(bob, true, false, "");

        vm.prank(bob);
        (uint256 sIn, uint256 sOut,) = _router().swap(order, amountIn, td);

        assertEq(sIn, amountIn, "exact-in should consume full WETH input");
        assertGt(sOut, 0, "no USDC received");
        assertEq(IERC20(USDC).balanceOf(bob), sOut, "taker USDC balance mismatch");
    }

    /// @notice The 0.30% open-tier fee is actually charged.
    /// @dev Compared against a fee-free program over identical shipped balances,
    /// so the curve cancels and only the fee remains.
    function test_openTierChargesThirtyBps() public {
        ISwapVM.Order memory withFee = _createOrder(_openProgram(4));
        ISwapVM.Order memory noFee = _createOrder(_noFeeProgram(5));
        _ship(_router(), withFee, SHIP_USDC, SHIP_WETH);
        _ship(_router(), noFee, SHIP_USDC, SHIP_WETH);

        address carol = makeAddr("carol");
        uint256 amountIn = 10_000e6;
        bytes memory td = _takerData(carol, true, true, "");

        (, uint256 outWithFee,) = _router().asView().quote(withFee, amountIn, td);
        (, uint256 outNoFee,) = _router().asView().quote(noFee, amountIn, td);

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
    /// @dev The Aqua property ScubaSwap is built on: programs A/B/C in Phase 4
    /// all draw on the same capital.
    function test_twoStrategiesShareTheSameMakerWallet() public {
        ISwapVM.Order memory first = _createOrder(_openProgram(6));
        ISwapVM.Order memory second = _createOrder(_openProgram(7));

        bytes32 hash1 = _ship(_router(), first, SHIP_USDC, SHIP_WETH);
        bytes32 hash2 = _ship(_router(), second, SHIP_USDC, SHIP_WETH);

        assertTrue(hash1 != hash2, "distinct programs must have distinct hashes");

        // Both strategies report full balances while the maker holds one balance.
        (uint256 a1,) = aqua.safeBalances(maker, address(_router()), hash1, TOKEN_A, TOKEN_B);
        (uint256 a2,) = aqua.safeBalances(maker, address(_router()), hash2, TOKEN_A, TOKEN_B);
        assertEq(a1, SHIP_USDC, "strategy 1 balance");
        assertEq(a2, SHIP_USDC, "strategy 2 balance");
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "maker wallet unchanged by either ship");
    }

    // ===== helpers =====

    /// @dev `_openProgram` minus the fee instruction, hand-encoded so the fee
    /// comparison above is explicit about what differs:
    ///   50 00        XYCSwap, no args
    ///   02 20 <salt> Salt, 32 bytes
    function _noFeeProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"5000", hex"02", uint8(32), bytes32(salt));
    }
}
