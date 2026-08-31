// Mapbox Geocoding API — turns a shoot's free-text location into lat/lng
// for the map. Server-side only: the token is a public (pk.) token, but
// geocoding still goes through our API so results can be cached in Supabase
// instead of re-geocoding the same address on every page load.

const TOKEN = process.env.MAPBOX_TOKEN || '';

function isConfigured() {
  return Boolean(TOKEN);
}

/** Geocodes a free-text address/place to { lat, lng } or null if nothing matched. */
async function geocode(query) {
  if (!query || !query.trim()) return null;

  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?access_token=${TOKEN}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;

  const body = await res.json();
  const feature = body.features?.[0];
  if (!feature) return null;

  const [lng, lat] = feature.center;
  return { lat, lng };
}

module.exports = { isConfigured, geocode, publicToken: () => TOKEN };
