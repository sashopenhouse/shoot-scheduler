const { requireAuth } = require('../../lib/auth');
const { listUngeocodedShoots, setShootGeocode } = require('../../lib/supabase');
const mapbox = require('../../lib/mapbox');

// Geocodes any shoots that don't have coordinates yet and persists them.
// Called by the frontend before rendering the map — cheap after the first
// run since results are cached in Supabase (lat/lng/geocoded_at columns).
module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!mapbox.isConfigured()) {
    res.status(503).json({ error: 'MAPBOX_TOKEN is not set on the server.' });
    return;
  }

  try {
    const pending = await listUngeocodedShoots();
    let geocoded = 0;
    for (const shoot of pending) {
      const point = await mapbox.geocode(shoot.location).catch(() => null);
      if (point) {
        await setShootGeocode(shoot.id, point);
        geocoded++;
      } else {
        // Mark as attempted so a bad address doesn't retry on every load.
        await setShootGeocode(shoot.id, { lat: null, lng: null });
      }
    }
    res.json({ attempted: pending.length, geocoded });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
