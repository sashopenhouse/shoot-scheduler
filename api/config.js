const { requireAuth } = require('../lib/auth');
const mapbox = require('../lib/mapbox');

// Frontend config the client needs at load time. mapboxToken is a public
// (pk.) token — safe to expose to the browser, that's what it's for — but
// this is still gated by requireAuth like everything else in the app.
module.exports = requireAuth(async (req, res) => {
  res.json({ mapboxToken: mapbox.isConfigured() ? mapbox.publicToken() : null });
});
