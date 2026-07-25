// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { SwapVM } from "@1inch/swap-vm/src/SwapVM.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { ScubaSwapVMRouter } from "../../src/routers/ScubaSwapVMRouter.sol";
import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";
import { WorldIdGuard, WorldIdGuardArgsBuilder } from "../../src/instructions/WorldIdGuard.sol";
import { ByteHasher } from "../../src/helpers/ByteHasher.sol";

import { MockWorldIDVerifier } from "../mocks/MockWorldIDVerifier.sol";
import { WorldChainForkBase } from "./WorldChainForkBase.t.sol";

/// @title WorldIdGuardTest
/// @notice Behaviour of the World ID guard instructions, on a World Chain fork.
///
/// @dev Uses `MockWorldIDVerifier` rather than the live verifier, for a reason
/// that is structural rather than convenient: a real v4 proof is **single-use**
/// (the guard spends it) and **short-lived** (minutes), so a suite that needs
/// many proofs across many swaps cannot run on real ones. The mock still keys on
/// the full tuple of public inputs, so a guard that derived `signalHash` wrongly
/// or ignored `nonce` would fail here exactly as it would on-chain.
///
/// The cryptography the mock cannot reproduce is covered elsewhere:
/// `WorldIdRealProof.t.sol` runs a real fixture against the live staging
/// verifier, and `WorldIdEncoding.t.sol` pins our hashing to external vectors.
contract WorldIdGuardTest is WorldChainForkBase {
    using ByteHasher for bytes;

    string internal constant ACTION = "world-demo-v2";
    uint64 internal constant RP_ID = 3_180_554_207_396_540_622;

    MockWorldIDVerifier internal verifier;
    ScubaSwapVMRouter internal router;

    address internal human;
    address internal bot;

    function setUp() public override {
        super.setUp();
        verifier = new MockWorldIDVerifier();
        router = new ScubaSwapVMRouter(
            address(aqua), WETH, owner, "ScubaSwapVM", "1", IWorldIDVerifier(address(verifier)), ACTION, RP_ID
        );
        human = makeAddr("human");
        bot = makeAddr("bot");
    }

    // ===== program C: human-only =====

    function test_humanOnly_verifiedTakerSwaps() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(1));
        bytes32 hash = _shipDefault(SwapVM(payable(address(router))), order);

        uint256 amountIn = 10_000e6;
        _fundTaker(address(router), human, USDC, amountIn);
        bytes memory proof = _validProofFor(human, 1);

        vm.prank(human);
        (uint256 sIn, uint256 sOut,) = router.swap(order, amountIn, _takerData(human, true, false, proof));

        assertEq(sIn, amountIn, "full input should be consumed");
        assertGt(sOut, 0, "human received nothing");
        assertEq(IERC20(WETH).balanceOf(human), sOut, "WETH not delivered");

        (, uint256 balUsdc) = aqua.safeBalances(maker, address(router), hash, TOKEN_A, TOKEN_B);
        assertEq(balUsdc, SHIP_USDC + sIn, "Aqua USDC balance did not grow by amountIn");
    }

    // ===== prefix-scoped actions =====

    /// @notice The property the whole scheme exists for: one human, two dives.
    ///
    /// @dev World ID caps issuance at one proof per (identity, rp, action), and that
    /// cap lives in the issuer, not in any contract. A router pinning one exact
    /// action therefore granted each human a single swap for the router's entire
    /// lifetime — and once their device refused to mint again, only a redeploy
    /// helped. FRICTION W-08, W-10.
    ///
    /// Committing to a prefix instead lets the taker name a fresh action per dive.
    /// Note the two proofs here carry *different* actions, which is what a real
    /// second World App round-trip would produce.
    function test_humanOnly_sameHumanDivesTwiceWithDifferentActions() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(11));
        _shipDefault(SwapVM(payable(address(router))), order);

        uint256 amountIn = 5_000e6;
        _fundTaker(address(router), human, USDC, amountIn * 2);

        bytes memory first =
            _proofWithAction(human, _nullifier(11), _nonce(11), uint64(block.timestamp + 300), "world-demo-v2-1");
        vm.prank(human);
        (, uint256 outFirst,) = router.swap(order, amountIn, _takerData(human, true, false, first));
        assertGt(outFirst, 0, "first dive delivered nothing");

        // A genuinely different action: different nullifier, different nonce.
        bytes memory second =
            _proofWithAction(human, _nullifier(12), _nonce(12), uint64(block.timestamp + 300), "world-demo-v2-2");
        vm.prank(human);
        (, uint256 outSecond,) = router.swap(order, amountIn, _takerData(human, true, false, second));
        assertGt(outSecond, 0, "second dive rejected: the prefix scheme is not working");
    }

    function test_humanOnly_actionOutsideThePrefixIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(13));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        // Valid proof, correct rp, bound to the right taker — but an action this
        // router does not serve. The rp still pins the app; the prefix pins the
        // purpose within it.
        bytes memory proof =
            _proofWithAction(human, _nullifier(13), _nonce(13), uint64(block.timestamp + 300), "some-other-action");

        vm.prank(human);
        vm.expectRevert(WorldIdGuard.WorldIdActionNotAllowed.selector);
        router.swap(order, 10_000e6, _takerData(human, true, false, proof));
    }

    /// @dev A prefix must match at the *start*, not anywhere. Otherwise an action
    /// belonging to some other purpose could smuggle the prefix in as a suffix.
    function test_humanOnly_prefixMustMatchAtTheStart() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(14));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        bytes memory proof = _proofWithAction(
            human, _nullifier(14), _nonce(14), uint64(block.timestamp + 300), string.concat("evil-", ACTION)
        );

        vm.prank(human);
        vm.expectRevert(WorldIdGuard.WorldIdActionNotAllowed.selector);
        router.swap(order, 10_000e6, _takerData(human, true, false, proof));
    }

    /// @dev An action shorter than the prefix cannot match. Worth its own test
    /// because the length guard is what stops `action[:prefixLength]` reverting with
    /// a bare panic instead of the guard's own error.
    function test_humanOnly_actionShorterThanPrefixIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(15));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        bytes memory proof =
            _proofWithAction(human, _nullifier(15), _nonce(15), uint64(block.timestamp + 300), "world");

        vm.prank(human);
        vm.expectRevert(WorldIdGuard.WorldIdActionNotAllowed.selector);
        router.swap(order, 10_000e6, _takerData(human, true, false, proof));
    }

    /// @notice The tiered guard must fall through, not revert, on a wrong action.
    ///
    /// @dev `_jumpIfHumanTaker` promises never to revert — it powers a discount tier,
    /// so every failure mode has to mean "pay the open price". The action check is a
    /// new failure mode and had to be added to that promise rather than to the
    /// strict guard's error path.
    function test_tiered_actionOutsideThePrefixPaysOpenPrice() public {
        ISwapVM.Order memory order = _createOrder(_tieredProgram(16));
        _shipDefault(SwapVM(payable(address(router))), order);

        uint256 amountIn = 10_000e6;

        bytes memory wrongAction =
            _proofWithAction(human, _nullifier(16), _nonce(16), uint64(block.timestamp + 300), "some-other-action");

        uint256 snap = vm.snapshotState();
        _fundTaker(address(router), human, USDC, amountIn);
        vm.prank(human);
        (, uint256 outWrong,) = router.swap(order, amountIn, _takerData(human, true, false, wrongAction));
        vm.revertToState(snap);

        // Same swap with no proof at all must produce exactly the same amount: a
        // rejected action is indistinguishable from an absent proof, by design.
        _fundTaker(address(router), bot, USDC, amountIn);
        vm.prank(bot);
        (, uint256 outNone,) = router.swap(order, amountIn, _takerData(bot, true, false, ""));

        assertEq(outWrong, outNone, "a wrong action should price exactly as no proof does");
    }

    function test_humanOnly_takerWithNoProofIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(2));
        _shipDefault(SwapVM(payable(address(router))), order);

        _fundTaker(address(router), bot, USDC, 10_000e6);

        // The F-04 trap made concrete: tryChopTakerArgs returns a SHORT slice
        // rather than reverting, so a guard that trusted it would read zeros and
        // treat "no proof at all" as a payload. This must fail loudly.
        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(
                WorldIdGuard.WorldIdProofMissing.selector, 0, WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH
            )
        );
        router.swap(order, 10_000e6, _takerData(bot, true, false, ""));
    }

    function test_humanOnly_truncatedProofIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(3));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), bot, USDC, 10_000e6);

        bytes memory truncated = _sliceOff(_validProofFor(bot, 3), 40);

        vm.prank(bot);
        // 40 bytes off a (233 + action) payload leaves less than the fixed head, so
        // it is the head chop that comes up short.
        vm.expectRevert(
            abi.encodeWithSelector(
                WorldIdGuard.WorldIdProofMissing.selector,
                WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH + bytes(ACTION).length - 40,
                WorldIdGuardArgsBuilder.PROOF_HEAD_LENGTH
            )
        );
        router.swap(order, 10_000e6, _takerData(bot, true, false, truncated));
    }

    /// @notice A payload whose action is shorter than its own length byte claims.
    ///
    /// @dev Distinct from the case above, and the reason the guard checks the action
    /// chop separately: here the fixed head arrives intact, so the length byte is
    /// read and trusted before the bytes it describes are known to exist.
    /// `tryChopTakerArgs` clamps to what remains instead of reverting (F-04), so
    /// without an explicit check the guard would hash a short action and verify
    /// against the wrong field element.
    function test_humanOnly_truncatedActionIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(3));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), bot, USDC, 10_000e6);

        // Drop only the last 3 bytes, leaving the head and length byte untouched.
        bytes memory truncated = _sliceOff(_validProofFor(bot, 3), 3);

        vm.prank(bot);
        vm.expectRevert(
            abi.encodeWithSelector(
                WorldIdGuard.WorldIdProofMissing.selector, bytes(ACTION).length - 3, bytes(ACTION).length
            )
        );
        router.swap(order, 10_000e6, _takerData(bot, true, false, truncated));
    }

    /// @notice A proof bound to someone else does not work.
    /// @dev The core anti-sharing property: `signalHash` is derived from
    /// `ctx.query.taker`, never taken from `takerArgs`, so handing your proof to
    /// a bot buys it nothing unless it also controls your address.
    function test_humanOnly_proofBoundToAnotherAddressIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(4));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), bot, USDC, 10_000e6);

        // Registered for `human`, replayed by `bot`.
        bytes memory stolen = _validProofFor(human, 4);

        vm.prank(bot);
        vm.expectRevert(MockWorldIDVerifier.ProofInvalid.selector);
        router.swap(order, 10_000e6, _takerData(bot, true, false, stolen));
    }

    /// @notice A proof past `expiresAtMin` but inside the window is ACCEPTED.
    /// @dev The case that was broken. `expires_at_min` lands at roughly the moment
    /// of issuance, so a bare `expiresAtMin >= block.timestamp` is false within
    /// seconds of minting and no real taker could satisfy it — the UI showed a
    /// wetsuit and every dive would have reverted. The window is what makes the
    /// check enforceable rather than merely strict.
    function test_humanOnly_proofJustPastExpiryIsStillAccepted() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(50));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        uint64 expiry = uint64(block.timestamp);
        bytes memory proof = _validProofFor(human, 50, expiry);

        // Well past expiresAtMin, comfortably inside PROOF_FRESHNESS_WINDOW.
        vm.warp(uint256(expiry) + 5 minutes);

        vm.prank(human);
        (, uint256 out,) = router.swap(order, 10_000e6, _takerData(human, true, false, proof));
        assertGt(out, 0, "a proof minted five minutes ago must still be usable");
    }

    /// @notice Beyond the window, the guard rejects it — the verifier would not.
    /// @dev The mock, like the real verifier, accepts a stale proof happily. If
    /// `_requireFresh` were deleted, this test would fail and nothing else would.
    /// FRICTION W-06.
    function test_humanOnly_proofBeyondFreshnessWindowIsRejected() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(5));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        uint64 expiry = uint64(block.timestamp);
        bytes memory proof = _validProofFor(human, 5, expiry);

        vm.warp(uint256(expiry) + router.PROOF_FRESHNESS_WINDOW() + 1);

        vm.prank(human);
        vm.expectRevert(
            abi.encodeWithSelector(WorldIdGuard.WorldIdProofExpired.selector, expiry, block.timestamp)
        );
        router.swap(order, 10_000e6, _takerData(human, true, false, proof));
    }

    /// @notice The tiered guard uses the SAME window, not its own copy of the rule.
    /// @dev Both guards previously inlined the comparison; a stale proof must fall
    /// through to the open tier on 0x33 at exactly the point 0x27 starts reverting.
    function test_tiered_staleProofFallsThroughAtTheSameBoundary() public {
        ISwapVM.Order memory order = _createOrder(_tieredProgram(51));
        _shipDefault(SwapVM(payable(address(router))), order);

        uint64 expiry = uint64(block.timestamp);
        bytes memory proof = _validProofFor(human, 51, expiry);
        ISwapVM view_ = router.asView();

        vm.warp(uint256(expiry) + router.PROOF_FRESHNESS_WINDOW() - 1);
        vm.prank(human);
        (, uint256 fresh,) = view_.quote(order, 1e18, _takerData(human, true, true, proof));

        vm.warp(uint256(expiry) + router.PROOF_FRESHNESS_WINDOW() + 1);
        vm.prank(human);
        (, uint256 stale,) = view_.quote(order, 1e18, _takerData(human, true, true, proof));

        assertGt(fresh, stale, "inside the window should price better than outside it");
    }

    /// @notice One proof buys exactly one swap.
    function test_humanOnly_proofCannotBeReplayed() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(6));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 20_000e6);

        bytes memory proof = _validProofFor(human, 6);
        bytes memory td = _takerData(human, true, false, proof);

        vm.prank(human);
        router.swap(order, 10_000e6, td);

        vm.prank(human);
        vm.expectRevert(
            abi.encodeWithSelector(WorldIdGuard.WorldIdProofAlreadySpent.selector, _nullifier(6), _nonce(6))
        );
        router.swap(order, 10_000e6, td);
    }

    /// @notice The same human can swap again with a fresh proof.
    /// @dev Guards the W-08 trap. World ID's own example writes
    /// `nullifierUsed[nullifier] = true`, and the docs confirm the nullifier is
    /// constant per (identity, rp, action) — so that pattern would permit one
    /// swap per human for all time. Keying the spent set on (nullifier, nonce)
    /// is what keeps a repeatable action repeatable. Note both proofs below
    /// share a nullifier and differ only in nonce.
    function test_humanOnly_sameHumanSwapsAgainWithFreshProof() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(7));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 20_000e6);

        uint256 sharedNullifier = _nullifier(7);
        bytes memory first = _proof(human, sharedNullifier, 1001, uint64(block.timestamp + 300));
        bytes memory second = _proof(human, sharedNullifier, 1002, uint64(block.timestamp + 300));

        vm.prank(human);
        router.swap(order, 10_000e6, _takerData(human, true, false, first));

        vm.prank(human);
        (, uint256 out2,) = router.swap(order, 10_000e6, _takerData(human, true, false, second));

        assertGt(out2, 0, "same human must be able to trade again with a fresh proof");
    }

    // ===== quote/swap consistency =====

    /// @notice `quote()` agrees with `swap()` and does not consume the proof.
    /// @dev `quote` is staticcalled through `asView()`, so the spend must be
    /// gated on `!isStaticContext` or quoting would revert outright (F-03).
    /// Equally, quoting must not burn the proof, or every quote would break the
    /// swap that follows it.
    function test_quoteMatchesSwapAndDoesNotSpendTheProof() public {
        ISwapVM.Order memory order = _createOrder(_humanOnlyProgram(8));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), human, USDC, 10_000e6);

        bytes memory td = _takerData(human, true, false, _validProofFor(human, 8));

        // asView() is itself an external call, so it must be resolved BEFORE
        // vm.prank -- otherwise the prank is consumed by asView() and quote()
        // runs as the test contract, making the guard derive the wrong
        // signalHash. Same trap as vm.expectRevert. FRICTION F-13.
        ISwapVM view_ = router.asView();
        vm.prank(human);
        (uint256 qIn, uint256 qOut,) = view_.quote(order, 10_000e6, td);
        assertGt(qOut, 0, "quote returned nothing");

        vm.prank(human);
        (uint256 sIn, uint256 sOut,) = router.swap(order, 10_000e6, td);

        assertEq(sIn, qIn, "amountIn diverged");
        assertEq(sOut, qOut, "amountOut diverged");
    }

    // ===== program B: tiered pricing =====

    /// @notice Verified takers pay 0.05%; everyone else pays 0.30%.
    /// @dev Both tiers draw on the *same* shipped balance — the whole point of
    /// building this on Aqua rather than two pools.
    function test_tiered_humanPaysLessThanBot() public {
        ISwapVM.Order memory order = _createOrder(_tieredProgram(9));
        _shipDefault(SwapVM(payable(address(router))), order);

        uint256 amountIn = 10_000e6;
        bytes memory humanTd = _takerData(human, true, false, _validProofFor(human, 9));
        bytes memory botTd = _takerData(bot, true, false, "");

        // asView() before the prank -- see FRICTION F-13.
        ISwapVM view_ = router.asView();
        vm.prank(human);
        (, uint256 humanOut,) = view_.quote(order, amountIn, humanTd);
        vm.prank(bot);
        (, uint256 botOut,) = view_.quote(order, amountIn, botTd);

        assertGt(humanOut, botOut, "verified taker should receive more");

        // Difference is exactly the fee gap: (1-0.0005) vs (1-0.003).
        uint256 expected = (botOut * (FEE_DENOMINATOR - HUMAN_FEE)) / (FEE_DENOMINATOR - OPEN_FEE);
        assertApproxEqRel(humanOut, expected, 1e14, "tier gap is not 30bps vs 5bps");
    }

    /// @notice An unverified taker is served, not rejected, by the tiered program.
    function test_tiered_botStillSwapsAtOpenPrice() public {
        ISwapVM.Order memory order = _createOrder(_tieredProgram(10));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), bot, USDC, 10_000e6);

        vm.prank(bot);
        (, uint256 out,) = router.swap(order, 10_000e6, _takerData(bot, true, false, ""));
        assertGt(out, 0, "tiered program must still serve unverified takers");
    }

    /// @notice A malformed proof degrades to the open tier rather than reverting.
    /// @dev Deliberate: 0x33 powers a discount, not a gate. Programs that must
    /// reject use 0x27, which is asserted above to revert.
    function test_tiered_badProofFallsThroughInsteadOfReverting() public {
        ISwapVM.Order memory order = _createOrder(_tieredProgram(11));
        _shipDefault(SwapVM(payable(address(router))), order);
        _fundTaker(address(router), bot, USDC, 20_000e6);

        // Deliberately NOT registered with the mock, so verification fails.
        // Must use _unregisteredProof: _proof() registers the tuple as a side
        // effect, which would silently make this "bad" proof a good one.
        bytes memory bogus = _unregisteredProof(999, 999, uint64(block.timestamp + 300));

        // Quote both against the SAME untouched curve. Swapping twice would move
        // the pool between measurements and the comparison would be meaningless.
        ISwapVM view_ = router.asView();
        vm.prank(bot);
        (, uint256 bogusOut,) = view_.quote(order, 10_000e6, _takerData(bot, true, false, bogus));
        vm.prank(bot);
        (, uint256 plainOut,) = view_.quote(order, 10_000e6, _takerData(bot, true, false, ""));

        assertGt(bogusOut, 0, "bad proof should not revert the tiered program");
        assertEq(bogusOut, plainOut, "bad proof must price exactly as the open tier");

        // And it really does execute, not just quote.
        vm.prank(bot);
        (, uint256 executed,) = router.swap(order, 10_000e6, _takerData(bot, true, false, bogus));
        assertEq(executed, bogusOut, "swap diverged from quote");
    }

    // ===== program layout =====

    /// @notice Pins the byte offsets program B's jumps depend on.
    /// @dev The jump targets are absolute, so any change to an earlier
    /// instruction's argument length silently retargets them. This fails first
    /// and points at the cause, instead of surfacing as a mispriced swap.
    function test_programBLayoutIsIntact() public pure {
        bytes memory p = _tieredProgramLayoutProbe();
        assertEq(uint8(p[0]), 0x33, "guard must be first");
        assertEq(uint8(p[1]), 42, "guard args length");
        assertEq(uint8(p[44]), 0x70, "open fee at 44");
        assertEq(uint8(p[50]), 0x03, "jump at 50");
        assertEq(uint8(p[54]), 0x70, "human fee at 54 (jump target)");
        assertEq(uint8(p[60]), 0x50, "XYCSwap at 60 (shared tail)");
    }

    // ===== helpers =====

    function _tieredProgramLayoutProbe() private pure returns (bytes memory) {
        return _tieredProgramPure(0);
    }

    function _tieredProgramPure(uint256 salt) private pure returns (bytes memory) {
        return _tieredProgramInline(salt);
    }

    function _tieredProgramInline(uint256 salt) private pure returns (bytes memory) {
        // Mirrors WorldChainForkBase._tieredProgram; duplicated as `pure` so the
        // layout assertion needs no fork.
        return abi.encodePacked(
            uint8(0x33),
            uint8(42),
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

    function _nullifier(uint256 seed) private pure returns (uint256) {
        return uint256(keccak256(abi.encode("nullifier", seed)));
    }

    function _nonce(uint256 seed) private pure returns (uint256) {
        return uint256(keccak256(abi.encode("nonce", seed)));
    }

    function _validProofFor(address taker, uint256 seed) private returns (bytes memory) {
        return _proof(taker, _nullifier(seed), _nonce(seed), uint64(block.timestamp + 300));
    }

    function _validProofFor(address taker, uint256 seed, uint64 expiry) private returns (bytes memory) {
        return _proof(taker, _nullifier(seed), _nonce(seed), expiry);
    }

    /// @dev Registers the tuple with the mock and returns the matching payload.
    /// `signalHash` is what the guard will derive from `taker`, so registering
    /// for one address and swapping from another must fail — which is exactly
    /// what `test_humanOnly_proofBoundToAnotherAddressIsRejected` asserts.
    function _proof(address taker, uint256 nullifier, uint256 nonce, uint64 expiresAtMin)
        private
        returns (bytes memory)
    {
        return _proofWithAction(taker, nullifier, nonce, expiresAtMin, ACTION);
    }

    /// @dev Registers under `action`'s own field element, so the mock accepts the
    /// proof only for the action the taker actually names. That matters for the
    /// prefix tests: registering under ACTION while sending a suffixed action would
    /// pass the prefix check and then fail verification, testing the wrong thing.
    function _proofWithAction(
        address taker,
        uint256 nullifier,
        uint256 nonce,
        uint64 expiresAtMin,
        string memory action
    ) private returns (bytes memory) {
        uint256[5] memory zk =
            [uint256(0xaaa1), uint256(0xbbb2), uint256(0xccc3), uint256(0xddd4), uint256(0xeee5)];

        verifier.accept(
            nullifier,
            bytes(action).hashToField(),
            RP_ID,
            nonce,
            abi.encodePacked(taker).hashToField(),
            expiresAtMin,
            SCHEMA_PROOF_OF_HUMAN,
            0,
            zk
        );

        return WorldIdGuardArgsBuilder.buildProof(nullifier, nonce, expiresAtMin, zk, action);
    }

    /// @dev A well-formed payload the verifier has never seen. Separate from
    /// `_proof` because that one registers with the mock as a side effect —
    /// calling it for a "bad proof" case would quietly test the opposite of
    /// what was intended.
    function _unregisteredProof(uint256 nullifier, uint256 nonce, uint64 expiresAtMin)
        private
        pure
        returns (bytes memory)
    {
        uint256[5] memory zk =
            [uint256(0xdead1), uint256(0xdead2), uint256(0xdead3), uint256(0xdead4), uint256(0xdead5)];
        return WorldIdGuardArgsBuilder.buildProof(nullifier, nonce, expiresAtMin, zk, ACTION);
    }

    function _sliceOff(bytes memory data, uint256 drop) private pure returns (bytes memory out) {
        out = new bytes(data.length - drop);
        for (uint256 i; i < out.length; ++i) {
            out[i] = data[i];
        }
    }
}
