// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";

import { ByteHasher } from "../src/helpers/ByteHasher.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraits, MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { dynamic } from "@1inch/swap-vm/test/utils/Dynamic.sol";

import { ScubaSwapVMRouter } from "../src/routers/ScubaSwapVMRouter.sol";
import { IWorldIDVerifier } from "../src/interfaces/IWorldIDVerifier.sol";
import { WorldIdGuardArgsBuilder } from "../src/instructions/WorldIdGuard.sol";
import { SCUBA_OP_ONLY_HUMAN_TAKER, SCUBA_OP_JUMP_IF_HUMAN } from "../src/opcodes/ScubaOpcodes.sol";

/// @title DeployDemo
/// @notice Stands up the full ScubaSwap demo on a World Chain fork and writes
/// `deployments/demo.json` for the frontend to consume.
///
/// @dev Aqua and the router are deployed **before** this script runs, with
/// `forge create`, and passed in via `AQUA_ADDRESS` / `ROUTER_ADDRESS`.
///
/// That split is not stylistic. `forge script` cannot broadcast the router's
/// CREATE: it fails to locate the constructor arguments inside `via_ir` init code
/// and aborts with `type check failed for "offset (usize)"` — *after* the script
/// body has already written demo.json, so the config names an address that was
/// never deployed. `via_ir` is not optional either (SwapVM hits "stack too deep"
/// without it), so the CREATEs move out and this script only broadcasts CALLs,
/// which decode fine.
///
/// Expects the broadcaster to already hold WETH and USDC — `script/demo-up.sh`
/// arranges all of it.
contract DeployDemo is Script {
    using ByteHasher for bytes;

    /// @dev WETH is only needed for SwapVM's unwrap support, never for the pair.
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant WORLD_ID_V4_STAGING = 0x703a6316c975DEabF30b637c155edD53e24657DB;

    uint32 internal constant OPEN_FEE = 3_000_000; // 0.30%
    uint32 internal constant HUMAN_FEE = 500_000; //  0.05%
    uint64 internal constant SCHEMA_PROOF_OF_HUMAN = 1;

    // MakerTraits requires tokenA < tokenB numerically, and freshly deployed demo
    // tokens land at arbitrary addresses — so the caller sorts them and passes
    // them in already ordered. Deriving the order here from a hardcoded pair was
    // what produced MakerTraitsTokensNotSorted when the chain changed.
    address internal tokenA;
    address internal tokenB;
    uint256 internal shipA;
    uint256 internal shipB;

    function run() external {
        address maker = msg.sender;

        tokenA = vm.envAddress("TOKEN_A");
        tokenB = vm.envAddress("TOKEN_B");
        shipA = vm.envUint("SHIP_A");
        shipB = vm.envUint("SHIP_B");
        require(tokenA < tokenB, "TOKEN_A must sort before TOKEN_B");
        IWorldIDVerifier verifier = IWorldIDVerifier(vm.envOr("WORLD_ID_VERIFIER", WORLD_ID_V4_STAGING));
        string memory actionPrefix = vm.envOr("WORLD_ID_ACTION_PREFIX", string("scubaswap"));
        uint64 rpId = uint64(vm.envOr("WORLD_ID_RP_ID", uint256(15578405237850119539)));

        require(IERC20(tokenA).balanceOf(maker) >= shipA, "maker balance too low for tokenA");
        require(IERC20(tokenB).balanceOf(maker) >= shipB, "maker balance too low for tokenB");

        Aqua aqua = Aqua(vm.envAddress("AQUA_ADDRESS"));
        ScubaSwapVMRouter router = ScubaSwapVMRouter(payable(vm.envAddress("ROUTER_ADDRESS")));

        // Fail loudly rather than shipping against an address with no code, which
        // would surface much later as an unexplained revert in the frontend.
        require(address(aqua).code.length > 0, "AQUA_ADDRESS has no code");
        require(address(router).code.length > 0, "ROUTER_ADDRESS has no code");
        require(
            router.WORLD_ID_ACTION_PREFIX_HASH() == keccak256(bytes(actionPrefix)),
            "router action prefix != WORLD_ID_ACTION_PREFIX"
        );
        require(router.WORLD_ID_RP_ID() == rpId, "router rpId != WORLD_ID_RP_ID");

        vm.startBroadcast();

        IERC20(tokenA).approve(address(aqua), type(uint256).max);
        IERC20(tokenB).approve(address(aqua), type(uint256).max);

        // One salt each, fixed, so re-running the script is idempotent per chain.
        ISwapVM.Order memory open = _order(maker, _openProgram(1));
        ISwapVM.Order memory tiered = _order(maker, _tieredProgram(2));
        ISwapVM.Order memory humanOnly = _order(maker, _humanOnlyProgram(3));

        bytes32 hOpen = _ship(aqua, address(router), open);
        bytes32 hTiered = _ship(aqua, address(router), tiered);
        bytes32 hHuman = _ship(aqua, address(router), humanOnly);

        vm.stopBroadcast();

        _write(address(aqua), address(router), address(verifier), actionPrefix, rpId, maker, open, tiered, humanOnly, hOpen, hTiered, hHuman);

        console.log("Aqua    ", address(aqua));
        console.log("Router  ", address(router));
        console.log("Verifier", address(verifier));
        console.log("wrote deployments/demo.json");
    }

    // ===== programs (mirrors test/fork/WorldChainForkBase.t.sol) =====

    function _openProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(hex"70", uint8(4), OPEN_FEE, hex"5000", hex"02", uint8(32), bytes32(salt));
    }

    function _humanOnlyProgram(uint256 salt) internal pure returns (bytes memory) {
        return abi.encodePacked(
            uint8(SCUBA_OP_ONLY_HUMAN_TAKER),
            uint8(WorldIdGuardArgsBuilder.POLICY_LENGTH),
            WorldIdGuardArgsBuilder.buildPolicy(SCHEMA_PROOF_OF_HUMAN, 0),
            hex"70",
            uint8(4),
            HUMAN_FEE,
            hex"5000",
            hex"02",
            uint8(32),
            bytes32(salt)
        );
    }

    /// @dev Jump targets are absolute byte offsets — see docs/PROGRAMS.md.
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

    // ===== helpers =====

    function _order(address maker, bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
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

    /// @dev The pair is always one 18dp token against one 6dp token — the mismatch
    /// is deliberate (FRICTION F-14). Returns `(18dp side, other side)`, and refuses
    /// to guess if both sides carry the same decimals, since then the "which one is
    /// WETH" question has no answer to read off-chain and a wrong guess is worse
    /// than a failed deploy.
    function _byDecimals() internal view returns (address base, address quote) {
        uint8 dA = IERC20Metadata(tokenA).decimals();
        uint8 dB = IERC20Metadata(tokenB).decimals();
        require(dA != dB, "pair decimals are equal; cannot infer base/quote");
        return dA > dB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    function _ship(Aqua aqua, address router, ISwapVM.Order memory order) internal returns (bytes32) {
        return aqua.ship(router, abi.encode(order), dynamic([tokenA, tokenB]), dynamic([shipA, shipB]));
    }

    function _write(
        address aqua,
        address router,
        address verifier,
        string memory actionPrefix,
        uint64 rpId,
        address maker,
        ISwapVM.Order memory open,
        ISwapVM.Order memory tiered,
        ISwapVM.Order memory humanOnly,
        bytes32 hOpen,
        bytes32 hTiered,
        bytes32 hHuman
    ) internal {
        // Built with the serializeX cheatcodes rather than string.concat so the
        // output is valid JSON by construction — an Order's `data` is arbitrary
        // bytes and hand-quoting it is a good way to emit something unparseable.
        string memory programs = "programs";
        vm.serializeString(programs, "open", _programJson("p_open", open, hOpen));
        vm.serializeString(programs, "tiered", _programJson("p_tiered", tiered, hTiered));
        string memory programsJson = vm.serializeString(programs, "humanOnly", _programJson("p_human", humanOnly, hHuman));

        string memory root = "root";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeAddress(root, "aqua", aqua);
        vm.serializeAddress(root, "router", router);
        vm.serializeAddress(root, "worldIdVerifier", verifier);
        vm.serializeString(root, "worldIdActionPrefix", actionPrefix);
        // Serialised as a string, not a number: a uint64 rp_id exceeds
        // JavaScript's MAX_SAFE_INTEGER, and JSON.parse would round it. It is
        // displayed and compared in the frontend, so a silently wrong value is
        // worse than an inconvenient type.
        vm.serializeString(root, "worldIdRpId", Strings.toString(uint256(rpId)));
        vm.serializeAddress(root, "maker", maker);

        // The RPC this deployment lives on, recorded alongside it.
        //
        // The frontend used to default to localhost with the config supplied
        // separately, so a mainnet config read over a localhost RPC was a two-line
        // mistake that produced a page where nothing worked and nothing said why.
        // chainId cannot disambiguate — an anvil fork of World Chain also reports 480.
        vm.serializeString(root, "rpcUrl", vm.envOr("DEPLOYMENT_RPC_URL", string("")));
        vm.serializeAddress(root, "tokenA", tokenA);
        vm.serializeAddress(root, "tokenB", tokenB);

        // `weth`/`usdc` are the *roles* — the 18dp side sold and the 6dp side
        // received — and they are emitted independently of the A/B sort order.
        //
        // These used to be aliases for tokenA/tokenB, which was silently correct
        // only as long as the pair sorted the way the hardcoded one did. Freshly
        // deployed demo tokens land at arbitrary addresses, so the order is a coin
        // flip: on the first live rehearsal the 6dp token sorted first and the
        // config labelled it `weth`, which would have had the frontend sell 6dp
        // dUSDC under a WETH label and quote 1e15 for it. Read the decimals and
        // let the tokens answer for themselves.
        (address base, address quote) = _byDecimals();
        vm.serializeAddress(root, "weth", base);
        vm.serializeAddress(root, "usdc", quote);
        vm.serializeUint(root, "baseDecimals", IERC20Metadata(base).decimals());
        vm.serializeUint(root, "quoteDecimals", IERC20Metadata(quote).decimals());
        string memory out = vm.serializeString(root, "programs", programsJson);

        // Configurable so a live deployment does not overwrite the local demo's
        // config, and so both can coexist on disk.
        vm.writeJson(out, string.concat("./", vm.envOr("DEPLOYMENT_OUT", string("deployments/demo.json"))));
    }

    function _programJson(string memory key, ISwapVM.Order memory order, bytes32 hash)
        internal
        returns (string memory)
    {
        vm.serializeBytes32(key, "orderHash", hash);
        vm.serializeAddress(key, "maker", order.maker);
        // `traits` is a user-defined value type over uint256, so it needs
        // unwrapping before the cheatcode can pick an overload.
        vm.serializeUint(key, "traits", MakerTraits.unwrap(order.traits));
        return vm.serializeBytes(key, "data", order.data);
    }
}
