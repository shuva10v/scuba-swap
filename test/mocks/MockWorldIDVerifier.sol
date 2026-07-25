// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IWorldIDVerifier } from "../../src/interfaces/IWorldIDVerifier.sol";

/// @title MockWorldIDVerifier
/// @notice Stand-in for World ID's `WorldIDVerifier`, used wherever a test needs
/// more than one valid proof.
///
/// @dev Deliberately **not** an always-accept mock. It keys on the full tuple of
/// public inputs and rejects anything not registered, which mirrors how the real
/// verifier behaves: every parameter is committed into the proof, so changing any
/// one of them by a single bit reverts. An always-accept mock would let a guard
/// that derives `signalHash` incorrectly — or ignores `nonce` entirely — sail
/// through the whole suite.
///
/// What it cannot reproduce is the cryptography itself. That gap is covered from
/// two directions: `test/WorldIdEncoding.t.sol` pins our hashing against
/// externally produced vectors, and the World Chain fork suite runs a real
/// fixture against the live staging verifier.
///
/// It is needed because a real proof is single-use by construction, while the
/// invariant and multi-swap tests need many.
contract MockWorldIDVerifier is IWorldIDVerifier {
    /// @dev Same selector as the real verifier's rejection, so tests asserting
    /// on it stay meaningful when pointed at either.
    error ProofInvalid();

    mapping(bytes32 => bool) public accepted;

    /// @notice Register one tuple of public inputs as verifiable.
    function accept(
        uint256 nullifier,
        uint256 action,
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256[5] calldata zeroKnowledgeProof
    ) external {
        accepted[_key(
            nullifier,
            action,
            rpId,
            nonce,
            signalHash,
            expiresAtMin,
            issuerSchemaId,
            credentialGenesisIssuedAtMin,
            zeroKnowledgeProof
        )] = true;
    }

    /// @inheritdoc IWorldIDVerifier
    function verify(
        uint256 nullifier,
        uint256 action,
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256[5] calldata zeroKnowledgeProof
    ) external view {
        if (
            !accepted[_key(
                nullifier,
                action,
                rpId,
                nonce,
                signalHash,
                expiresAtMin,
                issuerSchemaId,
                credentialGenesisIssuedAtMin,
                zeroKnowledgeProof
            )]
        ) {
            revert ProofInvalid();
        }
    }

    /// @dev Note this does NOT compare `expiresAtMin` against `block.timestamp`
    /// — matching the real verifier, which also does not. Enforcing freshness is
    /// the integrating contract's job, and the mock must not paper over that or
    /// the guard's own expiry check would go untested. See FRICTION W-06.
    function _key(
        uint256 nullifier,
        uint256 action,
        uint64 rpId,
        uint256 nonce,
        uint256 signalHash,
        uint64 expiresAtMin,
        uint64 issuerSchemaId,
        uint256 credentialGenesisIssuedAtMin,
        uint256[5] calldata zeroKnowledgeProof
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                nullifier,
                action,
                rpId,
                nonce,
                signalHash,
                expiresAtMin,
                issuerSchemaId,
                credentialGenesisIssuedAtMin,
                zeroKnowledgeProof
            )
        );
    }
}
