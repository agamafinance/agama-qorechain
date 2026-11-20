/**
 * The attester's post-quantum keys for the Ethereum leg, where there is no pqcVerify precompile.
 *
 *   ML-DSA-44 (FIPS 204)   signed with QoreChain's own PQC kit (@qorechain/pqc), verified in Solidity by ZKNox's
 *                          NIST verifier, about 8M gas
 *   Merkle WOTS+           Winternitz one-time signatures on keccak256 under a Merkle root (the XMSS construction),
 *                          verified for about the price of an ERC-20 transfer; stateful: one leaf per attestation
 *
 * Both keys are derived from the role mnemonic, so any keeper machine rebuilds them. Each is used together with the
 * attester's secp256k1 signature: the Ethereum messenger needs both.
 */
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { mldsa44 } from "@qorechain/pqc";
import { concat, encodeAbiParameters, keccak256, numberToHex, toBytes, toHex, type Hex } from "viem";
import { mnemonic } from "./accounts.js";

const derive = (label: string) =>
  hkdf(sha256, new TextEncoder().encode(mnemonic()), new TextEncoder().encode("agama"), new TextEncoder().encode(label), 32);

// ---------------------------------------------------------------------------
// ML-DSA-44
// ---------------------------------------------------------------------------

export function mldsa44Keys() {
  return mldsa44.keygen(derive("eth-attester-mldsa44"));
}

/** FIPS 204 ML-DSA-44 over the 32-byte digest, empty context: what MlDsa44AttestationVerifier checks. */
export function signMlDsa44(digest: Hex): Hex {
  return toHex(mldsa44.sign(mldsa44Keys().secretKey, toBytes(digest)));
}

// ---------------------------------------------------------------------------
// Merkle WOTS+ (w = 16, 67 chains, keccak256, tweaked like SPHINCS+'s simple hash)
// ---------------------------------------------------------------------------

const W = 16, LEN = 67;
const u8 = (n: number) => numberToHex(n, { size: 1 });
const u32 = (n: number) => numberToHex(n, { size: 4 });

export function digits(digest: Hex): number[] {
  const b = toBytes(digest);
  const d: number[] = [];
  let sum = 0;
  for (const x of b) {
    d.push(x >> 4, x & 0x0f);
    sum += W - 1 - (x >> 4) + (W - 1 - (x & 0x0f));
  }
  d.push((sum >> 8) & 0x0f, (sum >> 4) & 0x0f, sum & 0x0f);
  return d;
}

export class MerkleWots {
  readonly pubSeed: Hex;
  private readonly skSeed: Uint8Array;
  private levels: Hex[][] = [];

  constructor(readonly height: number, label = "eth-attester-wots", skSeed?: Uint8Array, pubSeed?: Hex) {
    this.skSeed = skSeed ?? derive(label);
    this.pubSeed = pubSeed ?? toHex(derive(`${label}-pub`));
  }

  private f(leaf: number, chain: number, step: number, x: Hex): Hex {
    return keccak256(concat([this.pubSeed, u8(0), u32(leaf), u8(chain), u8(step), x]));
  }

  private start(leaf: number, chain: number): Hex {
    return keccak256(concat([toHex(this.skSeed), u32(leaf), u8(chain)]));
  }

  private chain(leaf: number, chain: number, from: number, to: number, x: Hex): Hex {
    for (let s = from; s < to; s++) x = this.f(leaf, chain, s, x);
    return x;
  }

  leafHash(leaf: number): Hex {
    const ends: Hex[] = [];
    for (let i = 0; i < LEN; i++) ends.push(this.chain(leaf, i, 0, W - 1, this.start(leaf, i)));
    return keccak256(concat([this.pubSeed, u8(1), u32(leaf), ...ends]));
  }

  private node(h: number, index: number, left: Hex, right: Hex): Hex {
    return keccak256(concat([this.pubSeed, u8(2), u8(h), u32(index), left, right]));
  }

  /** Builds the whole tree once: 2^height leaves of 67 chains of 15 hashes. */
  build(): Hex {
    const n = 1 << this.height;
    let level: Hex[] = [];
    for (let i = 0; i < n; i++) level.push(this.leafHash(i));
    this.levels = [level];
    for (let h = 1; h <= this.height; h++) {
      const next: Hex[] = [];
      for (let i = 0; i < level.length; i += 2) next.push(this.node(h, i >> 1, level[i], level[i + 1]));
      this.levels.push(next);
      level = next;
    }
    return level[0];
  }

  get root(): Hex {
    if (!this.levels.length) this.build();
    return this.levels[this.height][0];
  }

  /** abi.encode(uint32 leaf, bytes32[67] chains, bytes32[] authPath): what MerkleWotsAttestationVerifier reads. */
  sign(leaf: number, digest: Hex): Hex {
    if (!this.levels.length) this.build();
    const d = digits(digest);
    const chains = d.map((di, i) => this.chain(leaf, i, 0, di, this.start(leaf, i))) as Hex[];
    const path: Hex[] = [];
    let index = leaf;
    for (let h = 0; h < this.height; h++) {
      path.push(this.levels[h][index ^ 1]);
      index >>= 1;
    }
    return encodeAbiParameters(
      [{ type: "uint32" }, { type: "bytes32[67]" }, { type: "bytes32[]" }],
      [leaf, chains as any, path],
    );
  }
}
