const { requireAuth } = require('../../lib/auth');
const { updateShoot, deleteShoot } = require('../../lib/supabase');

module.exports = requireAuth(async (req, res) => {
  const { id } = req.query;

  if (req.method === 'PUT') {
    const updated = await updateShoot(id, req.body || {});
    if (!updated) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json(updated);
    return;
  }

  if (req.method === 'DELETE') {
    const removed = await deleteShoot(id);
    if (!removed) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.status(204).end();
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
