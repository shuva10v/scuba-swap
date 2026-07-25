// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Minimal view of `DemoToken`. Declared locally rather than importing the token so
/// the faucet can front any mintable demo token, including one deployed later.
interface IMintableDemoToken {
    function mint(address to, uint256 amount) external;
    function decimals() external view returns (uint8);
}

/// @title DemoFaucet
/// @notice Hands out a fixed amount of a demo token, once per cooldown per address, so a
/// visitor can get something to trade with.
///
/// @dev **The cooldown is a fairness guard, not a security boundary.** `DemoToken.mint` is
/// deliberately permissionless and unlimited, so anyone who wants more can call it
/// directly and ignore this contract entirely. That is fine — the tokens are worthless by
/// construction and exist so a first live deployment risks nothing — but it means the
/// limit should not be described as enforcement. What it actually buys is a UI that can
/// offer a claim button without inviting one visitor to mint a quintillion tokens and
/// distort the demo curve for everyone else.
///
/// Deliberately not gated on a World ID proof. Requiring one would invert the demo: you
/// would need tokens to try the guard, and a proof to get tokens. The faucet is the step
/// *before* the interesting part.
///
/// Holds no balance and needs no funding — it mints on demand, which also means it cannot
/// run dry mid-demo.
contract DemoFaucet {
    /// @notice The token handed out.
    IMintableDemoToken public immutable TOKEN;
    /// @notice How much per claim, in the token's own units.
    uint256 public immutable AMOUNT;
    /// @notice How long an address must wait between claims.
    uint256 public immutable COOLDOWN;

    /// @notice When each address last claimed. Zero means never.
    mapping(address claimant => uint256 at) public lastClaim;

    /// @notice Emitted on every successful claim, so the faucet's use is auditable
    /// without indexing token transfers from a mint.
    event Claimed(address indexed claimant, uint256 amount);

    /// @dev Carries the timestamp the caller can next claim at, so a client can render a
    /// countdown from the revert rather than making a second call to find out.
    error ClaimTooSoon(uint256 availableAt);

    constructor(IMintableDemoToken token, uint256 amount, uint256 cooldown) {
        require(address(token) != address(0), "token is the zero address");
        require(amount > 0, "amount is zero");
        TOKEN = token;
        AMOUNT = amount;
        COOLDOWN = cooldown;
    }

    /// @notice Claim `AMOUNT` for the caller.
    ///
    /// @dev Credits `msg.sender`, never an arbitrary recipient. A `claimFor(address)` would
    /// let one caller burn every address's cooldown without their involvement, which is
    /// the only griefing this contract is exposed to.
    function claim() external {
        uint256 at = claimableAt(msg.sender);
        require(block.timestamp >= at, ClaimTooSoon(at));

        // Written before the external call. The token is one we deployed and `mint` does
        // not call back, but ordering the state change first costs nothing and means a
        // reentrant token could not drain the cooldown.
        lastClaim[msg.sender] = block.timestamp;

        TOKEN.mint(msg.sender, AMOUNT);
        emit Claimed(msg.sender, AMOUNT);
    }

    /// @notice The timestamp `claimant` may next claim at. Zero-cooldown-safe, and returns
    /// a past timestamp (or 0) for an address that has never claimed.
    function claimableAt(address claimant) public view returns (uint256) {
        uint256 last = lastClaim[claimant];
        return last == 0 ? 0 : last + COOLDOWN;
    }

    /// @notice Convenience for the UI: seconds until `claimant` may claim, 0 if now.
    function waitFor(address claimant) external view returns (uint256) {
        uint256 at = claimableAt(claimant);
        return block.timestamp >= at ? 0 : at - block.timestamp;
    }
}
