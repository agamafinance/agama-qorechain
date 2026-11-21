/** The native QoreChain hash of an EVM transaction: the chain records each one as a MsgEthereumTx inside one. */
const UPSTREAM = process.env.QORE_REST_UPSTREAM ?? 'https://api-testnet.qore.host';

export async function nativeHash(evmHash: string): Promise<string | undefined> {
  const q = encodeURIComponent(`ethereum_tx.ethereumTxHash='${evmHash.toLowerCase()}'`);
  // A transaction that just landed can take a few seconds to be indexed.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${UPSTREAM}/cosmos/tx/v1beta1/txs?query=${q}`, { headers: { accept: 'application/json', 'user-agent': 'agama-qorechain/1.0' }, cache: 'no-store' }).catch(() => null);
    const native = r?.ok ? ((await r.json()) as { tx_responses?: { txhash: string }[] }).tx_responses?.[0]?.txhash : undefined;
    if (native) return native;
    await new Promise((res) => setTimeout(res, 1_500));
  }
}
