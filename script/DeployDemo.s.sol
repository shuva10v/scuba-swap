// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

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
/// @dev Deploys Aqua because World Chain has none — see FRICTION W-07. Points
/// the router at the **staging** World ID verifier by default: staging proofs
/// come from the simulator, so the demo can be driven without an Orb. Override
/// with `WORLD_ID_VERIFIER=0x0000...94d7` for production.
///
/// Expects the broadcaster to already hold WETH and USDC — `script/demo-up.sh`
/// arranges that against anvil. Run:
///
///     forge script script/DeployDemo.s.sol --rpc-url http://localhost:8545 \
///       --broadcast --unlocked --sender <maker>
contract DeployDemo is Script {
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x79A02482A880bCE3F13e09Da970dC34db4CD24d1;
    address internal constant WORLD_ID_V4_STAGING = 0x703a6316c975DEabF30b637c155edD53e24657DB;

    uint32 internal constant OPEN_FEE = 3_000_000; // 0.30%
    uint32 internal constant HUMAN_FEE = 500_000; //  0.05%
    uint64 internal constant SCHEMA_PROOF_OF_HUMAN = 1;

    // tokenA < tokenB is required by MakerTraits; on World Chain WETH sorts first.
    address internal constant TOKEN_A = WETH;
    address internal constant TOKEN_B = USDC;

    uint256 internal constant SHIP_WETH = 100e18;
    uint256 internal constant SHIP_USDC = 400_000e6;

    function run() external {
        address maker = msg.sender;
        IWorldIDVerifier verifier = IWorldIDVerifier(vm.envOr("WORLD_ID_VERIFIER", WORLD_ID_V4_STAGING));
        string memory action = vm.envOr("WORLD_ID_ACTION", string("world-demo-v2"));
        uint64 rpId = uint64(vm.envOr("WORLD_ID_RP_ID", uint256(3_180_554_207_396_540_622)));

        require(IERC20(WETH).balanceOf(maker) >= SHIP_WETH, "maker has no WETH - run script/demo-up.sh first");
        require(IERC20(USDC).balanceOf(maker) >= SHIP_USDC, "maker has no USDC - run script/demo-up.sh first");

        vm.startBroadcast();

        Aqua aqua = new Aqua();
        ScubaSwapVMRouter router =
            new ScubaSwapVMRouter(address(aqua), WETH, maker, "ScubaSwapVM", "1", verifier, action, rpId);

        IERC20(WETH).approve(address(aqua), type(uint256).max);
        IERC20(USDC).approve(address(aqua), type(uint256).max);

        // One salt each, fixed, so re-running the script is idempotent per chain.
        ISwapVM.Order memory open = _order(maker, _openProgram(1));
        ISwapVM.Order memory tiered = _order(maker, _tieredProgram(2));
        ISwapVM.Order memory humanOnly = _order(maker, _humanOnlyProgram(3));

        bytes32 hOpen = _ship(aqua, address(router), open);
        bytes32 hTiered = _ship(aqua, address(router), tiered);
        bytes32 hHuman = _ship(aqua, address(router), humanOnly);

        vm.stopBroadcast();

        _write(address(aqua), address(router), address(verifier), action, rpId, maker, open, tiered, humanOnly, hOpen, hTiered, hHuman);

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

    function _order(address maker, bytes memory program) internal pure returns (ISwapVM.Order memory) {
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

    function _ship(Aqua aqua, address router, ISwapVM.Order memory order) internal returns (bytes32) {
        return aqua.ship(router, abi.encode(order), dynamic([TOKEN_A, TOKEN_B]), dynamic([SHIP_WETH, SHIP_USDC]));
    }

    function _write(
        address aqua,
        address router,
        address verifier,
        string memory action,
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
        vm.serializeString(root, "worldIdAction", action);
        vm.serializeUint(root, "worldIdRpId", rpId);
        vm.serializeAddress(root, "maker", maker);
        vm.serializeAddress(root, "weth", WETH);
        vm.serializeAddress(root, "usdc", USDC);
        string memory out = vm.serializeString(root, "programs", programsJson);

        vm.writeJson(out, "./deployments/demo.json");
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
