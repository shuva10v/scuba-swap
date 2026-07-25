// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DemoToken
/// @notice A worthless, freely-mintable ERC20 for the ScubaSwap demo.
///
/// @dev Deployed instead of using canonical WETH/USDC so that a first live
/// deployment risks nothing. The maker has to grant Aqua an allowance to ship
/// liquidity, and an allowance is only ever as dangerous as the token behind it —
/// with these, a mistake costs nothing.
///
/// `mint` is deliberately permissionless. There is no supply to protect, and
/// gating it would only add a way for the demo to get stuck. Nothing here is
/// suitable for anything other than a demo, which the name and symbol are chosen
/// to make obvious in a block explorer.
contract DemoToken is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    /// @dev Mirrors the real pair the demo imitates: 18dp for the WETH side, 6dp
    /// for the USDC side. Keeping the mismatch matters — it is what surfaced the
    /// decimals assumptions in the invariant suite (FRICTION F-14), and a demo on
    /// two 18dp tokens would quietly hide that class of bug.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Anyone can mint. See the contract notes.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
