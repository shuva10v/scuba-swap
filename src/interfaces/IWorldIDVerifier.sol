// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title IWorldIDVerifier
/// @notice World ID 4.0 uniqueness verifier.
/// @dev Deployed on World Chain only (chainid 480), as an upgradeable proxy:
///   production  0x00000000009E00F9FE82CfeeBB4556686da094d7
///   staging     0x703a6316c975DEabF30b637c155edD53e24657DB
/// There is no v4 verifier on Ethereum, Optimism, Base or Polygon — which is
/// why ScubaSwap deploys its own Aqua on a World Chain fork. See FRICTION W-07.
interface IWorldIDVerifier {
    /// @notice Verifies a v4 uniqueness proof. Reverts on failure, returns nothing.
    ///
    /// @dev Every parameter is a public input committed into the proof: change
    /// any one of them by a single bit and verification reverts `ProofInvalid()`.
    ///
    /// Two traps, both measured against the live verifiers:
    ///
    /// 1. `action` must be `hashToField(actionString)`, i.e.
    ///    `uint256(keccak256(bytes(action))) >> 8`. The docs say plain
    ///    `keccak256`, which exceeds the BN254 modulus and reverts
    ///    `InvalidAction()` (0x4a7f394f). See FRICTION W-05 and
    ///    worldcoin/developer-docs#147.
    ///
    /// 2. `expiresAtMin` is committed but **never compared to
    ///    `block.timestamp`**. Proofs verify indefinitely past their own expiry.
    ///    Freshness is the caller's responsibility. See FRICTION W-06.
    ///
    /// @param nullifier    Per-(identity, rpId, action) pseudonymous identifier.
    /// @param action       `hashToField(actionString)` — NOT plain keccak256.
    /// @param rpId         uint64 of the hex tail of the `rp_...` Dev Portal ID.
    /// @param nonce        Top-level `nonce` from the IDKit response.
    /// @param signalHash   `responses[i].signal_hash`, forwarded verbatim.
    /// @param expiresAtMin `responses[i].expires_at_min`. NOT enforced here.
    /// @param issuerSchemaId `responses[i].issuer_schema_id` (1 = Proof of Human).
    /// @param credentialGenesisIssuedAtMin Request constraint; 0 if unconstrained.
    /// @param zeroKnowledgeProof `responses[i].proof` — 4 compressed proof
    ///        elements followed by the Merkle root at index 4.
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
    ) external view;
}
