// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { dynamic } from "@1inch/swap-vm/test/utils/Dynamic.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";
import { WorldIdGuardArgsBuilder } from "../../src/instructions/WorldIdGuard.sol";
import { SCUBA_OP_ONLY_HUMAN_TAKER, SCUBA_OP_JUMP_IF_HUMAN } from "../../src/opcodes/ScubaOpcodes.sol";

/// @title WorldChainForkBase
/// @notice Fork harness for the chain where World ID 4.0 actually lives.
///
/// @dev **Aqua is deployed by this harness, not canonical.** Aqua exists at the
/// same address on Ethereum, Optimism, Base, Arbitrum and Polygon — and nowhere
/// on World Chain (`eth_getCode` returns `0x` on chain 480). Since the v4
/// verifier exists only on World Chain, no chain carries both, and something has
/// to give. See FRICTION W-07.
///
/// Aqua's licence covers this explicitly: "You may read, use, deploy, and call
/// Aqua", and §4 names hackathons as free non-commercial use.
///
/// The Ethereum-fork suite (`ScubaRouterFork.t.sol`) still runs against the
/// canonical registry, so "our router does not disturb real Aqua" and "our guard
/// verifies real World ID proofs" are both proven — just on the chain where each
/// claim can actually be made.
abstract contract WorldChainForkBase is Test {
    // ===== World Chain (chainid 480) =====
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1;

    /// @dev Live World ID 4.0 verifier proxies. Both confirmed to accept a real
    /// fixture and to reject every perturbation of it.
    address internal constant WORLD_ID_V4_PRODUCTION = 0x00000000009E00F9FE82CfeeBB4556686da094d7;
    address internal constant WORLD_ID_V4_STAGING = 0x703a6316c975DEabF30b637c155edD53e24657DB;

    /// @dev `Fee.BPS` is 1e9, not 10_000, despite the parameters being named
    /// `feeBps`. See FRICTION F-11.
    uint256 internal constant FEE_DENOMINATOR = 1e9;
    uint32 internal constant OPEN_FEE = 3_000_000; // 0.30%
    uint32 internal constant HUMAN_FEE = 500_000; //  0.05%

    /// @dev Proof of Human. The maker pins this in the program so a taker cannot
    /// substitute a weaker credential.
    uint64 internal constant SCHEMA_PROOF_OF_HUMAN = 1;

    // MakerTraits requires tokenA < tokenB numerically. On World Chain that is
    // the OPPOSITE of Ethereum: WETH is the OP-stack predeploy 0x4200..06 while
    // USDC is 0x79A0..., so WETH sorts first here and USDC sorts first there.
    // Hard-coding Ethereum's order reverts MakerTraitsTokensNotSorted().
    address internal constant TOKEN_A = WETH;
    address internal constant TOKEN_B = USDC;

    uint256 internal constant MAKER_USDC = 2_000_000e6;
    uint256 internal constant MAKER_WETH = 500e18;
    uint256 internal constant SHIP_USDC = 1_000_000e6;
    uint256 internal constant SHIP_WETH = 250e18;

    Aqua internal aqua;
    address internal maker;
    address internal owner;

    /// @dev Pinned rather than `latest`, for two reasons. Foundry only caches
    /// RPC responses for a pinned block, and the invariant suite makes enough
    /// calls to get HTTP 429'd off a public endpoint without it. It also keeps
    /// `block.timestamp` stable, which matters because the guard's freshness
    /// check is time-dependent.
    uint256 internal constant PINNED_BLOCK = 32_820_398;

    function setUp() public virtual {
        vm.createSelectFork(
            vm.envOr("WORLDCHAIN_RPC_URL", string("https://worldchain.drpc.org")), PINNED_BLOCK
        );

        aqua = new Aqua();
        maker = makeAddr("maker");
        owner = makeAddr("owner");

        deal(USDC, maker, MAKER_USDC, true);
        deal(WETH, maker, MAKER_WETH);

        vm.startPrank(maker);
        IERC20(USDC).approve(address(aqua), type(uint256).max);
        IERC20(WETH).approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    /// @notice Fails loudly if the fork environment is wrong, rather than
    /// surfacing as a confusing revert deep inside a swap.
    function test_forkIsWorldChain() public view {
        assertEq(block.chainid, 480, "not World Chain");
        assertGt(WORLD_ID_V4_STAGING.code.length, 0, "staging verifier missing");
        assertGt(WORLD_ID_V4_PRODUCTION.code.length, 0, "production verifier missing");
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "USDC funding failed");
        assertEq(IERC20(WETH).balanceOf(maker), MAKER_WETH, "WETH funding failed");
    }

    // ===== programs =====

    /// @notice Program C — human-only. Guard first, then the discounted fee.
    /// @dev Guard-first is mandatory: a rejected taker must never reach fee or
    /// curve math, and it keeps the guard outside the nested `runLoop` that
    /// `FlatFeeAmountIn` opens (FRICTION F-12).
    function _humanOnlyProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(SCUBA_OP_ONLY_HUMAN_TAKER),
            uint8(WorldIdGuardArgsBuilder.POLICY_LENGTH),
            WorldIdGuardArgsBuilder.buildPolicy(SCHEMA_PROOF_OF_HUMAN, 0),
            hex"70",
            uint8(4),
            HUMAN_FEE,
            hex"5000", // XYCSwap
            hex"02",
            uint8(32),
            bytes32(salt)
        );
    }

    /// @notice Program A — open tier, stock opcodes only.
    function _openProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"70", uint8(4), OPEN_FEE, hex"5000", hex"02", uint8(32), bytes32(salt));
    }

    /// @notice Program B — tiered. Humans branch to a cheaper fee; everyone else
    /// falls through to the open fee. Both paths converge on the same curve and
    /// the same shipped liquidity.
    ///
    /// @dev Byte layout, which the jump targets depend on exactly:
    /// ```
    ///  0  0x33 len=42  jump-if-human (pc=54)      -> next 44
    /// 44  0x70 len=4   FlatFee(OPEN)              -> next 50   [opens a nested runLoop]
    /// 50  0x03 len=2   Jump(60)                   -> next 54
    /// 54  0x70 len=4   FlatFee(HUMAN)             -> next 60   [human branch target]
    /// 60  0x50 len=0   XYCSwap                    -> next 62   [shared tail]
    /// 62  0x02 len=32  Salt
    /// ```
    /// Non-human: guard falls through to 44, pays OPEN, whose nested loop jumps
    /// straight past the human fee to the curve at 60.
    /// Human: guard jumps to 54, pays HUMAN, whose nested loop runs the curve.
    /// Either way exactly one fee is charged. `test_programBLayoutIsIntact`
    /// pins these offsets.
    function _tieredProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(SCUBA_OP_JUMP_IF_HUMAN),
            uint8(WorldIdGuardArgsBuilder.POLICY_WITH_PC_LENGTH),
            WorldIdGuardArgsBuilder.buildPolicyWithPC(54, SCHEMA_PROOF_OF_HUMAN, 0),
            hex"70",
            uint8(4),
            OPEN_FEE,
            hex"03",
            uint8(2),
            uint16(60),
            hex"70",
            uint8(4),
            HUMAN_FEE,
            hex"5000",
            hex"02",
            uint8(32),
            bytes32(salt)
        );
    }

    // ===== orders and liquidity =====

    function _createOrder(bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: TOKEN_A,
                tokenB: TOKEN_B,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    function _ship(SwapVM router, ISwapVM.Order memory order, uint256 amountA, uint256 amountB)
        internal
        returns (bytes32 strategyHash)
    {
        vm.prank(maker);
        strategyHash =
            aqua.ship(address(router), abi.encode(order), dynamic([TOKEN_A, TOKEN_B]), dynamic([amountA, amountB]));
        assertEq(strategyHash, router.hash(order), "Aqua strategy hash != router order hash");
    }

    // ===== taker side =====

    /// @dev EOA taker. `useTransferFromAndAquaPush` lets the router pull tokenIn
    /// itself, so no callback entrypoint is needed — which matters because the
    /// World ID signal binds to `ctx.query.taker`, and only an EOA lets us prank
    /// as the exact address a proof was generated for.
    function _takerData(address takerAddr, bool isExactIn, bool isAToB, bytes memory instructionsArgs)
        internal
        pure
        returns (bytes memory)
    {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: takerAddr,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: instructionsArgs,
                signature: ""
            })
        );
    }

    /// @notice Ship the standard balances, in tokenA/tokenB order.
    /// @dev Wrapper so call sites never have to remember that tokenA is WETH on
    /// this chain — getting it backwards silently ships the wrong side.
    function _shipDefault(SwapVM router, ISwapVM.Order memory order) internal returns (bytes32) {
        return _ship(router, order, SHIP_WETH, SHIP_USDC);
    }

    function _fundTaker(address router, address takerAddr, address tokenIn, uint256 amount) internal {
        deal(tokenIn, takerAddr, amount, tokenIn == USDC);
        vm.prank(takerAddr);
        IERC20(tokenIn).approve(router, type(uint256).max);
    }
}
