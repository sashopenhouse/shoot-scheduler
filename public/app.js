const state = { shoots: [], filter: 'all' };

const el = (id) => document.getElementById(id);
const form = el('shoot-form');
const listEl = el('shoot-list');
const filtersEl = el('filters');

function fmtDate(dateStr) {
  if (!dateStr) return 'No date';
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTimeRange(start, end) {
  if (!start && !end) return '';
  if (start && end) return `${start} – ${end}`;
  return start || end;
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/** Like api(), but for multipart/form-data (file uploads) — no JSON content-type header. */
async function apiUpload(path, formData) {
  const res = await fetch(path, { method: 'POST', body: formData });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function loadShoots() {
  state.shoots = await api('/api/shoots');
  render();
}

function sortedFilteredShoots() {
  return [...state.shoots]
    .filter((s) => state.filter === 'all' || s.status === state.filter)
    .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.startTime || '').localeCompare(b.startTime || ''));
}

function render() {
  const shoots = sortedFilteredShoots();
  listEl.innerHTML = '';
  if (!shoots.length) {
    listEl.innerHTML = '<div class="empty">No shoot days yet. Add one above, or import from Connecteam.</div>';
    return;
  }
  for (const s of shoots) {
    const wrap = document.createElement('div');
    wrap.className = 'shoot';

    const phases = ['before', 'during', 'after'];
    const checklistHtml = phases
      .map((p) => {
        const done = !!s.checklist?.[p];
        return `<label class="${done ? 'done' : ''}"><input type="checkbox" data-phase="${p}" ${done ? 'checked' : ''}/> ${p[0].toUpperCase()}${p.slice(1)}</label>`;
      })
      .join('');

    wrap.innerHTML = `
      <div class="main">
        <button type="button" class="badge ${s.status}" data-action="cycle-status" title="Click to advance status">${s.status}</button>
        <div class="loc">${escapeHtml(s.location || 'Untitled site')}</div>
        <div class="when">${fmtDate(s.date)}${s.startTime || s.endTime ? ' &middot; ' + fmtTimeRange(s.startTime, s.endTime) : ''}</div>
        <div class="checklist">${checklistHtml}</div>
        ${s.connecteamProgress ? jobProgressHtml(s.connecteamProgress) : ''}
        ${s.notes ? `<div class="notes">${escapeHtml(s.notes)}</div>` : ''}
        ${
          s.connecteamAttachments?.length
            ? `<div class="notes">${s.connecteamAttachments
                .map((a) => `<a href="${a.url}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a>`)
                .join(' &middot; ')}</div>`
            : ''
        }
        <div class="photos-section">
          <div class="photos-toggle" data-action="toggle-photos">
            <span class="chev">&#9656;</span> Photos
          </div>
          <div class="photos-body" data-role="photos-body">
            <div class="status-msg" data-role="photos-status"></div>
            <div class="dropbox-link" data-role="dropbox-link"></div>
            <div class="photo-grid" data-role="photo-grid"></div>
            <div class="photo-upload-row">
              <input type="file" accept="image/*" multiple data-role="photo-input" />
              <button type="button" class="ghost" data-action="upload-photos">Upload</button>
            </div>
          </div>
        </div>
      </div>
      <div class="actions">
        <button type="button" class="ghost" data-action="edit">Edit</button>
        <button type="button" class="danger" data-action="delete">Delete</button>
      </div>
    `;

    wrap.querySelectorAll('input[data-phase]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const phase = cb.dataset.phase;
        await api(`/api/shoots/${s.id}`, {
          method: 'PUT',
          body: JSON.stringify({ checklist: { ...s.checklist, [phase]: cb.checked } }),
        });
        await loadShoots();
      });
    });

    wrap.querySelector('[data-action="cycle-status"]').addEventListener('click', async () => {
      const order = ['planned', 'confirmed', 'completed'];
      const next = order[(order.indexOf(s.status) + 1) % order.length];
      await api(`/api/shoots/${s.id}`, { method: 'PUT', body: JSON.stringify({ status: next }) });
      await loadShoots();
    });

    wrap.querySelector('[data-action="edit"]').addEventListener('click', () => startEdit(s));
    wrap.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Delete shoot day at "${s.location}"?`)) return;
      await api(`/api/shoots/${s.id}`, { method: 'DELETE' });
      await loadShoots();
    });
    wrap.querySelector('[data-action="refresh-progress"]')?.addEventListener('click', async (ev) => {
      ev.target.disabled = true;
      ev.target.textContent = '...';
      try {
        await api(`/api/shoots/${s.id}/refresh-progress`, { method: 'POST' });
        await loadShoots();
      } catch (err) {
        alert(err.message);
        ev.target.disabled = false;
        ev.target.textContent = 'Refresh';
      }
    });

    wirePhotosSection(wrap, s);

    listEl.appendChild(wrap);
  }
}

function renderPhotoGrid(gridEl, photos) {
  gridEl.innerHTML = photos
    .map((p) => {
      const href = p.dropboxShareUrl || '#';
      return `<a href="${href}" target="_blank" rel="noopener" title="${escapeHtml(p.filename)}">
        <div class="photo-thumb" style="display:flex;align-items:center;justify-content:center;font-size:0.65rem;color:var(--muted);text-align:center;padding:4px;overflow:hidden;">${escapeHtml(p.filename)}</div>
      </a>`;
    })
    .join('');
}

function wirePhotosSection(wrap, shoot) {
  const toggle = wrap.querySelector('[data-action="toggle-photos"]');
  const body = wrap.querySelector('[data-role="photos-body"]');
  const statusEl = wrap.querySelector('[data-role="photos-status"]');
  const dropboxLinkEl = wrap.querySelector('[data-role="dropbox-link"]');
  const gridEl = wrap.querySelector('[data-role="photo-grid"]');
  const fileInput = wrap.querySelector('[data-role="photo-input"]');
  const uploadBtn = wrap.querySelector('[data-action="upload-photos"]');

  let loaded = false;

  async function loadPhotos() {
    statusEl.textContent = 'Loading photos...';
    try {
      const photos = await api(`/api/shoots/${shoot.id}/photos`);
      statusEl.textContent = photos.length ? '' : 'No photos yet.';
      renderPhotoGrid(gridEl, photos);
      if (shoot.dropboxShareUrl) {
        dropboxLinkEl.innerHTML = `<a href="${shoot.dropboxShareUrl}" target="_blank" rel="noopener">Open Dropbox folder</a>`;
      }
      loaded = true;
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg error';
    }
  }

  toggle.addEventListener('click', () => {
    const isOpen = body.classList.toggle('open');
    toggle.classList.toggle('open', isOpen);
    if (isOpen && !loaded) loadPhotos();
  });

  uploadBtn.addEventListener('click', async () => {
    if (!fileInput.files.length) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    statusEl.textContent = '';
    statusEl.className = 'status-msg';
    try {
      const formData = new FormData();
      for (const file of fileInput.files) formData.append('photos', file);
      const result = await apiUpload(`/api/shoots/${shoot.id}/photos`, formData);
      if (result.dropboxFolderShareUrl) {
        shoot.dropboxShareUrl = result.dropboxFolderShareUrl;
        dropboxLinkEl.innerHTML = `<a href="${shoot.dropboxShareUrl}" target="_blank" rel="noopener">Open Dropbox folder</a>`;
      }
      fileInput.value = '';
      await loadPhotos();
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'status-msg error';
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Upload';
    }
  });
}

function jobProgressHtml(progress, { showRefresh = true } = {}) {
  const pct = Math.max(0, Math.min(100, progress.percent ?? 0));
  return `
    <div class="job-progress">
      <div class="label">
        <span>Job progress (Connecteam): ${progress.completedDays}/${progress.totalDays} days done</span>
        ${showRefresh ? '<button type="button" class="refresh" data-action="refresh-progress">Refresh</button>' : ''}
      </div>
      <div class="track"><div class="fill" style="width:${pct}%"></div></div>
    </div>
  `;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function startEdit(shoot) {
  el('shoot-id').value = shoot.id;
  el('f-location').value = shoot.location || '';
  el('f-status').value = shoot.status || 'planned';
  el('f-date').value = shoot.date || '';
  el('f-start').value = shoot.startTime || '';
  el('f-end').value = shoot.endTime || '';
  el('f-before').checked = !!shoot.checklist?.before;
  el('f-during').checked = !!shoot.checklist?.during;
  el('f-after').checked = !!shoot.checklist?.after;
  el('f-notes').value = shoot.notes || '';
  el('form-title').textContent = 'Edit shoot day';
  el('submit-btn').textContent = 'Save changes';
  el('cancel-edit').style.display = 'inline-block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetForm() {
  form.reset();
  el('shoot-id').value = '';
  el('form-title').textContent = 'New shoot day';
  el('submit-btn').textContent = 'Add shoot day';
  el('cancel-edit').style.display = 'none';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('shoot-id').value;
  const payload = {
    location: el('f-location').value.trim(),
    status: el('f-status').value,
    date: el('f-date').value,
    startTime: el('f-start').value,
    endTime: el('f-end').value,
    checklist: {
      before: el('f-before').checked,
      during: el('f-during').checked,
      after: el('f-after').checked,
    },
    notes: el('f-notes').value.trim(),
  };
  if (id) {
    await api(`/api/shoots/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
  } else {
    await api('/api/shoots', { method: 'POST', body: JSON.stringify(payload) });
  }
  resetForm();
  await loadShoots();
});

el('cancel-edit').addEventListener('click', resetForm);

filtersEl.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-filter]');
  if (!btn) return;
  state.filter = btn.dataset.filter;
  filtersEl.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
  render();
});

// --- Connecteam import ---
const importStatus = el('import-status');
const importList = el('import-list');

el('load-shifts').addEventListener('click', async () => {
  importStatus.textContent = 'Loading...';
  importStatus.className = 'status-msg';
  importList.innerHTML = '';
  try {
    const shifts = await api('/api/connecteam/shifts?days=30');
    if (!shifts.length) {
      importStatus.textContent = 'No likely job shifts found in the next 30 days.';
      return;
    }
    importStatus.textContent = `${shifts.length} shift(s) found.`;
    for (const shift of shifts) {
      const row = document.createElement('div');
      row.className = 'import-row';
      const when = shift.startTime ? new Date(shift.startTime * 1000).toLocaleString() : 'No time set';
      const crew = shift.crew?.length ? shift.crew.join(', ') : null;
      const attachCount = shift.attachments?.length || 0;
      const metaBits = [shift.location.address || 'No address on shift', when];
      if (shift.shiftDateCount > 1) metaBits.push(`${shift.shiftDateCount} scheduled entries`);
      if (crew) metaBits.push(`Crew: ${crew}`);
      if (attachCount) metaBits.push(`${attachCount} attachment${attachCount > 1 ? 's' : ''}`);
      row.dataset.shiftId = shift.shiftId;
      row.innerHTML = `
        <div style="flex:1;">
          <div><strong>${escapeHtml(shift.title || shift.jobTitle || 'Untitled shift')}</strong></div>
          <div class="meta">${metaBits.map(escapeHtml).join(' &middot; ')}</div>
          ${shift.details ? `<div class="meta" style="margin-top:3px; white-space:pre-wrap;">${escapeHtml(shift.details)}</div>` : ''}
          ${shift.progress ? jobProgressHtml(shift.progress, { showRefresh: false }) : ''}
        </div>
        <button type="button" class="ghost" data-action="schedule">Schedule</button>
      `;
      importList.appendChild(row);
    }
  } catch (err) {
    importStatus.textContent = err.message;
    importStatus.className = 'status-msg error';
  }
});

importList.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action="schedule"]');
  if (!btn) return;
  const row = btn.closest('.import-row');
  const shiftId = row.dataset.shiftId;
  btn.disabled = true;
  btn.textContent = 'Scheduling...';
  try {
    await api(`/api/connecteam/shifts/${encodeURIComponent(shiftId)}/import?days=30`, { method: 'POST' });
    await loadShoots();
    row.remove();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Schedule';
    alert(err.message);
  }
});

loadShoots().catch((err) => {
  listEl.innerHTML = `<div class="empty">Failed to load shoot days: ${escapeHtml(err.message)}</div>`;
});

// --- Photo search ---
const searchStatus = el('search-status');
const searchResults = el('search-results');

async function runSearch() {
  const q = el('search-q').value.trim();
  const dateFrom = el('search-from').value;
  const dateTo = el('search-to').value;

  searchStatus.textContent = 'Searching...';
  searchStatus.className = 'status-msg';
  searchResults.innerHTML = '';

  try {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    const results = await api(`/api/shoots/search?${params.toString()}`);

    if (!results.length) {
      searchStatus.textContent = 'No shoots match.';
      return;
    }
    searchStatus.textContent = `${results.length} shoot(s) found.`;
    for (const s of results) {
      const row = document.createElement('div');
      row.className = 'search-result';
      row.innerHTML = `
        <div>
          <div><strong>${escapeHtml(s.location || 'Untitled site')}</strong></div>
          <div class="meta">${fmtDate(s.date)} &middot; ${s.photoCount} photo${s.photoCount === 1 ? '' : 's'}</div>
        </div>
        ${s.dropboxShareUrl ? `<a href="${s.dropboxShareUrl}" target="_blank" rel="noopener">Open Dropbox folder</a>` : ''}
      `;
      searchResults.appendChild(row);
    }
  } catch (err) {
    searchStatus.textContent = err.message;
    searchStatus.className = 'status-msg error';
  }
}

el('search-btn').addEventListener('click', runSearch);
el('search-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
el('search-clear').addEventListener('click', () => {
  el('search-q').value = '';
  el('search-from').value = '';
  el('search-to').value = '';
  searchStatus.textContent = '';
  searchResults.innerHTML = '';
});
