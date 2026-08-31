const { waitUntil } = require('@vercel/functions');
const { requireAuth } = require('../../lib/auth');
const { updateShoot, deleteShoot } = require('../../lib/supabase');
const dropbox = require('../../lib/dropbox');

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
    // Dropbox folder cleanup runs after the response — deleting the shoot
    // and its Supabase records shouldn't wait on an extra network round trip.
    if (dropbox.isConfigured() && removed.dropboxFolderPath) {
      waitUntil(dropbox.deleteFolder(removed.dropboxFolderPath).catch((err) => {
        console.error('Dropbox folder cleanup failed:', err.message);
      }));
    }
    res.status(204).end();
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
});
