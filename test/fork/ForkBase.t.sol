// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { FeeArgsBuilder } from "@1inch/swap-vm/src/instructions/Fee.sol";

import { Program, ProgramBuilder } from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";
import { dynamic } from "@1inch/swap-vm/test/utils/Dynamic.sol";

/// @title ForkBase
/// @notice Shared mainnet-fork harness for ScubaSwap.
/// @dev Everything here runs against the *canonical* deployed contracts. The
/// only thing we deploy is a router, because there is no published router
/// address — see README §1. Tokens are real USDC/WETH, funded with `deal`.
///
/// Takers are EOAs, not the repo's `MockTaker`. That is deliberate: the World ID
/// signal binds to `ctx.query.taker == msg.sender`, and our proof fixture is
/// generated for a specific address. An EOA taker is the only shape where we can
/// `vm.prank` as exactly that address.
abstract contract ForkBase is Test {
    using ProgramBuilder for Program;

    // ===== Canonical mainnet addresses (verified live, see README §1) =====
    address internal constant AQUA = 0x499943E74FB0cE105688beeE8Ef2ABec5D936d31;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WORLD_ID_ROUTER = 0x163b09b4fE21177c455D850BD815B6D583732432;

    /// @dev Orb credential group on the v3 router.
    uint256 internal constant GROUP_ID_ORB = 1;

    /// @dev CAREFUL: `Fee.BPS` is 1e9, not 10_000, despite every argument being
    /// named `feeBps`. Writing `30` here would mean 30 parts-per-billion — a
    /// ~zero fee that reverts nothing and looks like it worked. See FRICTION F-11.
    uint256 internal constant FEE_DENOMINATOR = 1e9;
    uint32 internal constant OPEN_FEE = 3_000_000; // 0.30%
    uint32 internal constant HUMAN_FEE = 500_000; //  0.05%

    // USDC is 6dp, WETH is 18dp. Sorted: USDC < WETH, which MakerTraits requires.
    address internal constant TOKEN_A = USDC;
    address internal constant TOKEN_B = WETH;

    uint256 internal constant MAKER_USDC = 2_000_000e6;
    uint256 internal constant MAKER_WETH = 500e18;

    IAqua internal aqua = IAqua(AQUA);

    address internal maker;
    address internal owner;

    function setUp() public virtual {
        // Fork at LATEST block on purpose: World ID merkle roots age out in about
        // a week, so a pinned historical block would make every proof stale.
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://ethereum-rpc.publicnode.com")));

        maker = makeAddr("maker");
        owner = makeAddr("owner");

        deal(USDC, maker, MAKER_USDC, true);
        deal(WETH, maker, MAKER_WETH);

        vm.startPrank(maker);
        IERC20(USDC).approve(AQUA, type(uint256).max);
        IERC20(WETH).approve(AQUA, type(uint256).max);
        vm.stopPrank();
    }

    // ===== Sanity =====

    /// @notice Guards against a silently-broken fork (wrong chain, dead RPC,
    /// address typo). Every fork suite inherits it, so a bad environment fails
    /// loudly here instead of as a confusing revert deep inside a swap.
    function test_forkIsMainnetWithLiveContracts() public view {
        assertEq(block.chainid, 1, "not mainnet");
        assertGt(AQUA.code.length, 0, "Aqua has no code");
        assertGt(WORLD_ID_ROUTER.code.length, 0, "World ID router has no code");
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "USDC funding failed");
        assertEq(IERC20(WETH).balanceOf(maker), MAKER_WETH, "WETH funding failed");
    }

    // ===== Program construction =====

    /// @notice Program A — the open tier. Stock opcodes only, no custom code.
    /// @dev `Salt` makes the order hash unique so repeated runs ship distinct
    /// strategies instead of colliding on an already-shipped hash.
    function _openProgram(uint256 salt) internal pure returns (bytes memory) {
        Program p;
        return bytes.concat(
            p.build(Opcode.FlatFeeAmountIn, FeeArgsBuilder.buildFlatFee(OPEN_FEE)),
            p.build(Opcode.XYCSwap),
            p.build(Opcode.Salt, abi.encodePacked(salt))
        );
    }

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

    /// @notice Ship maker liquidity into Aqua against `router`.
    /// @dev The strategy hash Aqua returns must equal the router's own order
    /// hash, otherwise the VM would read balances from a different slot.
    function _ship(SwapVM router, ISwapVM.Order memory order, uint256 amountA, uint256 amountB)
        internal
        returns (bytes32 strategyHash)
    {
        vm.prank(maker);
        strategyHash = aqua.ship(
            address(router),
            abi.encode(order),
            dynamic([TOKEN_A, TOKEN_B]),
            dynamic([amountA, amountB])
        );

        assertEq(strategyHash, router.hash(order), "Aqua strategy hash != router order hash");
    }

    // ===== Taker side =====

    /// @notice Taker traits for a plain EOA taker.
    /// @dev `useTransferFromAndAquaPush` is what makes an EOA taker work: the
    /// router pulls tokenIn with `transferFrom` and pushes it into Aqua itself,
    /// so the taker needs no callback entrypoint. `hasPreTransferInCallback`
    /// must stay false — an EOA cannot answer a callback.
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

    /// @notice Fund an EOA taker with tokenIn and approve the router.
    function _fundTaker(address takerAddr, address tokenIn, uint256 amount) internal {
        deal(tokenIn, takerAddr, amount, tokenIn == USDC);
        vm.prank(takerAddr);
        IERC20(tokenIn).approve(address(_router()), type(uint256).max);
    }

    /// @dev Concrete suites supply the router under test.
    function _router() internal view virtual returns (SwapVM);
}
