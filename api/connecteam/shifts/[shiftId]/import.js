const { waitUntil } = require('@vercel/functions');
const { requireAuth } = require('../../../../lib/auth');
const connecteam = require('../../../../lib/connecteam');
const { createShoot } = require('../../../../lib/supabase');

module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!connecteam.isConfigured()) {
    res.status(503).json({ error: 'CONNECTEAM_API_KEY is not set on the server.' });
    return;
  }

  try {
    const { shiftId } = req.query;
    const days = Number(req.query.days || 30);
    const now = Math.floor(Date.now() / 1000);
    // Anchored to the start of today, not "now minus 24h" — see the shifts
    // list route for why a rolling offset makes today's jobs disappear.
    const todayStart = Math.floor(now / 86400) * 86400;
    const { shifts, refresh: refreshShifts } = await connecteam.fetchShiftsCached(todayStart, now + days * 86400);
    if (refreshShifts) waitUntil(refreshShifts());
    const collapsed = connecteam.collapseToOnePerJob(shifts, now);
    const shift = collapsed.find((s) => String(s.shiftId) === String(shiftId));
    if (!shift) {
      res.status(404).json({ error: 'Shift not found in current window.' });
      return;
    }

    const toDateParts = (unixSeconds) => {
      if (!unixSeconds) return { date: '', time: '' };
      const d = new Date(unixSeconds * 1000);
      const date = d.toISOString().slice(0, 10);
      const time = d.toTimeString().slice(0, 5);
      return { date, time };
    };
    const start = toDateParts(shift.startTime);
    const end = toDateParts(shift.endTime);

    const noteParts = [];
    if (shift.jobTitle) noteParts.push(`Connecteam job: ${shift.jobTitle}`);
    if (shift.crew?.length) noteParts.push(`Crew: ${shift.crew.join(', ')}`);
    if (shift.details) noteParts.push(shift.details);

    const { progress, refresh: refreshProgress } = await connecteam
      .getJobProgress(shift.title)
      .catch(() => ({ progress: null, refresh: null }));
    if (refreshProgress) waitUntil(refreshProgress());

    const shoot = await createShoot({
      location: shift.location.address || shift.title || 'Untitled site',
      date: start.date,
      startTime: start.time,
      endTime: end.time,
      status: 'planned',
      notes: noteParts.join('\n\n'),
      projectType: connecteam.guessProjectType(shift.title, shift.jobTitle, shift.details),
      connecteamShiftId: shift.shiftId,
      connecteamJobTitle: shift.jobTitle,
      connecteamShiftTitle: shift.title,
      connecteamCrew: shift.crew || [],
      connecteamAttachments: shift.attachments || [],
      connecteamProgress: progress,
    });
    res.status(201).json(shoot);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
