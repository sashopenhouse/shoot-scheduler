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

    listEl.appendChild(wrap);
  }
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
