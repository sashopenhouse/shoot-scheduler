// Dropbox API client — creates a per-shoot folder, uploads photos into it,
// and produces a shareable link. Auth uses a long-lived refresh token (the
// short-lived access token Dropbox hands out from it expires in ~4 hours).

const APP_KEY = process.env.DROPBOX_APP_KEY || '';
const APP_SECRET = process.env.DROPBOX_APP_SECRET || '';
const REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN || '';

class DropboxError extends Error {}

function isConfigured() {
  return Boolean(APP_KEY && APP_SECRET && REFRESH_TOKEN);
}

// Cached in-process; a fresh serverless instance just re-fetches one, which
// costs a single round-trip and is cheap compared to a Connecteam page-through.
let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.accessToken;
  }

  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString('base64'),
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN }),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new DropboxError(`Token refresh failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }

  cachedToken = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function apiCall(path, args) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.dropboxapi.com/2${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? null),
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new DropboxError(`${path} -> HTTP ${res.status} with a non-JSON body`);
  }
  if (!res.ok) {
    throw new DropboxError(`${path} -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** Sanitizes a shoot's location/id into a safe, readable Dropbox folder name segment. */
function safeSegment(str) {
  return String(str || 'shoot')
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'shoot';
}

function folderPathFor(shoot) {
  const dateSegment = shoot.date || 'undated';
  const nameSegment = safeSegment(shoot.location);
  return `/Shoots/${dateSegment} - ${nameSegment} (${shoot.id})`;
}

/** Creates the folder if it doesn't already exist; returns its path either way. */
async function ensureFolder(path) {
  try {
    await apiCall('/files/create_folder_v2', { path, autorename: false });
  } catch (err) {
    // Already exists is fine — everything else is a real failure.
    if (!(err instanceof DropboxError) || !/path\/conflict/.test(err.message)) throw err;
  }
  return path;
}

/** Creates a shared link for a folder/file, reusing one if it already exists. */
async function ensureSharedLink(path) {
  try {
    const body = await apiCall('/sharing/create_shared_link_with_settings', { path });
    return body.url;
  } catch (err) {
    if (err instanceof DropboxError && /shared_link_already_exists/.test(err.message)) {
      const list = await apiCall('/sharing/list_shared_links', { path, direct_only: true });
      return list.links?.[0]?.url || null;
    }
    throw err;
  }
}

/** Uploads one file's bytes to a Dropbox path. `contents` is a Buffer. */
async function uploadFile(path, contents) {
  const token = await getAccessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode: 'add', autorename: true, mute: true }),
    },
    body: contents,
  });
  const body = await res.json();
  if (!res.ok) {
    throw new DropboxError(`upload -> HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body; // { name, path_display, id, size, ... }
}

/** Deletes a folder (and everything in it). Missing-path is treated as success. */
async function deleteFolder(path) {
  try {
    await apiCall('/files/delete_v2', { path });
  } catch (err) {
    if (!(err instanceof DropboxError) || !/path_lookup\/not_found/.test(err.message)) throw err;
  }
}

module.exports = {
  DropboxError,
  isConfigured,
  folderPathFor,
  ensureFolder,
  deleteFolder,
  ensureSharedLink,
  uploadFile,
};
