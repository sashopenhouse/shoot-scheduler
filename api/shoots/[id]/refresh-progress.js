const { requireAuth } = require('../../../lib/auth');
const { getShoot, updateShoot } = require('../../../lib/supabase');
const connecteam = require('../../../lib/connecteam');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!connecteam.isConfigured()) {
    res.status(503).json({ error: 'CONNECTEAM_API_KEY is not set on the server.' });
    return;
  }

  const { id } = req.query;
  const shoot = await getShoot(id);
  if (!shoot) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!shoot.connecteamShiftTitle) {
    res.status(400).json({ error: 'This shoot was not imported from Connecteam.' });
    return;
  }

  try {
    // This route is the explicit "check now" action, so if the underlying
    // cache is stale it waits for a real refresh before answering, rather
    // than serving stale data the way the passive list views do.
    let { progress, refresh } = await connecteam.getJobProgress(shoot.connecteamShiftTitle);
    if (refresh) {
      await refresh();
      ({ progress } = await connecteam.getJobProgress(shoot.connecteamShiftTitle));
    }
    const updated = await updateShoot(id, { connecteamProgress: progress });
    res.json(updated);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
