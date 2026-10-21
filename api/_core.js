import { createSolanaRpc, createKeyPairSignerFromBytes, pipe, createTransactionMessage, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, appendTransactionMessageInstructions, signTransactionMessageWithSigners, getBase64EncodedWireTransaction, address } from '@solana/kit';
import { setWhirlpoolsConfig, fetchPositionsForOwner, openPositionInstructions, closePositionInstructions } from '@orca-so/whirlpools';
import { fetchWhirlpool } from '@orca-so/whirlpools-client';
import { sqrtPriceToPrice, tickIndexToPrice } from '@orca-so/whirlpools-core';
import { Connection, Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const E = process.env, POOL = E.POOL;
// RPC otomatis: pilih endpoint yang sehat, pindah sendiri bila sibuk
const EPS = [E.RPC_URL, 'https://solana-rpc.publicnode.com', 'https://solana.drpc.org', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
let RPC, ei = 0;
async function pick() {
  for (let n = 0; n < EPS.length; n++) {
    const i = (ei + n) % EPS.length;
    try { const r = await fetch(EPS[i], { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"getBlockHeight"}' }); const j = await r.json(); if (r.ok && j.result) { ei = i; return EPS[i]; } } catch (e) {}
  }
  throw new Error('Semua RPC sibuk, coba lagi');
}
const R = +(E.RANGE_PCT || 5) / 100, KEEP = +(E.KEEP_SOL || 0.05), SLP = +(E.SLIPPAGE_BPS || 100), MINV = +(E.MIN_VALUE || 5);
const WSOL = 'So11111111111111111111111111111111111111112', J = 'https://lite-api.jup.ag/swap/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let X;
async function init() {
  if (X) return X;
  if (!E.BOT_KEY || !POOL) throw new Error('Env BOT_KEY dan POOL wajib diisi');
  const k = E.BOT_KEY.trim(), b = Uint8Array.from(k.startsWith('[') ? JSON.parse(k) : bs58.decode(k));
  RPC = await pick(); await setWhirlpoolsConfig('solanaMainnet');
  return (X = { rpc: createSolanaRpc(RPC), signer: await createKeyPairSignerFromBytes(b), kp: Keypair.fromSecretKey(b), cn: new Connection(RPC, 'confirmed') });
}
async function sendIx(ixs) {
  const { rpc, signer } = X, { value: bh } = await rpc.getLatestBlockhash().send();
  const m = pipe(createTransactionMessage({ version: 0 }), x => setTransactionMessageFeePayerSigner(signer, x), x => setTransactionMessageLifetimeUsingBlockhash(bh, x), x => appendTransactionMessageInstructions(ixs, x));
  const tx = await signTransactionMessageWithSigners(m);
  const sig = await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: 'base64', maxRetries: 5n }).send();
  for (let i = 0; i < 30; i++) {
    const s = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (s) { if (s.err) throw new Error('Transaksi gagal: ' + JSON.stringify(s.err, (k, v) => typeof v === 'bigint' ? String(v) : v)); if (s.confirmationStatus !== 'processed') return sig; }
    await sleep(1500);
  }
  throw new Error('Konfirmasi timeout ' + sig);
}
async function raw(mint) {
  const { cn, kp } = X;
  if (mint === WSOL) return BigInt(await cn.getBalance(kp.publicKey));
  const r = await cn.getParsedTokenAccountsByOwner(kp.publicKey, { mint: new PublicKey(mint) });
  return r.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
}
async function jup(i, o, amt) {
  const q = await (await fetch(`${J}/quote?inputMint=${i}&outputMint=${o}&amount=${amt}&slippageBps=${SLP}`)).json();
  const s = await (await fetch(J + '/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: X.kp.publicKey.toString(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: 'auto' }) })).json();
  if (!s.swapTransaction) throw new Error('Swap Jupiter gagal dibuat');
  const tx = VersionedTransaction.deserialize(Buffer.from(s.swapTransaction, 'base64')); tx.sign([X.kp]);
  const sig = await X.cn.sendRawTransaction(tx.serialize()); await X.cn.confirmTransaction(sig, 'confirmed'); return sig;
}
async function info() {
  await init(); const { rpc, signer } = X;
  const pj = (await (await fetch('https://api.orca.so/v2/solana/pools/' + POOL)).json()).data;
  const w = (await fetchWhirlpool(rpc, address(POOL))).data, dA = pj.tokenA.decimals, dB = pj.tokenB.decimals;
  const ps = (await fetchPositionsForOwner(rpc, signer.address)).flatMap(p => p.positions || [p]).filter(p => p.data?.whirlpool === POOL && p.data.liquidity > 0n);
  return { pj, dA, dB, ps, tick: w.tickCurrentIndex, price: sqrtPriceToPrice(w.sqrtPrice, dA, dB) };
}
async function bal(I) {
  const A = I.pj.tokenA.address, B = I.pj.tokenB.address, res = BigInt(Math.floor(KEEP * 1e9));
  let a = await raw(A), b = await raw(B);
  if (A === WSOL) a = a > res ? a - res : 0n; if (B === WSOL) b = b > res ? b - res : 0n;
  return [a, b];
}
async function openPos(I) {
  const A = I.pj.tokenA.address, B = I.pj.tokenB.address; let [a, b] = await bal(I);
  const vA = Number(a) / 10 ** I.dA * I.price, vB = Number(b) / 10 ** I.dB, tot = vA + vB;
  if (tot < MINV) return 'Saldo bot di bawah minimum, tidak ada yang dibuka';
  const d = (vA - vB) / 2; // zap: seimbangkan nilai A dan B
  if (Math.abs(d) / tot > 0.02) {
    if (d > 0) await jup(A, B, Math.floor(d / I.price * 10 ** I.dA)); else await jup(B, A, Math.floor(-d * 10 ** I.dB));
    [a] = await bal(I);
  }
  const r = await openPositionInstructions(X.rpc, address(POOL), { tokenA: a * 97n / 100n }, I.price * (1 - R), I.price * (1 + R), SLP, X.signer);
  await sendIx(r.instructions); return 'Posisi dibuka ' + r.positionMint;
}
async function closeAll(ps) {
  for (const p of ps) { const r = await closePositionInstructions(X.rpc, p.data.positionMint, SLP, X.signer); await sendIx(r.instructions); }
}
async function pub(I) {
  const [a, b] = await bal(I), f = (x, d) => Number(x) / 10 ** d;
  return { wallet: X.signer.address, pair: I.pj.tokenA.symbol + '/' + I.pj.tokenB.symbol, price: I.price, tick: I.tick, balanceA: f(a, I.dA), balanceB: f(b, I.dB), range: R * 100,
    positions: I.ps.map(p => ({ mint: p.data.positionMint, lower: tickIndexToPrice(p.data.tickLowerIndex, I.dA, I.dB), upper: tickIndexToPrice(p.data.tickUpperIndex, I.dA, I.dB), inRange: I.tick >= p.data.tickLowerIndex && I.tick < p.data.tickUpperIndex })) };
}
async function run(a) {
  const I = await info();
  if (a === 'status') return pub(I);
  if (a === 'close') { await closeAll(I.ps); return { closed: I.ps.length }; }
  if (a === 'open') return I.ps.length ? { skip: 'Posisi sudah ada' } : { result: await openPos(I) };
  // siklus bot: autozap dana menganggur + auto rebalance saat keluar range
  if (!I.ps.length) return { result: await openPos(I) };
  const out = I.ps.filter(p => I.tick < p.data.tickLowerIndex || I.tick >= p.data.tickUpperIndex);
  if (!out.length) return { ok: 'Posisi masih dalam range', price: I.price };
  await closeAll(out); return { rebalanced: await openPos(await info()) };
}
export async function act(a) {
  try { return await run(a); }
  catch (e) {
    const m = String(e.message || e);
    if (/429|rate|limit|fetch|RPC|forbidden|timeout|Too Many/i.test(m) && !/Transaksi gagal/.test(m)) { X = null; ei = (ei + 1) % EPS.length; return await run(a); }
    throw e;
  }
}
