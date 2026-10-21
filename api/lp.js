import { createSolanaRpc, createNoopSigner, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, partiallySignTransactionMessageWithSigners, getBase64EncodedWireTransaction, address } from '@solana/kit';
import { setWhirlpoolsConfig, openPositionInstructions } from '@orca-so/whirlpools';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';
import { sqrtPriceToPrice } from '@orca-so/whirlpools-core';

const EPS = [process.env.RPC_URL, 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);

async function getRpc() {
  for (const u of EPS) {
    try { const rpc = createSolanaRpc(u); await rpc.getLatestBlockhash().send(); return rpc; } catch (e) {}
  }
  throw new Error('Semua RPC sibuk, coba lagi');
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST saja' });
    const { owner, pool, amount, pct } = req.body || {};
    const amt = Number(amount), p = Number(pct) / 100;
    if (!owner || !pool || !(amt > 0) || !(p > 0 && p <= 0.5)) return res.status(400).json({ error: 'Input tidak valid' });
    const rpc = await getRpc();
    await setWhirlpoolsConfig('solanaMainnet');
    const pj = (await (await fetch('https://api.orca.so/v2/solana/pools/' + pool)).json()).data;
    const dA = pj.tokenA.decimals, dB = pj.tokenB.decimals;
    const w = (await fetchWhirlpool(rpc, address(pool))).data;
    const price = sqrtPriceToPrice(w.sqrtPrice, dA, dB);
    const signer = createNoopSigner(address(owner));
    const r = await openPositionInstructions(rpc, address(pool), { tokenA: BigInt(Math.floor(amt * 10 ** dA)) }, price * (1 - p), price * (1 + p), 100, signer);
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const msg = pipe(createTransactionMessage({ version: 0 }), x => setTransactionMessageFeePayerSigner(signer, x), x => setTransactionMessageLifetimeUsingBlockhash(bh, x), x => appendTransactionMessageInstructions(r.instructions, x));
    const tx = await partiallySignTransactionMessageWithSigners(msg);
    res.status(200).json({ tx: getBase64EncodedWireTransaction(tx), positionMint: String(r.positionMint) });
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}
