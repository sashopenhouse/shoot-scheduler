const { requireAuth } = require('../../../lib/auth');
const { listPhotosForShoot } = require('../../../lib/supabase');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  const { id } = req.query;
  try {
    res.json(await listPhotosForShoot(id));
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
