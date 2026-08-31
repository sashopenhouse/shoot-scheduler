const { requireAuth } = require('../../lib/auth');
const { searchShoots, photoCountsByShoot } = require('../../lib/supabase');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { q, dateFrom, dateTo } = req.query;
    const shoots = await searchShoots({ q, dateFrom, dateTo });
    const counts = await photoCountsByShoot(shoots.map((s) => s.id));
    const withCounts = shoots.map((s) => ({ ...s, photoCount: counts.get(s.id) || 0 }));
    res.json(withCounts);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
