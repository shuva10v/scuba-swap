// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title ByteHasher
/// @notice Reduces arbitrary bytes to a BN254 field element, the way World ID does.
/// @dev Verbatim the helper World ID ships in every integration template. Kept
/// as our own copy rather than pulled from a package because the whole point of
/// `test/WorldIdEncoding.t.sol` is to pin this function against externally
/// produced values — a dependency bump silently changing it is exactly the
/// failure we are guarding against.
library ByteHasher {
    /// @dev Creates a keccak256 hash of `value` reduced to a field element.
    /// @param value Bytes to hash.
    /// @return The hash, right-shifted 8 bits so it always fits BN254's scalar
    /// field (modulus ~2.188e76). Skipping the shift is not a rounding detail:
    /// a full 256-bit keccak routinely exceeds the modulus and the World ID
    /// verifier rejects it outright. See FRICTION W-05.
    function hashToField(bytes memory value) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(value))) >> 8;
    }
}
