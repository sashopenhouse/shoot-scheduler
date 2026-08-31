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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

async function deleteShoot(id) {
  const { data, error } = await supabase.from('shoots').delete().eq('id', id).select().maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

module.exports = { listShoots, createShoot, updateShoot, getShoot, deleteShoot };
