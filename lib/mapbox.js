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

// Lazy Supabase client for the address-keyed geocode cache, used for
// Connecteam import candidates — those aren't saved rows, so they can't
// reuse the shoots.lat/lng cache the way a saved shoot does.
let _supabase = null;
function supabaseClient() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return _supabase;
}

const CACHE_KEY_MAX = 500; // Postgres text column has no hard limit, but keep keys sane

function cacheKeyFor(address) {
  return address.trim().toLowerCase().slice(0, CACHE_KEY_MAX);
}

/**
 * Geocodes many addresses at once, using and populating the persistent
 * geocode_cache table so repeated addresses (common — several shifts often
 * share a jobsite) and repeat page loads don't re-pay Mapbox calls.
 * Returns a Map from the original address string to { lat, lng } | null.
 */
async function geocodeManyCached(addresses) {
  const uniqueAddresses = [...new Set(addresses.map((a) => (a || '').trim()).filter(Boolean))];
  if (!uniqueAddresses.length) return new Map();

  const keys = uniqueAddresses.map(cacheKeyFor);
  const { data: cached } = await supabaseClient().from('geocode_cache').select('*').in('address', keys);
  const cacheByKey = new Map((cached || []).map((row) => [row.address, row]));

  const results = new Map();
  const toInsert = [];

  for (const address of uniqueAddresses) {
    const key = cacheKeyFor(address);
    const hit = cacheByKey.get(key);
    if (hit) {
      results.set(address, hit.lat != null && hit.lng != null ? { lat: hit.lat, lng: hit.lng } : null);
      continue;
    }

    const point = await geocode(address).catch(() => null);
    results.set(address, point);
    toInsert.push({ address: key, lat: point?.lat ?? null, lng: point?.lng ?? null });
  }

  if (toInsert.length) {
    try {
      await supabaseClient().from('geocode_cache').upsert(toInsert);
    } catch {
      // A cache-write failure shouldn't lose results already geocoded above.
    }
  }

  return results;
}

module.exports = { isConfigured, geocode, geocodeManyCached, publicToken: () => TOKEN };
