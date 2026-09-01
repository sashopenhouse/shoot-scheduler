const { waitUntil } = require('@vercel/functions');
const { requireAuth } = require('../../../lib/auth');
const connecteam = require('../../../lib/connecteam');
const mapbox = require('../../../lib/mapbox');
const { dismissedJobKeys, dismissKeyFor } = require('../../../lib/supabase');

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
    // Anchored to the start of today (not "now minus 24h") so a job
    // scheduled for earlier today never rolls out of the window just
    // because the clock has moved past its shift time.
    const todayStart = Math.floor(now / 86400) * 86400;
    const startTime = todayStart;
    const endTime = now + days * 86400;

    // Stale-while-revalidate: serve cached shifts immediately (even if
    // stale) so this route doesn't block on a slow Connecteam page-through;
    // any needed refresh runs after the response via waitUntil.
    const { shifts, refresh: refreshShifts } = await connecteam.fetchShiftsCached(startTime, endTime);
    if (refreshShifts) waitUntil(refreshShifts());

    const dismissed = await dismissedJobKeys().catch(() => new Set());
    const filtered = shifts.filter(
      (s) => !connecteam.NON_JOB_TITLE.test(s.title || '') && !dismissed.has(dismissKeyFor(s.title)),
    );
    const collapsed = connecteam
      .collapseToOnePerJob(filtered, now)
      .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));

    const { progressByTitle, refresh: refreshProgress } = await connecteam
      .getJobProgressBulk(collapsed.map((s) => s.title))
      .catch(() => ({ progressByTitle: new Map(), refresh: null }));
    if (refreshProgress) waitUntil(refreshProgress());

    let geocodeByAddress = new Map();
    if (mapbox.isConfigured()) {
      geocodeByAddress = await mapbox
        .geocodeManyCached(collapsed.map((s) => s.location?.address).filter(Boolean))
        .catch(() => new Map());
    }

    const withProgress = collapsed.map((s) => {
      const point = s.location?.address ? geocodeByAddress.get(s.location.address) : null;
      return {
        ...s,
        progress: progressByTitle.get((s.title || '').trim().toLowerCase()) || null,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        guessedProjectType: connecteam.guessProjectType(s.title, s.jobTitle, s.details),
      };
    });

    res.json(withProgress);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
