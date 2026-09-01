const state = { shoots: [], filter: 'all', importShifts: [], showArchived: false };

function todayDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** A shoot is archived once its date has passed — undated shoots never archive. */
function isArchived(shoot) {
  return Boolean(shoot.date) && shoot.date < todayDateString();
}

function visibleShoots() {
  return state.showArchived ? state.shoots : state.shoots.filter((s) => !isArchived(s));
}

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

async function loadShoots() {
  state.shoots = await api('/api/shoots');
  render();
  updateMap();
}

function sortedFilteredShoots() {
  return visibleShoots()
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
    if (isArchived(s)) wrap.style.opacity = '0.6';
    wrap.id = `shoot-card-${s.id}`;

    const phases = ['before', 'during', 'after'];
    const checklistHtml = phases
      .map((p) => {
        const done = !!s.checklist?.[p];
        return `<label class="${done ? 'done' : ''}"><input type="checkbox" data-phase="${p}" ${done ? 'checked' : ''}/> ${p[0].toUpperCase()}${p.slice(1)}</label>`;
      })
      .join('');

    wrap.innerHTML = `
      <div class="main">
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
          <button type="button" class="badge ${s.status}" data-action="cycle-status" title="Click to advance status">${s.status}</button>
          ${s.projectType ? `<span class="type-badge">${escapeHtml(projectTypeLabel(s.projectType))}</span>` : ''}
          ${isArchived(s) ? '<span class="type-badge">Archived</span>' : ''}
        </div>
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
    const files = [...fileInput.files];
    if (!files.length) return;
    uploadBtn.disabled = true;
    statusEl.className = 'status-msg';
    try {
      // Prep once per batch: ensures the Dropbox folder exists and hands
      // back a short-lived token the browser uploads directly with — the
      // file bytes never pass through our server, so there's no Vercel
      // request-body size limit to hit.
      uploadBtn.textContent = 'Preparing...';
      const prep = await api(`/api/shoots/${shoot.id}/photos/prepare-upload`, { method: 'POST' });
      if (prep.dropboxFolderShareUrl) {
        shoot.dropboxShareUrl = prep.dropboxFolderShareUrl;
        dropboxLinkEl.innerHTML = `<a href="${shoot.dropboxShareUrl}" target="_blank" rel="noopener">Open Dropbox folder</a>`;
      }

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        uploadBtn.textContent = `Uploading ${i + 1}/${files.length}...`;
        const dropboxPath = `${prep.folderPath}/${file.name}`;

        const uploadRes = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${prep.accessToken}`,
            'Content-Type': 'application/octet-stream',
            'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath, mode: 'add', autorename: true, mute: true }),
          },
          body: file,
        });
        const uploaded = await uploadRes.json();
        if (!uploadRes.ok) throw new Error(uploaded.error_summary || `Dropbox upload failed for ${file.name}`);

        await api(`/api/shoots/${shoot.id}/photos/complete-upload`, {
          method: 'POST',
          body: JSON.stringify({
            dropboxPath: uploaded.path_display,
            filename: uploaded.name,
            contentType: file.type,
            sizeBytes: file.size,
            dropboxShareUrl: shoot.dropboxShareUrl,
          }),
        });
      }

      fileInput.value = '';
      statusEl.textContent = '';
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

const PROJECT_TYPE_LABELS = { windows: 'Windows', bathroom: 'Bathroom', doors: 'Doors', siding: 'Siding', other: 'Other' };
function projectTypeLabel(type) {
  return PROJECT_TYPE_LABELS[type] || type;
}

function startEdit(shoot) {
  el('shoot-id').value = shoot.id;
  el('f-location').value = shoot.location || '';
  el('f-status').value = shoot.status || 'planned';
  el('f-project-type').value = shoot.projectType || '';
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
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function resetForm() {
  form.reset();
  el('shoot-id').value = '';
  el('form-title').textContent = 'Schedule a custom shoot';
  el('submit-btn').textContent = 'Add shoot day';
  el('cancel-edit').style.display = 'none';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = el('shoot-id').value;
  const payload = {
    location: el('f-location').value.trim(),
    status: el('f-status').value,
    projectType: el('f-project-type').value || null,
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

el('show-archived').addEventListener('change', (e) => {
  state.showArchived = e.target.checked;
  render();
  updateMap();
});

// --- Connecteam import ---
const importStatus = el('import-status');
const importList = el('import-list');

async function loadConnecteamShifts() {
  importStatus.textContent = 'Loading...';
  importStatus.className = 'status-msg';
  importList.innerHTML = '';
  try {
    const shifts = await api('/api/connecteam/shifts?days=30');
    state.importShifts = shifts;
    updateMap();
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
      row.dataset.title = shift.title || '';
      row.innerHTML = `
        <div style="flex:1;">
          <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
            <strong>${escapeHtml(shift.title || shift.jobTitle || 'Untitled shift')}</strong>
            ${shift.guessedProjectType ? `<span class="type-badge" title="Best-effort guess from job notes">${escapeHtml(projectTypeLabel(shift.guessedProjectType))}</span>` : ''}
          </div>
          <div class="meta">${metaBits.map(escapeHtml).join(' &middot; ')}</div>
          ${shift.details ? `<div class="meta" style="margin-top:3px; white-space:pre-wrap;">${escapeHtml(shift.details)}</div>` : ''}
          ${shift.progress ? jobProgressHtml(shift.progress, { showRefresh: false }) : ''}
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; align-items:stretch;">
          <button type="button" class="ghost" style="width:90px;" data-action="schedule">Schedule</button>
          <button type="button" class="danger" style="width:90px;" data-action="remove-job">Remove</button>
        </div>
      `;
      importList.appendChild(row);
    }
  } catch (err) {
    importStatus.textContent = err.message;
    importStatus.className = 'status-msg error';
  }
}

el('load-shifts').addEventListener('click', loadConnecteamShifts);
loadConnecteamShifts();

/** Imports a Connecteam shift as a shoot day, updating shared state either way. */
async function scheduleShift(shiftId, btn) {
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Scheduling...';
  }
  try {
    await api(`/api/connecteam/shifts/${encodeURIComponent(shiftId)}/import?days=30`, { method: 'POST' });
    state.importShifts = state.importShifts.filter((s) => s.shiftId !== shiftId);
    await loadShoots();
    return true;
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Schedule';
    }
    alert(err.message);
    return false;
  }
}

/** Permanently hides a Connecteam job (by title) from the Jobs list and map. */
async function dismissJobByTitle(title, btn) {
  if (!confirm(`Remove "${title}" from the Jobs list and map? This won't affect Connecteam — it'll just stop showing up here.`)) {
    return false;
  }
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Removing...';
  }
  try {
    await api('/api/jobs/dismissed', { method: 'POST', body: JSON.stringify({ title }) });
    state.importShifts = state.importShifts.filter((s) => s.title !== title);
    updateMap();
    return true;
  } catch (err) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Remove';
    }
    alert(err.message);
    return false;
  }
}

importList.addEventListener('click', async (ev) => {
  const scheduleBtn = ev.target.closest('button[data-action="schedule"]');
  const removeBtn = ev.target.closest('button[data-action="remove-job"]');
  if (!scheduleBtn && !removeBtn) return;
  const row = (scheduleBtn || removeBtn).closest('.import-row');

  if (scheduleBtn) {
    const scheduled = await scheduleShift(row.dataset.shiftId, scheduleBtn);
    if (scheduled) row.remove();
  } else {
    const removed = await dismissJobByTitle(row.dataset.title, removeBtn);
    if (removed) row.remove();
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

// --- Map ---
const mapStatus = el('map-status');
let map = null;
let mapMarkers = [];

async function initMap() {
  try {
    const config = await api('/api/config');
    if (!config.mapboxToken) {
      mapStatus.textContent = 'Map disabled: MAPBOX_TOKEN is not set on the server.';
      return;
    }
    mapboxgl.accessToken = config.mapboxToken;
    map = new mapboxgl.Map({
      container: 'shoot-map',
      style: 'mapbox://styles/mapbox/light-v11',
      center: [-75.4, 43.1], // Central New York, as a sane default before any pins load
      zoom: 7,
    });
    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    const mapReady = new Promise((resolve) => map.on('load', resolve));

    // Geocode any shoots missing coordinates, then refresh state.shoots so
    // the newly-geocoded lat/lng actually make it into the pins — the
    // earlier loadShoots() call runs before geocoding finishes and would
    // otherwise leave state.shoots stuck without coordinates. Race this
    // against the map's own load event so pins draw as soon as both are
    // ready, regardless of which finishes first.
    await Promise.all([
      mapReady,
      api('/api/shoots/geocode', { method: 'POST' })
        .then(() => api('/api/shoots'))
        .then((shoots) => { state.shoots = shoots; })
        .catch(() => {}),
    ]);
    updateMap();
  } catch (err) {
    mapStatus.textContent = `Map failed to load: ${err.message}`;
    mapStatus.className = 'status-msg error';
  }
}

function popupWrap(innerHtml) {
  const wrap = document.createElement('div');
  wrap.style.maxWidth = '240px';
  wrap.innerHTML = innerHtml;
  return wrap;
}

function shootPopupContent(s) {
  const when = `${fmtDate(s.date)}${s.startTime || s.endTime ? ' · ' + fmtTimeRange(s.startTime, s.endTime) : ''}`;
  return popupWrap(`
    <strong>${escapeHtml(s.location || 'Untitled site')}</strong>
    ${s.projectType ? `<div>${escapeHtml(projectTypeLabel(s.projectType))}</div>` : ''}
    <div>${escapeHtml(when)}</div>
    <div style="text-transform:capitalize; color:var(--muted); margin-top:2px;">${escapeHtml(s.status)}</div>
  `);
}

function importPopupContent(shift, popup) {
  const when = shift.startTime ? new Date(shift.startTime * 1000).toLocaleString() : 'No time set';
  const crew = shift.crew?.length ? shift.crew.join(', ') : null;
  const wrap = popupWrap(`
    <strong>${escapeHtml(shift.title || shift.jobTitle || 'Untitled shift')}</strong>
    ${shift.guessedProjectType ? `<div>${escapeHtml(projectTypeLabel(shift.guessedProjectType))}</div>` : ''}
    <div>${escapeHtml(shift.location?.address || 'No address on shift')}</div>
    <div>${escapeHtml(when)}</div>
    ${crew ? `<div>Crew: ${escapeHtml(crew)}</div>` : ''}
    ${shift.details ? `<div style="margin-top:4px; white-space:pre-wrap;">${escapeHtml(shift.details)}</div>` : ''}
    ${shift.progress ? jobProgressHtml(shift.progress, { showRefresh: false }) : ''}
  `);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; margin-top:8px;';

  const scheduleBtn = document.createElement('button');
  scheduleBtn.type = 'button';
  scheduleBtn.className = 'ghost';
  scheduleBtn.style.width = '90px';
  scheduleBtn.textContent = 'Schedule';
  scheduleBtn.addEventListener('click', async () => {
    const scheduled = await scheduleShift(shift.shiftId, scheduleBtn);
    if (scheduled) popup.remove();
  });

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'danger';
  removeBtn.style.width = '90px';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', async () => {
    const removed = await dismissJobByTitle(shift.title, removeBtn);
    if (removed) popup.remove();
  });

  actions.append(scheduleBtn, removeBtn);
  wrap.appendChild(actions);
  return wrap;
}

function updateMap() {
  if (!map) return;

  mapMarkers.forEach((m) => m.remove());
  mapMarkers = [];

  const shootPoints = visibleShoots()
    .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    .map((s) => ({
      lat: s.lat,
      lng: s.lng,
      pinClass: s.status,
      onClick: () => highlightShootCard(s.id),
      buildContent: () => shootPopupContent(s),
    }));

  // Import candidates aren't saved shoots yet, so they don't have a card to
  // scroll to — the popup is the only detail available for them, plus a
  // Schedule button so a job can be turned into a shoot right from the pin.
  const importPoints = state.importShifts
    .filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number')
    .map((s) => ({
      lat: s.lat,
      lng: s.lng,
      pinClass: 'import-candidate',
      onClick: null,
      buildContent: (popup) => importPopupContent(s, popup),
    }));

  const points = [...shootPoints, ...importPoints];
  if (!points.length) {
    mapStatus.textContent = visibleShoots().length || state.importShifts.length ? 'No locations geocoded yet.' : '';
    return;
  }
  mapStatus.textContent = '';

  const bounds = new mapboxgl.LngLatBounds();
  for (const p of points) {
    const el2 = document.createElement('div');
    el2.className = `map-pin ${p.pinClass}`;

    const popup = new mapboxgl.Popup({ offset: 18 });
    popup.setDOMContent(p.buildContent(popup));

    const marker = new mapboxgl.Marker(el2).setLngLat([p.lng, p.lat]).setPopup(popup).addTo(map);
    if (p.onClick) el2.addEventListener('click', p.onClick);

    mapMarkers.push(marker);
    bounds.extend([p.lng, p.lat]);
  }

  if (points.length === 1) {
    map.jumpTo({ center: [points[0].lng, points[0].lat], zoom: 12 });
  } else {
    map.fitBounds(bounds, { padding: 50, maxZoom: 13 });
  }
}

function highlightShootCard(shootId) {
  const card = el(`shoot-card-${shootId}`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('highlighted');
  setTimeout(() => card.classList.remove('highlighted'), 2000);
}

initMap();
