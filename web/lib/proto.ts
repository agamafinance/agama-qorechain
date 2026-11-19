/**
 * The protobuf messages the app hands QoreX, encoded by hand so no SDK ships in the bundle.
 *
 *   qorechain.crossvm.v1.MsgCrossVMCall  { sender=1, source_vm=2, target_vm=3, target_contract=4, payload=5 }
 *   qorechain.pqc.v1.MsgRegisterKEMKey   { sender=1, algorithm_id=2 (uint32), public_key=3 }
 *
 * The encoding is pinned to the SDK's test vectors.
 */
import { hexToBytes, type Hex } from 'viem';

class Writer {
  private chunks: number[] = [];
  private varint(n: number) {
    while (n > 0x7f) {
      this.chunks.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    this.chunks.push(n);
  }
  private tag(field: number, wire: number) {
    this.varint((field << 3) | wire);
  }
  uint(field: number, n: number) {
    if (!n) return this;
    this.tag(field, 0);
    this.varint(n);
    return this;
  }
  bytes(field: number, b: Uint8Array) {
    if (!b.length) return this;
    this.tag(field, 2);
    this.varint(b.length);
    for (const x of b) this.chunks.push(x);
    return this;
  }
  string(field: number, s: string) {
    return this.bytes(field, new TextEncoder().encode(s));
  }
  finish() {
    return Uint8Array.from(this.chunks);
  }
}

export type EncodedMsg = { typeUrl: string; value: Uint8Array };

/// Calls an EVM contract from the native lane. msg.sender in the EVM is the account's 0x twin, and the transaction
/// carries the account's hybrid signature.
export function crossVmCall(sender: string, target: Hex, calldata: Hex): EncodedMsg {
  const value = new Writer()
    .string(1, sender)
    .string(2, 'cosmwasm') // ignored by the chain, but it must be a VM name it knows
    .string(3, 'evm')
    .string(4, target)
    .bytes(5, hexToBytes(calldata))
    .finish();
  return { typeUrl: '/qorechain.crossvm.v1.MsgCrossVMCall', value };
}

/// Publishes the account's ML-KEM-1024 key in QoreChain's KEM registry (algorithm 2).
export function registerKemKey(sender: string, publicKey: Uint8Array): EncodedMsg {
  const value = new Writer().string(1, sender).uint(2, 2).bytes(3, publicKey).finish();
  return { typeUrl: '/qorechain.pqc.v1.MsgRegisterKEMKey', value };
}

/// Moves a bank coin (the form the QoreChain faucet pays fUSD in) to its ERC-20 form on `receiver`.
///   cosmos.evm.erc20.v1.MsgConvertCoin { coin=1 (Coin{denom=1, amount=2}), receiver=2, sender=3 }
export function convertCoin(sender: string, receiver: Hex, denom: string, amount: bigint): EncodedMsg {
  const coin = new Writer().string(1, denom).string(2, amount.toString()).finish();
  const value = new Writer().bytes(1, coin).string(2, receiver).string(3, sender).finish();
  return { typeUrl: '/cosmos.evm.erc20.v1.MsgConvertCoin', value };
}
