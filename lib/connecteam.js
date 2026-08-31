// Connecteam API client — read-only.
//
// Endpoints (Operations Hub, Expert plan), confirmed against the live API
// via mapro's scripts/connecteam-spike.js:
//   GET /scheduler/v1/schedulers                                  -> list of schedulers
//   GET /scheduler/v1/schedulers/{id}/shifts?startTime=&endTime=  -> shifts in a window
//
// Shift location lives at shift.locationData.gps (not shift.location/shift.gps).

const API_KEY = process.env.CONNECTEAM_API_KEY || '';
const BASE = process.env.CONNECTEAM_BASE_URL || 'https://api.connecteam.com';
const PINNED_SCHEDULER_ID = process.env.CONNECTEAM_SCHEDULER_ID || '';

class ConnecteamError extends Error {}

// Lazy Supabase client for the cross-invocation shifts cache (see
// fetchShiftsCached below). Lazy because this module is also require()'d by
// local test scripts that may not have Supabase env vars set.
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function get(path, attempt = 0) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'X-API-KEY': API_KEY, Accept: 'application/json' },
  });

  if (res.status === 429 && attempt < 4) {
    const retryAfter = Number(res.headers.get('retry-after')) || 0;
    await sleep(Math.max(retryAfter * 1000, 500 * 2 ** attempt));
    return get(path, attempt + 1);
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ConnecteamError(`GET ${path} -> HTTP ${res.status} with a non-JSON body`);
  }
  if (!res.ok) {
    throw new ConnecteamError(`GET ${path} -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body;
}

function unwrap(body) {
  if (Array.isArray(body)) return body;
  for (const v of Object.values(body ?? {})) {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object') {
      const nested = unwrap(v);
      if (nested.length) return nested;
    }
  }
  return [];
}

async function listSchedulers() {
  const body = await get('/scheduler/v1/schedulers');
  return unwrap(body);
}

async function resolveSchedulerId() {
  if (PINNED_SCHEDULER_ID) return PINNED_SCHEDULER_ID;
  const schedulers = await listSchedulers();
  const first = schedulers[0];
  const id = first?.id ?? first?.schedulerId;
  if (!id) throw new ConnecteamError('No scheduler found on this account.');
  return id;
}

function shiftLocation(shift) {
  const gps = shift.locationData?.gps ?? shift.location ?? shift.gps ?? null;
  const address = gps?.address ?? shift.locationData?.address ?? shift.address ?? null;
  return {
    address: address || null,
    lat: gps?.latitude ?? gps?.lat ?? null,
    lng: gps?.longitude ?? gps?.lng ?? gps?.lon ?? null,
  };
}

/** Strips HTML tags out of a shift's rich-text note so it reads as plain text. */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits a shift's notes array into free-text details and file attachments. */
function shiftNotes(shift) {
  const notes = Array.isArray(shift.notes) ? shift.notes : [];
  const details = notes
    .filter((n) => n.type === 'html' && n.html)
    .map((n) => stripHtml(n.html))
    .filter(Boolean)
    .join('\n\n');
  const attachments = notes
    .filter((n) => n.type === 'file' && n.url)
    .map((n) => ({ name: n.name || 'Attachment', url: n.url }));
  return { details, attachments };
}

/**
 * All users on the account, keyed by userId, for turning assignedUserIds into
 * crew names on shifts. Cached in-process for a few minutes since the roster
 * changes rarely and this endpoint pages through the whole account.
 */
let usersCache = null;
let usersCacheAt = 0;
const USERS_CACHE_MS = 5 * 60 * 1000;

async function listUsers() {
  if (usersCache && Date.now() - usersCacheAt < USERS_CACHE_MS) return usersCache;

  const out = new Map();
  const pageSize = 50;
  for (let offset = 0; offset < 5000; offset += pageSize) {
    const body = await get(`/users/v1/users?limit=${pageSize}&offset=${offset}`);
    const page = unwrap(body);
    if (page.length === 0) break;
    for (const u of page) {
      if (typeof u.userId === 'number') {
        out.set(u.userId, `${u.firstName || ''} ${u.lastName || ''}`.trim());
      }
    }
    if (page.length < pageSize) break;
  }
  usersCache = out;
  usersCacheAt = Date.now();
  return out;
}

/**
 * All shifts in [startTime, endTime), paging through the API's 100-per-page
 * cap. The first page is fetched alone to learn whether more pages exist;
 * remaining pages are then fetched concurrently (bounded) rather than one
 * round-trip at a time, since a wide window can be 30+ pages.
 */
async function fetchAllShifts(schedulerId, startTime, endTime) {
  const pageSize = 100;
  const maxOffset = 20_000;
  const pageUrl = (offset) =>
    `/scheduler/v1/schedulers/${schedulerId}/shifts?startTime=${startTime}&endTime=${endTime}&limit=${pageSize}&offset=${offset}`;

  const first = unwrap(await get(pageUrl(0)));
  if (first.length < pageSize) return first;

  const offsets = [];
  for (let offset = pageSize; offset < maxOffset; offset += pageSize) offsets.push(offset);

  const out = [...first];
  const concurrency = 3;
  for (let i = 0; i < offsets.length; i += concurrency) {
    const batch = offsets.slice(i, i + concurrency);
    const pages = await Promise.all(batch.map((offset) => get(pageUrl(offset)).then(unwrap)));
    let hitShortPage = false;
    for (const page of pages) {
      out.push(...page);
      if (page.length < pageSize) hitShortPage = true;
    }
    if (hitShortPage) break;
  }
  return out;
}

/**
 * Cache of listShifts results keyed by window, so a progress lookup right
 * after a shift listing (or several refresh clicks in a row) don't each pay
 * for a full re-page of a wide window. Short-lived: this is a planning tool,
 * not a real-time feed.
 *
 * This in-memory cache only helps within one warm serverless instance — on
 * Vercel a fresh instance starts cold with nothing in it, so it is backed by
 * a Supabase table (see fetchShiftsCached) for cross-invocation reuse.
 */
const shiftsCache = new Map();
const SHIFTS_CACHE_MS = 2 * 60 * 1000;

/** Fetches and normalizes shifts for [startTime, endTime) directly from Connecteam. */
async function fetchShiftsLive(startTime, endTime) {
  const schedulerId = await resolveSchedulerId();
  const [shifts, users] = await Promise.all([
    fetchAllShifts(schedulerId, startTime, endTime),
    listUsers().catch(() => new Map()), // crew names are a bonus, not a requirement
  ]);
  return shifts
    .map((s) => {
      const assignedUserIds = s.assignedUserIds ?? s.assignedUsers?.map((u) => u.userId) ?? [];
      const { details, attachments } = shiftNotes(s);
      return {
        shiftId: s.id ?? s.shiftId,
        title: s.title ?? '',
        startTime: s.startTime ?? null,
        endTime: s.endTime ?? null,
        jobId: s.jobId ?? s.job?.id ?? null,
        jobTitle: s.job?.title ?? null,
        assignedUserIds,
        crew: assignedUserIds.map((id) => users.get(id)).filter(Boolean),
        location: shiftLocation(s),
        details,
        attachments,
      };
    })
    .sort((a, b) => (a.startTime ?? Infinity) - (b.startTime ?? Infinity));
}

/** Shifts in [startTime, endTime), unix seconds. In-process cache only. */
async function listShifts(startTime, endTime) {
  const cacheKey = `${startTime}:${endTime}`;
  const cached = shiftsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SHIFTS_CACHE_MS) return cached.shifts;

  const result = await fetchShiftsLive(startTime, endTime);
  shiftsCache.set(cacheKey, { shifts: result, at: Date.now() });
  return result;
}

const CACHE_FRESH_MS = 5 * 60 * 1000;

/** Persists a window's shifts to the cross-invocation Supabase cache. */
async function writeShiftsCache(startTime, endTime, shifts) {
  const cacheKey = `${startTime}:${endTime}`;
  await supabaseClient()
    .from('connecteam_shifts_cache')
    .upsert({ cache_key: cacheKey, shifts, fetched_at: new Date().toISOString() });
}

/**
 * Stale-while-revalidate shifts fetch for [startTime, endTime).
 *
 * Every serverless invocation can be a cold instance with an empty in-memory
 * cache, so a Supabase-backed cache carries results across invocations:
 *   - fresh cache hit (< 5 min old): return it immediately, no Connecteam call.
 *   - stale cache hit: return the stale data immediately so the request
 *     doesn't wait on Connecteam, and hand back a `refresh` promise the
 *     caller can run after responding (via Vercel's waitUntil) to update the
 *     cache for next time.
 *   - no cache at all (first-ever call for this window): fetch live and
 *     block, since there is nothing else to serve.
 *
 * Returns { shifts, stale, refresh }. `refresh` is null when nothing needs
 * refreshing (a fresh hit, or the live fetch that just happened).
 */
async function fetchShiftsCached(startTime, endTime) {
  const cacheKey = `${startTime}:${endTime}`;
  const { data: row } = await supabaseClient()
    .from('connecteam_shifts_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .maybeSingle();

  const doRefresh = async () => {
    const fresh = await fetchShiftsLive(startTime, endTime);
    await writeShiftsCache(startTime, endTime, fresh).catch(() => {});
    return fresh;
  };

  if (!row) {
    const shifts = await doRefresh();
    return { shifts, stale: false, refresh: null };
  }

  const ageMs = Date.now() - new Date(row.fetched_at).getTime();
  if (ageMs < CACHE_FRESH_MS) {
    return { shifts: row.shifts, stale: false, refresh: null };
  }

  return { shifts: row.shifts, stale: true, refresh: doRefresh };
}

/**
 * Turns a job's own shifts into a { totalDays, completedDays, percent, ... }
 * summary, one entry per calendar day rather than per shift — a day with two
 * crew members on it is one day of work, not two.
 */
function summarizeJobShifts(jobShifts, referenceUnixSeconds) {
  const dayKey = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

  const days = new Map(); // dayKey -> earliest startTime on that day
  for (const s of jobShifts) {
    if (!s.startTime) continue;
    const key = dayKey(s.startTime);
    if (!days.has(key) || s.startTime < days.get(key)) days.set(key, s.startTime);
  }

  const sortedTimes = [...days.values()].sort((a, b) => a - b);
  const total = sortedTimes.length;
  const completed = sortedTimes.filter((t) => t < referenceUnixSeconds).length;

  return {
    totalDays: total,
    completedDays: completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
    firstShiftTime: sortedTimes[0] ?? null,
    lastShiftTime: sortedTimes[sortedTimes.length - 1] ?? null,
  };
}

/**
 * Fetches the wide shift window used to estimate job progress, rounded to
 * the day so repeated calls within the same day hit the same cache entry.
 * Backed by the Supabase stale-while-revalidate cache — see
 * fetchShiftsCached — so a serverless cold start doesn't pay the full
 * 360-day-window pagination cost on every request.
 */
async function fetchProgressWindow(referenceUnixSeconds) {
  const windowDays = 180;
  const dayStart = Math.floor(referenceUnixSeconds / 86400) * 86400;
  return fetchShiftsCached(dayStart - windowDays * 86400, dayStart + windowDays * 86400);
}

/**
 * Estimates how far along a job is by looking at every shift sharing its
 * title (e.g. "Roberts"), since Connecteam's jobId is not a reliable per-job
 * key on this account — it is shared across many unrelated shifts.
 *
 * A job's shifts already in the past are assumed done; the rest are not.
 * This is a heuristic, not ground truth: a job can run over its last
 * scheduled shift and still be unfinished.
 *
 * Returns { progress, refresh }. `refresh` is a function to run (typically
 * via Vercel's waitUntil, after the response is sent) when the underlying
 * cache was stale — pass null through if you don't need that.
 */
async function getJobProgress(title, referenceUnixSeconds = Math.floor(Date.now() / 1000)) {
  const needle = (title || '').trim().toLowerCase();
  if (!needle) return { progress: null, refresh: null };

  const { shifts, refresh } = await fetchProgressWindow(referenceUnixSeconds);
  const jobShifts = shifts.filter((s) => (s.title || '').trim().toLowerCase() === needle);
  const progress = jobShifts.length ? summarizeJobShifts(jobShifts, referenceUnixSeconds) : null;
  return { progress, refresh };
}

/**
 * Same as getJobProgress, but for many titles at once over a single fetch of
 * the wide window — used to annotate a whole import list without paging the
 * 180-day range once per row. Returns { progressByTitle, refresh }.
 */
async function getJobProgressBulk(titles, referenceUnixSeconds = Math.floor(Date.now() / 1000)) {
  const needles = [...new Set(titles.map((t) => (t || '').trim().toLowerCase()).filter(Boolean))];
  if (!needles.length) return { progressByTitle: new Map(), refresh: null };

  const { shifts, refresh } = await fetchProgressWindow(referenceUnixSeconds);
  const byTitle = new Map();
  for (const s of shifts) {
    const key = (s.title || '').trim().toLowerCase();
    if (!needles.includes(key)) continue;
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }

  const progressByTitle = new Map();
  for (const needle of needles) {
    const jobShifts = byTitle.get(needle);
    if (jobShifts?.length) progressByTitle.set(needle, summarizeJobShifts(jobShifts, referenceUnixSeconds));
  }
  return { progressByTitle, refresh };
}

// Titles that are shifts but not installation jobs (time off, meetings, etc.)
// Mirrors what mapro's connecteam-spike.js found: a scheduler holds a mix of
// real jobs (customer last names) and non-job entries with no jobsite.
const NON_JOB_TITLE = /^(off\b|available|saf[e]?tey?\s*meeting|golf outing|holiday|vacation|pto\b)/i;

/**
 * Collapses many shifts sharing a title (one job, several crew members
 * and/or several days) into a single import candidate: the nearest upcoming
 * shift if there is one, otherwise the most recent past shift. Crew and
 * attachments are merged across every shift for that job within the window.
 */
function collapseToOnePerJob(shifts, nowUnixSeconds) {
  const byTitle = new Map();
  for (const s of shifts) {
    const key = (s.title || '').trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(s);
  }

  const out = [];
  for (const group of byTitle.values()) {
    const upcoming = group.filter((s) => (s.startTime ?? -Infinity) >= nowUnixSeconds).sort((a, b) => a.startTime - b.startTime);
    const past = group.filter((s) => (s.startTime ?? -Infinity) < nowUnixSeconds).sort((a, b) => b.startTime - a.startTime);
    const representative = upcoming[0] || past[0] || group[0];

    const crew = [...new Set(group.flatMap((s) => s.crew || []))];
    const attachments = [];
    const seenUrls = new Set();
    for (const s of group) {
      for (const a of s.attachments || []) {
        if (!seenUrls.has(a.url)) {
          seenUrls.add(a.url);
          attachments.push(a);
        }
      }
    }
    const details = [...new Set(group.map((s) => s.details).filter(Boolean))].join('\n\n');

    out.push({ ...representative, crew, attachments, details, shiftDateCount: group.length });
  }
  return out;
}

module.exports = {
  ConnecteamError,
  listSchedulers,
  listShifts,
  fetchShiftsCached,
  getJobProgress,
  getJobProgressBulk,
  NON_JOB_TITLE,
  collapseToOnePerJob,
  isConfigured: () => Boolean(API_KEY),
};
