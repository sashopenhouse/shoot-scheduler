const { requireAuth } = require('../../../../lib/auth');
const { getShoot, createPhoto, storageClient } = require('../../../../lib/supabase');
const dropbox = require('../../../../lib/dropbox');

/**
 * Records a photo the browser already uploaded directly to Dropbox (via
 * prepare-upload's token), and mirrors it into Supabase Storage as a
 * redundant copy. The mirror step downloads from Dropbox server-side — that
 * download+re-upload is well under the 4.5MB body-size problem since it
 * never passes through as an inbound request body, just outbound fetches.
 */
module.exports = requireAuth(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { id } = req.query;
  const { dropboxPath, filename, contentType, sizeBytes, dropboxShareUrl } = req.body || {};
  if (!dropboxPath || !filename) {
    res.status(400).json({ error: 'dropboxPath and filename are required.' });
    return;
  }

  const shoot = await getShoot(id);
  if (!shoot) {
    res.status(404).json({ error: 'Shoot not found.' });
    return;
  }

  try {
    let storagePath = null;
    try {
      const buffer = await dropbox.downloadFile(dropboxPath);
      storagePath = `${id}/${Date.now()}-${filename}`;
      const { error: storageError } = await storageClient().upload(storagePath, buffer, {
        contentType: contentType || 'application/octet-stream',
      });
      if (storageError) throw storageError;
    } catch (err) {
      // The Dropbox copy is the source of truth; losing the mirror isn't
      // worth failing the whole upload over.
      console.error('Supabase Storage mirror failed:', err.message || err);
      storagePath = null;
    }

    const photo = await createPhoto({
      shootId: id,
      filename,
      contentType,
      sizeBytes,
      storagePath,
      dropboxPath,
      dropboxShareUrl: dropboxShareUrl || shoot.dropboxShareUrl,
    });
    res.status(201).json(photo);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});
