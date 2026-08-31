const { requireAuth } = require('../../../lib/auth');
const connecteam = require('../../../lib/connecteam');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!connecteam.isConfigured()) {
    res.status(503).json({ error: 'CONNECTEAM_API_KEY is not set on the server.' });
    return;
  }

  try {
    const days = Number(req.query.days || 30);
    const now = Math.floor(Date.now() / 1000);
    const startTime = now - 86400; // include anything from yesterday on
    const endTime = now + days * 86400;
    const shifts = await connecteam.listShifts(startTime, endTime);
    const filtered = shifts.filter((s) => !connecteam.NON_JOB_TITLE.test(s.title || ''));
    const collapsed = connecteam
      .collapseToOnePerJob(filtered, now)
      .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));

    const progressByTitle = await connecteam
      .getJobProgressBulk(collapsed.map((s) => s.title))
      .catch(() => new Map());
    const withProgress = collapsed.map((s) => ({
      ...s,
      progress: progressByTitle.get((s.title || '').trim().toLowerCase()) || null,
    }));

    res.json(withProgress);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
