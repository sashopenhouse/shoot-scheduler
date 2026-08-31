const { requireAuth } = require('../../lib/auth');
const { listShoots, createShoot } = require('../../lib/supabase');

module.exports = requireAuth(async (req, res) => {
  if (req.method === 'GET') {
    const shoots = await listShoots();
    res.json(shoots);
    return;
  }

  if (req.method === 'POST') {
    const shoot = await createShoot(req.body || {});
    res.status(201).json(shoot);
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
