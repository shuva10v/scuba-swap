// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { CoreInvariants } from "@1inch/swap-vm/test/invariants/CoreInvariants.t.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";
import { WorldIdGuardArgsBuilder } from "../../src/instructions/WorldIdGuard.sol";
import { ByteHasher } from "../../src/helpers/ByteHasher.sol";

import { MockWorldIDVerifier } from "../mocks/MockWorldIDVerifier.sol";
import { WorldChainForkBase } from "./WorldChainForkBase.t.sol";

/// @title StrategiesTest
/// @notice Phase 4 — the three programs running side by side on **one** maker
/// balance, checked against 1inch's own invariant suite, plus the gas cost of
/// proof verification.
///
/// @dev The reason to build this on Aqua rather than as two pools is that a
/// maker keeps a single wallet balance and lets several strategies draw on it.
/// `test_allThreeProgramsShareOneMakerBalance` is the assertion that this is
/// actually true rather than merely claimed.
///
/// The invariant suite is 1inch's `CoreInvariants`, inherited unmodified. It
/// needs one adaptation, documented on `_executeSwap`: a v4 proof is single-use,
/// so each swap it drives must carry a fresh one.
contract StrategiesTest is WorldChainForkBase, CoreInvariants {
    using ByteHasher for bytes;

    string internal constant ACTION = "world-demo-v2";
    uint64 internal constant RP_ID = 3_180_554_207_396_540_622;

    MockWorldIDVerifier internal verifier;
    ScubaSwapVMRouter internal router;

    /// @dev Bumped per proof so the spent set never collides. Reverted along
    /// with everything else by the suite's `vm.revertTo`, which is harmless: the
    /// matching spend is rolled back too.
    uint256 internal proofSeq;

    /// @dev Taker data whose proof is only ever used for `quote()`. Quotes are
    /// staticcalls, so the guard never spends it and it stays valid for the
    /// whole run. Registered in `setUp`, before any snapshot could roll it back.
    bytes internal quoteTakerData;
    /// @dev The raw 232-byte payload behind `quoteTakerData`, kept so exact-out
    /// taker data can be built from the same never-spent proof.
    bytes internal quoteProofArgs;
    /// @dev Hash of the exact-OUT blob handed to the invariant suite, so
    /// `_executeSwap` can tell which direction it is being asked to execute.
    bytes32 internal exactOutBlobHash;

    function setUp() public override {
        super.setUp();
        verifier = new MockWorldIDVerifier();
        router = new ScubaSwapVMRouter(
            address(aqua), WETH, owner, "ScubaSwapVM", "1", IWorldIDVerifier(address(verifier)), ACTION, RP_ID
        );

        // CoreInvariants calls quote() itself, so `ctx.query.taker` is THIS
        // contract — the proof must be bound to it, not to an EOA.
        quoteProofArgs = _mintProof(address(this));
        quoteTakerData = _takerData(address(this), true, true, quoteProofArgs);

        deal(WETH, address(this), 10_000e18);
        IERC20(WETH).approve(address(router), type(uint256).max);
    }

    // ===== the Aqua claim =====

    /// @notice All three programs are backed by the same maker wallet balance.
    /// @dev Each `ship` registers a virtual balance; none of them moves a token.
    /// The maker's wallet is untouched and is the single source for all three.
    function test_allThreeProgramsShareOneMakerBalance() public {
        ISwapVM.Order memory a = _createOrder(_openProgram(101));
        ISwapVM.Order memory b = _createOrder(_tieredProgram(102));
        ISwapVM.Order memory c = _createOrder(_humanOnlyProgram(103));

        bytes32 ha = _shipDefault(SwapVM(payable(address(router))), a);
        bytes32 hb = _shipDefault(SwapVM(payable(address(router))), b);
        bytes32 hc = _shipDefault(SwapVM(payable(address(router))), c);

        assertTrue(ha != hb && hb != hc && ha != hc, "programs must be distinct strategies");

        // Three strategies each report the full shipped balance...
        for (uint256 i; i < 3; ++i) {
            bytes32 h = i == 0 ? ha : (i == 1 ? hb : hc);
            (uint256 wethBal, uint256 usdcBal) = aqua.safeBalances(maker, address(router), h, TOKEN_A, TOKEN_B);
            assertEq(wethBal, SHIP_WETH, "WETH balance per strategy");
            assertEq(usdcBal, SHIP_USDC, "USDC balance per strategy");
        }

        // ...while the maker holds exactly one balance, and Aqua custodies none.
        assertEq(IERC20(WETH).balanceOf(maker), MAKER_WETH, "maker WETH untouched by shipping");
        assertEq(IERC20(USDC).balanceOf(maker), MAKER_USDC, "maker USDC untouched by shipping");
        assertEq(IERC20(WETH).balanceOf(address(aqua)), 0, "Aqua must custody nothing");
    }

    /// @notice A trade on one program draws down the maker's real wallet, which
    /// is what the other programs are also drawing on.
    function test_tradingOneProgramMovesTheSharedWallet() public {
        ISwapVM.Order memory c = _createOrder(_humanOnlyProgram(104));
        _shipDefault(SwapVM(payable(address(router))), c);

        uint256 makerUsdcBefore = IERC20(USDC).balanceOf(maker);

        (, uint256 out) = _swapAsThis(c, 1e18);

        assertGt(out, 0, "no USDC received");
        assertEq(makerUsdcBefore - IERC20(USDC).balanceOf(maker), out, "maker wallet is the real source of liquidity");
    }

    // ===== the guard is amount-neutral =====

    /// @notice Program C prices identically to an unguarded program with the
    /// same fee.
    /// @dev The sharpest statement available about the guard: it decides *who*
    /// may trade, and has no influence whatsoever on *at what price*. Stronger
    /// than any single invariant, because it compares against a reference
    /// program rather than a tolerance.
    function test_guardDoesNotAffectPricing() public {
        ISwapVM.Order memory guarded = _createOrder(_humanOnlyProgram(105));
        ISwapVM.Order memory plain = _createOrder(_flatFeeProgram(HUMAN_FEE, 106));
        _shipDefault(SwapVM(payable(address(router))), guarded);
        _shipDefault(SwapVM(payable(address(router))), plain);

        ISwapVM v = router.asView();

        (, uint256 guardedOut,) = v.quote(guarded, 1e18, quoteTakerData);
        (, uint256 plainOut,) = v.quote(plain, 1e18, _takerData(address(this), true, true, ""));

        assertEq(guardedOut, plainOut, "guard must not move the price");
    }

    // ===== 1inch's invariant suite =====

    /// @notice Program A — pure stock opcodes on our router.
    function test_invariants_programA_open() public {
        ISwapVM.Order memory a = _createOrder(_openProgram(107));
        _shipDefault(SwapVM(payable(address(router))), a);

        assertAllInvariantsWithConfig(
            SwapVM(payable(address(router))), a, TOKEN_A, TOKEN_B, _config("")
        );
    }

    /// @notice Program C — the same invariants, with the guard in the program.
    /// @dev If the guard perturbed the VM context — consumed taker args it
    /// should not, or moved the program counter — symmetry, additivity and
    /// monotonicity would all drift. They do not.
    function test_invariants_programC_humanOnly() public {
        ISwapVM.Order memory c = _createOrder(_humanOnlyProgram(108));
        _shipDefault(SwapVM(payable(address(router))), c);

        assertAllInvariantsWithConfig(SwapVM(payable(address(router))), c, TOKEN_A, TOKEN_B, _config(quoteProofArgs));
    }

    // ===== gas =====

    /// @notice What proof verification actually costs, on top of an open swap.
    /// @dev Reported rather than asserted: the number is dominated by
    /// `MockWorldIDVerifier`, not by real Groth16, so a threshold here would be
    /// meaningless. The real verifier's cost is visible in
    /// `WorldIdRealProof.t.sol` (~397k gas for a bare `verify` call).
    /// What IS asserted is that our own overhead — arg parsing, freshness,
    /// spend-set write — stays modest.
    function test_gas_guardOverhead() public {
        ISwapVM.Order memory open = _createOrder(_openProgram(109));
        ISwapVM.Order memory guarded = _createOrder(_humanOnlyProgram(110));
        _shipDefault(SwapVM(payable(address(router))), open);
        _shipDefault(SwapVM(payable(address(router))), guarded);

        bytes memory openTd = _takerData(address(this), true, true, "");
        bytes memory guardedTd = _takerData(address(this), true, true, _mintProof(address(this)));

        // Both measurements must start from the SAME state. Run back-to-back,
        // the second swap is cheaper regardless of what it does, because the
        // first warmed the Aqua and token storage slots — measured at ~36k,
        // enough to make the guarded swap look free.
        uint256 snap = vm.snapshotState();

        uint256 g0 = gasleft();
        router.swap(open, 1e18, openTd);
        uint256 openGas = g0 - gasleft();

        vm.revertToState(snap);

        g0 = gasleft();
        router.swap(guarded, 1e18, guardedTd);
        uint256 guardedGas = g0 - gasleft();

        emit log_named_uint("program A (open)        gas", openGas);
        emit log_named_uint("program C (guarded)     gas", guardedGas);
        emit log_named_uint("guard overhead vs mock  gas", guardedGas - openGas);

        // Sanity only. The dominant real-world term is Groth16 verification,
        // which the mock does not perform.
        assertGt(guardedGas, openGas, "guard should cost something");
        assertLt(guardedGas - openGas, 150_000, "our own guard overhead has regressed");
    }

    // ===== CoreInvariants hook =====

    /// @notice Executes a real swap for the invariant suite.
    /// @dev Deliberately ignores the `takerData` it is handed and builds its own.
    /// A v4 proof is single-use — the guard spends `(nullifier, nonce)` — but the
    /// suite reuses one taker-data blob across many swaps, so a shared proof
    /// would revert `WorldIdProofAlreadySpent` on the second call. Minting a
    /// fresh proof per swap is the only way to run the suite against a guarded
    /// program at all, and it is faithful: it is exactly what a real taker does.
    ///
    /// For unguarded programs the extra proof is simply left unconsumed in
    /// `takerArgs`, which the VM ignores.
    function _executeSwap(
        SwapVM swapVM,
        ISwapVM.Order memory order,
        address tokenIn,
        address, /* tokenOut */
        uint256 amount,
        bytes memory takerData
    ) internal override returns (uint256 amountIn, uint256 amountOut) {
        // The blob is rebuilt rather than reused, but its DIRECTION must be
        // preserved: the suite drives both exact-in and exact-out, and swapping
        // exact-in when it asked for exact-out makes quote/swap consistency fail
        // with amounts that look nonsensical rather than merely wrong.
        bool isExactIn = keccak256(takerData) != exactOutBlobHash;

        // Fund generously: for exact-out, `amount` is denominated in the OUTPUT
        // token, so it says nothing about how much input is needed.
        deal(tokenIn, address(this), 1_000_000e18);
        IERC20(tokenIn).approve(address(swapVM), type(uint256).max);

        bytes memory td = _takerData(address(this), isExactIn, true, _mintProof(address(this)));
        (amountIn, amountOut,) = swapVM.swap(order, amount, td);
    }

    // ===== helpers =====

    /// @param proofArgs Raw guard payload, or empty for unguarded programs.
    /// @dev Builds BOTH taker-data blobs from the same proof. The exact-out blob
    /// cannot simply be empty — `TakerTraitsLib.parse` rejects it with
    /// `TakerTraitsMissingTraits()`, since taker traits are mandatory even when
    /// every field is default.
    function _config(bytes memory proofArgs) private returns (InvariantConfig memory cfg) {
        // Exact-in amounts are tokenIn-denominated (WETH, 18dp).
        uint256[] memory amounts = new uint256[](3);
        amounts[0] = 1e18;
        amounts[1] = 5e18;
        amounts[2] = 10e18;

        // Exact-out amounts are tokenOUT-denominated (USDC, 6dp) and MUST be
        // supplied. Left empty, the suite falls back to reusing the exact-in
        // amounts — which here means quoting for 1e18 units of USDC out of a
        // pool holding 1e12, and the VM underflows on balanceOut - amountOut.
        // Another place the upstream defaults quietly assume both tokens share
        // decimals.
        uint256[] memory amountsOut = new uint256[](3);
        amountsOut[0] = 1_000e6;
        amountsOut[1] = 5_000e6;
        amountsOut[2] = 10_000e6;

        cfg = InvariantConfig({
            // Upstream defaults to 2 wei, which assumes an 18/18 pair. Ours is
            // WETH(18) -> USDC(6): an exact-out quote quantises to whole USDC
            // units, so round-tripping exactIn -> exactOut -> exactIn cannot
            // recover the input more precisely than one output quantum
            // expressed in input terms. At ~3972 USDC/WETH that quantum is
            // 1e18/3972e6 ~= 2.5e8 wei; observed drift is 1.99e8. 1e9 leaves
            // ~4x headroom while still being 1e-9 relative.
            //
            // This is a property of the token pair, not of ScubaSwap: program A
            // is pure stock opcodes and violates the 2-wei bound identically.
            symmetryTolerance: 1e9,
            additivityTolerance: 0,
            roundingToleranceBps: 100,
            monotonicityToleranceBps: 0,
            testAmounts: amounts,
            testAmountsExactOut: amountsOut,
            skipAdditivity: false,
            skipMonotonicity: false,
            skipSpotPrice: false,
            skipSymmetry: false,
            exactInTakerData: _takerData(address(this), true, true, proofArgs),
            exactOutTakerData: _takerData(address(this), false, true, proofArgs)
        });

        exactOutBlobHash = keccak256(cfg.exactOutTakerData);
    }

    function _flatFeeProgram(uint32 fee, uint256 salt) private pure returns (bytes memory) {
        return abi.encodePacked(hex"70", uint8(4), fee, hex"5000", hex"02", uint8(32), bytes32(salt));
    }

    function _swapAsThis(ISwapVM.Order memory order, uint256 amount) private returns (uint256, uint256) {
        deal(WETH, address(this), amount * 2);
        bytes memory td = _takerData(address(this), true, true, _mintProof(address(this)));
        (uint256 i, uint256 o,) = router.swap(order, amount, td);
        return (i, o);
    }

    /// @dev Registers a fresh, unique, currently-valid proof with the mock.
    function _mintProof(address taker) private returns (bytes memory) {
        uint256 seq = ++proofSeq;
        uint256 nullifier = uint256(keccak256(abi.encode("scuba-nullifier", taker)));
        uint256 nonce = uint256(keccak256(abi.encode("scuba-nonce", seq)));
        uint64 expiresAtMin = uint64(block.timestamp + 1 hours);

        uint256[5] memory zk = [uint256(1), 2, 3, 4, 5];

        verifier.accept(
            nullifier,
            bytes(ACTION).hashToField(),
            RP_ID,
            nonce,
            abi.encodePacked(taker).hashToField(),
            expiresAtMin,
            SCHEMA_PROOF_OF_HUMAN,
            0,
            zk
        );

        return WorldIdGuardArgsBuilder.buildProof(nullifier, nonce, expiresAtMin, zk);
    }
}
