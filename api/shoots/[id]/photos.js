const fs = require('fs');
const { formidable } = require('formidable');
const { requireAuth } = require('../../../lib/auth');
const {
  getShoot,
  updateShoot,
  listPhotosForShoot,
  createPhoto,
  storageClient,
} = require('../../../lib/supabase');
const dropbox = require('../../../lib/dropbox');

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB per photo

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({ multiples: true, maxFileSize: MAX_FILE_BYTES });
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      else resolve({ fields, files });
    });
  });
}

async function handleGet(req, res, shootId) {
  const photos = await listPhotosForShoot(shootId);
  res.json(photos);
}

async function handlePost(req, res, shootId) {
  const shoot = await getShoot(shootId);
  if (!shoot) {
    res.status(404).json({ error: 'Shoot not found.' });
    return;
  }

  const { files } = await parseMultipart(req);
  const uploaded = [...(Array.isArray(files.photos) ? files.photos : files.photos ? [files.photos] : [])];
  if (!uploaded.length) {
    res.status(400).json({ error: 'No files under the "photos" field.' });
    return;
  }

  // Ensure the shoot has a Dropbox folder + share link, creating them on
  // first upload rather than at shoot-creation time (most shoots never get
  // photos uploaded through this app).
  let folderPath = shoot.dropboxFolderPath;
  let shareUrl = shoot.dropboxShareUrl;
  if (dropbox.isConfigured() && (!folderPath || !shareUrl)) {
    folderPath = folderPath || dropbox.folderPathFor(shoot);
    await dropbox.ensureFolder(folderPath);
    shareUrl = shareUrl || (await dropbox.ensureSharedLink(folderPath).catch(() => null));
    await updateShoot(shootId, { dropboxFolderPath: folderPath, dropboxShareUrl: shareUrl });
  }

  const results = [];
  for (const file of uploaded) {
    const buffer = fs.readFileSync(file.filepath);
    const filename = file.originalFilename || `photo-${Date.now()}`;

    let dropboxPath = null;
    if (dropbox.isConfigured() && folderPath) {
      try {
        const uploadedFile = await dropbox.uploadFile(`${folderPath}/${filename}`, buffer);
        dropboxPath = uploadedFile.path_display;
      } catch (err) {
        // A Dropbox failure shouldn't lose the photo — it still lands in
        // Supabase storage below.
        console.error('Dropbox upload failed:', err.message);
      }
    }

    const storagePath = `${shootId}/${Date.now()}-${filename}`;
    const { error: storageError } = await storageClient().upload(storagePath, buffer, {
      contentType: file.mimetype || 'application/octet-stream',
    });
    if (storageError) throw storageError;

    const photo = await createPhoto({
      shootId,
      filename,
      contentType: file.mimetype,
      sizeBytes: file.size,
      storagePath,
      dropboxPath,
      dropboxShareUrl: shareUrl,
    });
    results.push(photo);
  }

  res.status(201).json({ photos: results, dropboxFolderShareUrl: shareUrl });
}

module.exports = requireAuth(async (req, res) => {
  const { id } = req.query;
  try {
    if (req.method === 'GET') return await handleGet(req, res, id);
    if (req.method === 'POST') return await handlePost(req, res, id);
    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Must be set on the exported function after wrapping with requireAuth —
// reassigning module.exports replaces whatever was set on it before.
// Multipart bodies need the raw stream, not Vercel's default JSON parser.
module.exports.config = { api: { bodyParser: false } };
