const { requireAuth } = require('../../../../lib/auth');
const { getShoot, updateShoot } = require('../../../../lib/supabase');
const dropbox = require('../../../../lib/dropbox');

/**
 * Hands the browser everything it needs to upload photo bytes straight to
 * Dropbox, bypassing our server entirely for the large binary — Vercel
 * functions hard-cap request bodies at 4.5MB, well under a real phone
 * photo, so the old "upload through our server" route 413'd constantly.
 *
 * Returns a short-lived Dropbox access token (~4hr) and the shoot's folder
 * path. The token is scoped to this Dropbox app's permissions only
 * (files.content.write/read, sharing.write) — not a full-account secret —
 * and this route is itself gated by requireAuth like everything else.
 */
module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!dropbox.isConfigured()) {
    res.status(503).json({ error: 'Dropbox is not configured on the server.' });
    return;
  }

  const { id } = req.query;
  const shoot = await getShoot(id);
  if (!shoot) {
    res.status(404).json({ error: 'Shoot not found.' });
    return;
  }

  try {
    let folderPath = shoot.dropboxFolderPath;
    let shareUrl = shoot.dropboxShareUrl;
    if (!folderPath || !shareUrl) {
      folderPath = folderPath || dropbox.folderPathFor(shoot);
      await dropbox.ensureFolder(folderPath);
      shareUrl = shareUrl || (await dropbox.ensureSharedLink(folderPath).catch(() => null));
      await updateShoot(id, { dropboxFolderPath: folderPath, dropboxShareUrl: shareUrl });
    }

    const accessToken = await dropbox.getAccessToken();
    res.json({ accessToken, folderPath, dropboxFolderShareUrl: shareUrl });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
