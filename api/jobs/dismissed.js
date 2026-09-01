const { requireAuth } = require('../../lib/auth');
const { dismissJob, undismissJob, listDismissedJobs } = require('../../lib/supabase');

// Permanently hides a Connecteam job (by title) from the Jobs list and map.
module.exports = requireAuth(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.json(await listDismissedJobs());
      return;
    }

    if (req.method === 'POST') {
      const title = (req.body || {}).title;
      if (!title) {
        res.status(400).json({ error: 'title is required.' });
        return;
      }
      await dismissJob(title);
      res.status(201).json({ ok: true });
      return;
    }

    if (req.method === 'DELETE') {
      const title = req.query.title;
      if (!title) {
        res.status(400).json({ error: 'title query param is required.' });
        return;
      }
      await undismissJob(title);
      res.status(204).end();
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
