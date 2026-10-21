// Opsional: isi env RPC_URL di Vercel (Helius/QuickNode) agar RPC lebih cepat. Tanpa env, browser otomatis pakai RPC publik.
export default async function handler(req, res) {
  const url = process.env.RPC_URL;
  if (!url || req.method !== 'POST') return res.status(404).end();
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
  res.status(r.status).setHeader('Content-Type', 'application/json').send(await r.text());
}
