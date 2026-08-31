const { createClient } = require('@supabase/supabase-js');

// Server-only client using the service_role key, which bypasses Row Level
// Security. Never import this module from client-side code.
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const STATUSES = ['planned', 'confirmed', 'completed'];

function emptyChecklist() {
  return { before: false, during: false, after: false };
}

/** Converts a DB row (snake_case) to the API/frontend shape (camelCase). */
function rowToShoot(row) {
  return {
    id: row.id,
    location: row.location,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    status: row.status,
    checklist: row.checklist,
    notes: row.notes,
    connecteamShiftId: row.connecteam_shift_id,
    connecteamJobTitle: row.connecteam_job_title,
    connecteamShiftTitle: row.connecteam_shift_title,
    connecteamCrew: row.connecteam_crew,
    connecteamAttachments: row.connecteam_attachments,
    connecteamProgress: row.connecteam_progress,
    dropboxFolderPath: row.dropbox_folder_path,
    dropboxShareUrl: row.dropbox_share_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Converts a photo DB row (snake_case) to the API/frontend shape (camelCase). */
function rowToPhoto(row) {
  return {
    id: row.id,
    shootId: row.shoot_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    dropboxPath: row.dropbox_path,
    dropboxShareUrl: row.dropbox_share_url,
    uploadedAt: row.uploaded_at,
  };
}

function newShootRow(input) {
  const now = new Date().toISOString();
  return {
    id: `shoot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    location: input.location || '',
    date: input.date || '',
    start_time: input.startTime || '',
    end_time: input.endTime || '',
    status: STATUSES.includes(input.status) ? input.status : 'planned',
    checklist: { ...emptyChecklist(), ...(input.checklist || {}) },
    notes: input.notes || '',
    connecteam_shift_id: input.connecteamShiftId || null,
    connecteam_job_title: input.connecteamJobTitle || null,
    connecteam_shift_title: input.connecteamShiftTitle || null,
    connecteam_crew: input.connecteamCrew || [],
    connecteam_attachments: input.connecteamAttachments || [],
    connecteam_progress: input.connecteamProgress || null,
    created_at: now,
    updated_at: now,
  };
}

async function listShoots() {
  const { data, error } = await supabase.from('shoots').select('*').order('date', { ascending: true });
  if (error) throw error;
  return data.map(rowToShoot);
}

async function createShoot(input) {
  const row = newShootRow(input);
  const { data, error } = await supabase.from('shoots').insert(row).select().single();
  if (error) throw error;
  return rowToShoot(data);
}

/** Maps the subset of camelCase fields callers may PATCH to their DB columns. */
const PATCHABLE_FIELDS = {
  location: 'location',
  date: 'date',
  startTime: 'start_time',
  endTime: 'end_time',
  status: 'status',
  notes: 'notes',
  connecteamProgress: 'connecteam_progress',
  dropboxFolderPath: 'dropbox_folder_path',
  dropboxShareUrl: 'dropbox_share_url',
};

async function updateShoot(id, patch) {
  const { data: existing, error: fetchError } = await supabase.from('shoots').select('*').eq('id', id).single();
  if (fetchError || !existing) return null;

  const update = { updated_at: new Date().toISOString() };
  for (const [camel, column] of Object.entries(PATCHABLE_FIELDS)) {
    if (patch[camel] !== undefined) update[column] = patch[camel];
  }
  if (patch.checklist) {
    update.checklist = { ...existing.checklist, ...patch.checklist };
  }

  const { data, error } = await supabase.from('shoots').update(update).eq('id', id).select().single();
  if (error) throw error;
  return rowToShoot(data);
}

async function getShoot(id) {
  const { data, error } = await supabase.from('shoots').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? rowToShoot(data) : null;
}

/**
 * Deletes a shoot and its Supabase Storage photo copies (the photos table
 * row itself cascades via the FK, but storage objects are not part of that
 * cascade and would otherwise be orphaned).
 *
 * Returns the deleted shoot (camelCase, including dropboxFolderPath) so
 * callers can also clean up the Dropbox folder — that lives in lib/dropbox.js
 * and deliberately isn't imported here to keep this module storage-only.
 */
async function deleteShoot(id) {
  const { data: photos } = await supabase.from('photos').select('storage_path').eq('shoot_id', id);
  const paths = (photos || []).map((p) => p.storage_path).filter(Boolean);
  if (paths.length) {
    const { error: storageError } = await storageClient().remove(paths);
    if (storageError) throw storageError;
  }

  const { data, error } = await supabase.from('shoots').delete().eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data ? rowToShoot(data) : null;
}

/**
 * Finds shoots by free-text (location/notes) and/or a date range. Used by
 * the photo search view — a filter over shoots, not photos directly, since
 * that's how photos get browsed (by which shoot they belong to).
 */
async function searchShoots({ q, dateFrom, dateTo } = {}) {
  let query = supabase.from('shoots').select('*').order('date', { ascending: false });
  if (q) query = query.or(`location.ilike.%${q}%,notes.ilike.%${q}%`);
  if (dateFrom) query = query.gte('date', dateFrom);
  if (dateTo) query = query.lte('date', dateTo);

  const { data, error } = await query;
  if (error) throw error;
  return data.map(rowToShoot);
}

async function listPhotosForShoot(shootId) {
  const { data, error } = await supabase
    .from('photos')
    .select('*')
    .eq('shoot_id', shootId)
    .order('uploaded_at', { ascending: true });
  if (error) throw error;
  return data.map(rowToPhoto);
}

/** Photo counts per shoot, for annotating a shoot list without N+1 queries. */
async function photoCountsByShoot(shootIds) {
  if (!shootIds.length) return new Map();
  const { data, error } = await supabase.from('photos').select('shoot_id').in('shoot_id', shootIds);
  if (error) throw error;
  const counts = new Map();
  for (const row of data) counts.set(row.shoot_id, (counts.get(row.shoot_id) || 0) + 1);
  return counts;
}

async function createPhoto(input) {
  const row = {
    shoot_id: input.shootId,
    filename: input.filename,
    content_type: input.contentType || null,
    size_bytes: input.sizeBytes || null,
    storage_path: input.storagePath || null,
    dropbox_path: input.dropboxPath || null,
    dropbox_share_url: input.dropboxShareUrl || null,
  };
  const { data, error } = await supabase.from('photos').insert(row).select().single();
  if (error) throw error;
  return rowToPhoto(data);
}

async function getPhoto(id) {
  const { data, error } = await supabase.from('photos').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function deletePhoto(id) {
  const { data, error } = await supabase.from('photos').delete().eq('id', id).select().maybeSingle();
  if (error) throw error;
  return data || null;
}

function storageClient() {
  return supabase.storage.from('shoot-photos');
}

module.exports = {
  listShoots,
  createShoot,
  updateShoot,
  getShoot,
  deleteShoot,
  searchShoots,
  listPhotosForShoot,
  photoCountsByShoot,
  createPhoto,
  getPhoto,
  deletePhoto,
  storageClient,
};
