// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { DemoToken } from "../src/demo/DemoToken.sol";
import { DemoFaucet, IMintableDemoToken } from "../src/demo/DemoFaucet.sol";

/// @title DemoFaucetTest
/// @notice The cooldown is the only logic here, so it is tested at its edges: the exact
/// boundary second, one second early, and the transition back to claimable.
contract DemoFaucetTest is Test {
    DemoToken internal token;
    DemoFaucet internal faucet;

    uint256 internal constant AMOUNT = 1e18;
    uint256 internal constant COOLDOWN = 1 hours;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        token = new DemoToken("ScubaSwap Demo WETH", "dWETH", 18);
        faucet = new DemoFaucet(IMintableDemoToken(address(token)), AMOUNT, COOLDOWN);
        // Start away from zero, or `lastClaim == 0` and "claimed at block 0" would be
        // indistinguishable and the never-claimed path would pass vacuously.
        vm.warp(1_700_000_000);
    }

    function test_firstClaimSucceeds() public {
        vm.prank(alice);
        faucet.claim();

        assertEq(token.balanceOf(alice), AMOUNT, "did not receive the claim");
        assertEq(faucet.lastClaim(alice), block.timestamp, "claim not recorded");
    }

    /// @dev The faucet holds no balance and mints on demand, so it cannot run dry — worth
    /// asserting because a pre-funded faucet is the usual design and would.
    function test_faucetHoldsNoBalance() public {
        vm.prank(alice);
        faucet.claim();
        assertEq(token.balanceOf(address(faucet)), 0, "faucet should never hold tokens");
        assertEq(token.totalSupply(), AMOUNT, "claim should mint, not transfer");
    }

    function test_secondClaimWithinCooldownReverts() public {
        vm.prank(alice);
        faucet.claim();

        uint256 at = faucet.claimableAt(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.ClaimTooSoon.selector, at));
        faucet.claim();

        assertEq(token.balanceOf(alice), AMOUNT, "balance changed on a rejected claim");
    }

    /// @dev One second before the boundary. Catches a `>` written where `>=` belongs, which
    /// a mid-cooldown test would not.
    function test_claimOneSecondEarlyReverts() public {
        vm.prank(alice);
        faucet.claim();

        vm.warp(block.timestamp + COOLDOWN - 1);
        // Hoisted, and this is not style. `claimableAt` is an external call, so evaluating
        // it inside the expectRevert argument arms the cheatcode and *then* makes a call
        // that does not revert — expectRevert binds to that and the test fails with
        // "next call did not revert". Exactly the trap logged as FRICTION F-13; it caught
        // this file too.
        uint256 at = faucet.claimableAt(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoFaucet.ClaimTooSoon.selector, at));
        faucet.claim();
    }

    /// @dev And exactly on it, which must succeed.
    function test_claimExactlyAtCooldownSucceeds() public {
        vm.prank(alice);
        faucet.claim();

        vm.warp(faucet.claimableAt(alice));
        vm.prank(alice);
        faucet.claim();

        assertEq(token.balanceOf(alice), AMOUNT * 2, "second claim did not land");
    }

    /// @dev The cooldown is per address. One claimant must not block another — the whole
    /// point is that any visitor can get tokens.
    function test_cooldownIsPerAddress() public {
        vm.prank(alice);
        faucet.claim();

        vm.prank(bob);
        faucet.claim();

        assertEq(token.balanceOf(bob), AMOUNT, "bob was blocked by alice's cooldown");
    }

    function test_waitForCountsDownAndReachesZero() public {
        assertEq(faucet.waitFor(alice), 0, "a fresh address should be able to claim now");

        vm.prank(alice);
        faucet.claim();
        assertEq(faucet.waitFor(alice), COOLDOWN, "full cooldown expected immediately after");

        vm.warp(block.timestamp + COOLDOWN / 2);
        assertEq(faucet.waitFor(alice), COOLDOWN / 2, "half the cooldown expected halfway");

        vm.warp(block.timestamp + COOLDOWN);
        assertEq(faucet.waitFor(alice), 0, "should be claimable again");
    }

    /// @dev A never-claimed address reports 0, not a timestamp in the past that a client
    /// would have to interpret.
    function test_neverClaimedIsImmediatelyClaimable() public view {
        assertEq(faucet.claimableAt(bob), 0, "never-claimed should be 0");
        assertEq(faucet.waitFor(bob), 0, "never-claimed should not wait");
    }

    function test_constructorRejectsNonsense() public {
        vm.expectRevert(bytes("token is the zero address"));
        new DemoFaucet(IMintableDemoToken(address(0)), AMOUNT, COOLDOWN);

        vm.expectRevert(bytes("amount is zero"));
        new DemoFaucet(IMintableDemoToken(address(token)), 0, COOLDOWN);
    }

    /// @notice Documents that the cooldown is not a supply limit.
    ///
    /// @dev `DemoToken.mint` is permissionless by design, so anyone can bypass the faucet
    /// entirely. Asserted rather than only commented, so that if the token is ever locked
    /// down this test fails and the faucet's docs get revisited with it.
    function test_cooldownIsNotASupplyLimit() public {
        vm.prank(alice);
        faucet.claim();

        vm.prank(alice);
        token.mint(alice, 500e18); // straight past the faucet

        assertEq(token.balanceOf(alice), AMOUNT + 500e18, "mint should be permissionless");
    }
}
