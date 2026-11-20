// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {IPqAttestationVerifier} from "./IPqAttestationVerifier.sol";

/// @title MerkleWotsAttestationVerifier
/// @notice A hash-based, post-quantum attestation check that costs about as much as an ERC-20 transfer: WOTS+
///         one-time signatures (Winternitz, w = 16) on keccak256, their public keys gathered under a Merkle root, the
///         construction of XMSS (RFC 8391) with Ethereum's own hash.
/// @dev Security rests on keccak256 alone (second preimage and one-wayness), which a quantum computer weakens only
///      by Grover's square root: about 128-bit security. Every hash is tweaked with the key seed and its position
///      (leaf, chain, step or tree height and index), as in SPHINCS+'s simple tweakable hash, so an attacker cannot
///      attack all chains at once.
///
///      Stateful, like XMSS: each leaf signs one digest, ever. This contract enforces it on chain: a leaf is
///      accepted only above the last one used. Signing one leaf twice is the only way to break the scheme, and the
///      chain makes it impossible for two signatures of one leaf to both count.
///
///      Signature: abi.encode(uint32 leaf, bytes32[67] chains, bytes32[] authPath).
contract MerkleWotsAttestationVerifier is IPqAttestationVerifier {
    uint256 public constant W = 16;
    uint256 public constant LEN1 = 64; // 256-bit digest in base 16
    uint256 public constant LEN2 = 3; // checksum, at most 64 * 15 = 960 < 16^3
    uint256 public constant LEN = 67;

    bytes32 public immutable root;
    bytes32 public immutable pubSeed;
    uint8 public immutable height;
    /// @notice The only account allowed to spend leaves: the messenger that owns this verifier.
    address public immutable consumer;

    /// @notice The next leaf that may sign. Leaves below it are spent.
    uint256 public nextLeaf;

    event LeafSpent(uint256 indexed leaf, bytes32 digest);

    error OnlyConsumer();

    constructor(bytes32 root_, bytes32 pubSeed_, uint8 height_, address consumer_) {
        root = root_;
        pubSeed = pubSeed_;
        height = height_;
        consumer = consumer_;
    }

    function capacity() external view returns (uint256) {
        return (uint256(1) << height) - nextLeaf;
    }

    function verify(bytes32 digest, bytes calldata proof) external returns (bool) {
        if (msg.sender != consumer) revert OnlyConsumer();
        (uint32 leaf, bytes32[67] memory chains, bytes32[] memory path) = abi.decode(proof, (uint32, bytes32[67], bytes32[]));
        if (leaf < nextLeaf || leaf >= (uint256(1) << height) || path.length != height) return false;
        if (computeRoot(digest, leaf, chains, path) != root) return false;
        nextLeaf = uint256(leaf) + 1;
        emit LeafSpent(leaf, digest);
        return true;
    }

    /// @notice The root a signature leads to; equal to `root` exactly when it is valid. Pure, for tests and tooling.
    function computeRoot(bytes32 digest, uint32 leaf, bytes32[67] memory chains, bytes32[] memory path)
        public
        view
        returns (bytes32 node)
    {
        uint8[67] memory d = digits(digest);
        bytes32 seed = pubSeed;
        bytes memory ends = new bytes(LEN * 32);
        for (uint256 i; i < LEN; ++i) {
            bytes32 x = chains[i];
            for (uint256 s = d[i]; s < W - 1; ++s) {
                // forge-lint: disable-next-line(unsafe-typecast)
                x = keccak256(abi.encodePacked(seed, uint8(0), leaf, uint8(i), uint8(s), x));
            }
            assembly ("memory-safe") {
                mstore(add(add(ends, 32), mul(i, 32)), x)
            }
        }
        node = keccak256(abi.encodePacked(seed, uint8(1), leaf, ends));
        uint256 index = leaf;
        for (uint256 h; h < path.length; ++h) {
            node = (index & 1) == 0
                ? keccak256(abi.encodePacked(seed, uint8(2), uint8(h + 1), uint32(index >> 1), node, path[h]))
                : keccak256(abi.encodePacked(seed, uint8(2), uint8(h + 1), uint32(index >> 1), path[h], node));
            index >>= 1;
        }
    }

    /// @notice The 64 base-16 digits of `digest` (high nibble first) and the 3 digits of their checksum.
    function digits(bytes32 digest) public pure returns (uint8[67] memory d) {
        uint256 sum;
        for (uint256 i; i < 32; ++i) {
            uint8 b = uint8(digest[i]);
            d[2 * i] = b >> 4;
            d[2 * i + 1] = b & 0x0f;
            sum += (W - 1 - (b >> 4)) + (W - 1 - (b & 0x0f));
        }
        d[64] = uint8((sum >> 8) & 0x0f);
        d[65] = uint8((sum >> 4) & 0x0f);
        d[66] = uint8(sum & 0x0f);
    }

    function scheme() external pure returns (string memory) {
        return "Merkle WOTS+ (XMSS construction, w=16, keccak256)";
    }
}
