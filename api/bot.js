import { act } from './_core.js';
export default async function handler(req, res) {
  const k = req.headers['x-admin'] || req.query.key;
  if (!process.env.CRON_SECRET || k !== process.env.CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  try { res.status(200).json(await act(req.query.action || 'run')); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
}
