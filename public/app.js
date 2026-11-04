'use strict';

const $ = (id) => document.getElementById(id);
let snap = null;
const SERVICE_NAMES = { deezer: 'Deezer', spotify: 'Spotify' };
const serviceName = (s) => SERVICE_NAMES[s.settings.service] || 'Deezer';

// The page colours follow the music service (see style.css). Remembered so
// the next page load starts in the right colours.
function applyServiceTheme(service) {
  document.documentElement.dataset.service = service;
  localStorage.setItem('tms.service', service);
}

// ---------- API ----------

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg || '';
}

async function act(fn) {
  try {
    showError('');
    await fn();
  } catch (e) {
    showError(e.message);
  }
}

// ---------- rendering ----------

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const clock = new PlayClock();

// Counts down locally once per second; see playclock.js.
function renderTime() {
  const cur = snap && snap.current;
  const v = clock.view();
  $('np-bar').style.width = `${v.fraction * 100}%`;
  if (!v.active) {
    $('np-time').textContent = '';
    return;
  }
  const note = cur.endedAt ? ' · ended' : v.running ? '' : v.elapsed > 0 ? ' · paused' : ' · waiting for playback';
  $('np-time').textContent = `${fmt(v.elapsed)} / -${fmt(v.remaining)}${note}`;
}
setInterval(renderTime, 250);

let lastPlaylistsHtml = '';
let shareDrag = null; // { id, value } while a priority slider is being moved

// Share label: rounded percent, "<1%" for a small but non-zero share, "—" when inactive.
const fmtShare = (pct) => (pct === null || pct === undefined ? '—' : pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`);

function render(s) {
  snap = s;
  applyServiceTheme(s.settings.service);
  const plTitle = (id) => (s.playlists.find((p) => p.id === id) || {}).title || '';

  // badges
  // The connection badges appear in the header and again in the Connect tab.
  // The tab badge is for the selected music service's tab.
  const name = serviceName(s);
  const tab = s.players[s.settings.service];
  const pv = s.players.preview;
  for (const el of document.querySelectorAll('[data-badge="tab"]')) {
    el.className = 'badge' + (tab && tab.connected ? (tab.status && tab.status.activated === false ? ' warn' : ' ok') : '');
    el.textContent = !(tab && tab.connected) ? `No ${name} tab`
      : tab.status && tab.status.limited ? `${name} tab (30s-limited account)`
      : tab.status && tab.status.ad ? `${name} tab (ad playing)`
      : `${name} tab connected`;
  }
  for (const el of document.querySelectorAll('[data-badge="preview"]')) {
    el.className = 'badge' + (pv && pv.connected ? ' ok' : '');
    el.textContent = pv && pv.connected ? 'Preview player connected' : 'No preview player';
  }

  // now playing
  const cur = s.current;
  const t = cur && cur.track;
  $('np-title').textContent = t ? t.title : '—';
  $('np-artist').textContent = t ? t.artist : '';
  $('np-playlist').textContent = !t ? ''
    : cur.external ? `Picked in ${name} · the queue continues after this track`
    : `${cur.playlistId ? plTitle(cur.playlistId) : 'Requested'} · ${cur.output === 'preview' ? 'Preview' : name}`;
  $('np-cover').hidden = !(t && t.cover);
  if (t && t.cover) $('np-cover').src = t.cover;

  clock.update(s);
  renderTime();
  if (s.lastError) showError(s.lastError);

  // settings (don't overwrite a field the user is editing)
  for (const k of ['output', 'maxPlaySeconds', 'fadeSeconds', 'gapSeconds']) {
    const el = $('set-' + k);
    if (document.activeElement !== el) el.value = s.settings[k];
  }
  if (document.activeElement !== $('set-service')) $('set-service').value = s.settings.service;
  $('output-tab').textContent = `${name} tab`;
  $('tab-connect').textContent = `Connect ${name}`;
  for (const el of document.querySelectorAll('#panel-connect [data-service]')) el.hidden = el.dataset.service !== s.settings.service;
  $('add-input').placeholder = `Public ${name} playlist URL or ID`;
  $('req-input').placeholder = `${name} song URL or ID`;
  $('set-autoAdvance').checked = s.settings.autoAdvance;
  $('set-showSteps').checked = s.settings.showSteps === true;
  $('preview-host-row').hidden = s.settings.output !== 'preview';

  // playlists
  $('pool').textContent = `· ${s.poolSize} tracks in the shuffle, ${s.remainingInBag} left in this round`;
  renderShareNote(s.playlists);
  // Priority slider: the playlist's own value (0-100). Next to it, its share:
  // the value divided by the sum over all active playlists. Moving one
  // slider never moves the others. Inactive playlists keep their value.
  const html = s.playlists.length
    ? s.playlists.map((p) => {
      const off = p.share === null;
      return `
      <li>
        <input type="checkbox" data-toggle="${p.id}" ${s.settings.activePlaylistIds.includes(p.id) ? 'checked' : ''} title="Include in shuffle">
        ${p.picture ? `<img src="${esc(p.picture)}" alt="">` : ''}
        <div class="grow">
          <div><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a></div>
          <div class="muted small">${esc(p.creator)} · ${p.playableCount}/${p.trackCount} tracks playable${p.truncated ? ' <span title="Spotify shows at most 100 tracks of a playlist without signing in; later tracks are not included.">· first 100 only</span>' : ''}</div>
        </div>
        <label class="share${off ? ' off' : ''}" title="Priority 0-100 (default 50). The share is this value divided by the sum of all active playlists' values.">
          <input type="range" min="0" max="100" step="1" value="${p.priority}" data-share="${p.id}" aria-label="Priority for ${esc(p.title)}">
          <span class="share-priority" data-priority-label="${p.id}">${p.priority}</span>
          <span class="share-value" data-share-label="${p.id}">${fmtShare(p.share)}</span>
        </label>
        <button class="icon" data-refresh="${p.id}" title="Reload">↻</button>
        <button class="icon" data-delete="${p.id}" title="Delete">✕</button>
        <button class="icon toggle" data-tracks="${p.id}" aria-expanded="${p.id === openPlaylistId}" title="Show tracks">${p.id === openPlaylistId ? '▴' : '▾'}</button>
      </li>`;
    }).join('')
    : '<li class="muted">Add a public playlist to get started.</li>';
  // Rebuild only on change and never mid-drag, so a slider is not replaced under the pointer.
  if (html !== lastPlaylistsHtml && !shareDrag) {
    lastPlaylistsHtml = html;
    $('playlists').innerHTML = html;
  }
  renderTrackPanel(s);

  if (!dragQid) renderQueue(s);
  renderRequests(s);

  $('play-total').textContent = fmtTotal(s.stats.playMs);
  $('play-today').textContent = fmtTotal(s.stats.todayMs);
  refreshHistory(s);
}

function renderQueue(s) {
  const plTitle = (id) => (s.playlists.find((p) => p.id === id) || {}).title || '';
  const last = s.queue.length - 1;
  $('queue-count').textContent = s.queue.length ? `· ${s.queue.length} track${s.queue.length === 1 ? '' : 's'}` : '';
  $('queue').innerHTML = s.queue.length
    ? s.queue.map((q, i) => `
      <li draggable="true" data-qid="${esc(q.qid)}">
        <span class="pos">${i + 1}</span>
        ${q.track.cover ? `<img src="${esc(q.track.cover)}" alt="" draggable="false">` : ''}
        <div class="grow">
          <div>${esc(q.track.title)}</div>
          <div class="muted small">${esc(q.track.artist)} · ${q.track.playlistId ? esc(plTitle(q.track.playlistId)) : 'Requested'}</div>
        </div>
        ${q.pickedFor !== undefined && q.pickedFor === (s.current ? s.current.seq : null) ? '<span class="tag" title="Added with Add to Next Queue during this track">Picked</span>' : ''}
        <span class="dur">${fmt(q.track.duration)}</span>
        <div class="acts">
          <button data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="1" title="Move down" ${i === last ? 'disabled' : ''}>↓</button>
          <button data-remove title="Remove from queue">✕</button>
        </div>
      </li>`).join('')
    : '<li class="muted">The queue is empty. Press 🎲 Rolling Dice.</li>';
}

// ---------- History tab ----------
// The full history is fetched only while the History tab is open, and again
// whenever the snapshot says it changed.

let historyKey = '';

function fmtTotal(ms) {
  const m = Math.floor((ms || 0) / 60000);
  const h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : `${m}m ${Math.floor(((ms || 0) % 60000) / 1000)}s`;
}

// European style: 21:54:37 31/10/2026
function fmtPlayed(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}

async function refreshHistory(s, force) {
  if ($('panel-history').hidden || !settingsDialog.open) return;
  const key = `${s.historyInfo.count}|${s.historyInfo.latestAt}`;
  if (key === historyKey && !force) return;
  historyKey = key;
  try {
    const { history } = await api('GET', 'api/history');
    const plTitle = (h) => (s.playlists.find((p) => p.id === h.playlistId) || {}).title || h.playlistTitle || '';
    $('history-count').textContent = `${history.length} track${history.length === 1 ? '' : 's'}`;
    $('history').innerHTML = history.length
      ? history.map((h) => {
        const src = h.external ? `<span class="src-other">Picked in ${SERVICE_NAMES[h.provider] || 'Deezer'}</span>`
          : h.playlistId ? esc(plTitle(h)) : '<span class="src-other">Requested</span>';
        return `<tr><td>${fmtPlayed(h.at)}</td><td>${src}</td><td>${esc(h.title)} <span class="artist">— ${esc(h.artist)}</span></td></tr>`;
      }).join('')
      : '<tr><td colspan="3" class="muted">Nothing played yet.</td></tr>';
  } catch (e) {
    historyKey = '';
    $('history').innerHTML = `<tr><td colspan="3" class="muted">${esc(e.message)}</td></tr>`;
  }
}

$('history-clear').onclick = () => {
  if (!confirm('Clear the play history? The total play time is kept.')) return;
  act(() => api('POST', 'api/history/clear'));
};

// ---------- Adding Song panel ----------
// Songs requested by URL or ID wait in a server-side list (shared by every
// open control page) until they are added to Up next or cleared.

let requestsOpen = null; // null until the first snapshot: opens by itself when songs are waiting
let lastReqHtml = '';

function setRequestsOpen(open) {
  requestsOpen = open;
  showReqError('');
  if (snap) renderRequests(snap);
  if (open) $('req-input').focus();
}

function showReqError(msg) {
  $('req-error').hidden = !msg;
  $('req-error').textContent = msg || '';
}

function renderRequests(s) {
  if (requestsOpen === null) requestsOpen = s.requests.length > 0;
  $('q-layout').classList.toggle('open', requestsOpen);
  $('req-panel').hidden = !requestsOpen;
  $('btn-requests').setAttribute('aria-expanded', String(requestsOpen));

  const n = s.requests.length;
  $('req-count').textContent = n ? `${n} song${n === 1 ? '' : 's'}` : '';
  for (const id of ['req-first', 'req-last', 'req-clear']) $(id).disabled = !n;
  const queuedAt = new Map(s.queue.map((q, i) => [q.track.id, i + 1]));
  const html = n
    ? s.requests.map((x) => `
      <li>
        ${x.track.cover ? `<img src="${esc(x.track.cover)}" alt="">` : ''}
        <div class="grow">
          <div>${esc(x.track.title)}</div>
          <div class="muted small">${esc(x.track.artist)} · ${fmt(x.track.duration)}</div>
        </div>
        ${queuedAt.has(x.track.id) ? `<span class="tag" title="Already in Up next">In Up next #${queuedAt.get(x.track.id)}</span>` : ''}
        <button class="icon" data-remove-req="${esc(x.rid)}" title="Remove from this list">✕</button>
      </li>`).join('')
    : `<li class="muted empty">Paste a ${serviceName(s)} song link (or its ID) and press Request.</li>`;
  if (html !== lastReqHtml) {
    lastReqHtml = html;
    $('req-list').innerHTML = html;
  }
}

async function reqAction(btn, fn) {
  btn.disabled = true;
  showReqError('');
  try {
    await fn();
  } catch (e) {
    showReqError(e.message);
  } finally {
    btn.disabled = false;
    if (snap) renderRequests(snap);
  }
}

$('btn-requests').onclick = () => setRequestsOpen(!requestsOpen);

$('req-form').onsubmit = (e) => {
  e.preventDefault();
  reqAction(e.submitter, async () => {
    await api('POST', 'api/requests', { input: $('req-input').value });
    $('req-input').value = '';
    $('req-input').focus();
  });
};

$('req-list').onclick = (e) => {
  const btn = e.target.closest('button[data-remove-req]');
  if (btn) reqAction(btn, () => api('DELETE', `api/requests/${encodeURIComponent(btn.dataset.removeReq)}`));
};

$('req-first').onclick = (e) => reqAction(e.currentTarget, () => api('POST', 'api/requests/add', { where: 'first' }));
$('req-last').onclick = (e) => reqAction(e.currentTarget, () => api('POST', 'api/requests/add', { where: 'last' }));
$('req-clear').onclick = (e) => reqAction(e.currentTarget, () => api('POST', 'api/requests/clear'));

// ---------- queue editing ----------

let dragQid = null;

// Apply the new order locally right away, then let the server confirm via SSE.
function setQueueOrder(order) {
  const byQid = new Map(snap.queue.map((q) => [q.qid, q]));
  snap.queue = order.map((qid) => byQid.get(qid)).filter(Boolean);
  renderQueue(snap);
  act(() => api('POST', 'api/queue/reorder', { order }));
}

function clearDropMarks() {
  for (const el of $('queue').querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after');
}

$('queue').onclick = (e) => {
  const btn = e.target.closest('button');
  const li = e.target.closest('li[data-qid]');
  if (!btn || !li) return;
  const qid = li.dataset.qid;
  if ('remove' in btn.dataset) {
    snap.queue = snap.queue.filter((q) => q.qid !== qid);
    renderQueue(snap);
    act(() => api('DELETE', `api/queue/${encodeURIComponent(qid)}`));
  } else if (btn.dataset.move) {
    const order = snap.queue.map((q) => q.qid);
    const i = order.indexOf(qid);
    const j = i + Number(btn.dataset.move);
    if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    setQueueOrder(order);
  }
};

$('queue').addEventListener('dragstart', (e) => {
  const li = e.target.closest('li[data-qid]');
  if (!li) return;
  dragQid = li.dataset.qid;
  li.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragQid);
});

$('queue').addEventListener('dragover', (e) => {
  const li = e.target.closest('li[data-qid]');
  if (!dragQid || !li) return;
  e.preventDefault();
  clearDropMarks();
  if (li.dataset.qid === dragQid) return;
  const r = li.getBoundingClientRect();
  li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
});

$('queue').addEventListener('drop', (e) => {
  const li = e.target.closest('li[data-qid]');
  if (!dragQid || !li) return;
  e.preventDefault();
  const before = li.classList.contains('drop-before');
  const target = li.dataset.qid;
  const moving = dragQid;
  dragQid = null;
  clearDropMarks();
  if (target === moving) return renderQueue(snap);
  const order = snap.queue.map((q) => q.qid).filter((qid) => qid !== moving);
  order.splice(order.indexOf(target) + (before ? 0 : 1), 0, moving);
  setQueueOrder(order);
});

$('queue').addEventListener('dragend', () => {
  clearDropMarks();
  if (dragQid) {
    dragQid = null;
    renderQueue(snap);
  }
});

// ---------- events ----------

function connectEvents() {
  const es = new EventSource('api/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}

// Settings live in a modal opened from the gear in the header, with three
// tabs: Settings, Connect Deezer, History. It closes with the Close button,
// Esc (built into <dialog>) or a click on the backdrop.
const settingsDialog = $('settings-dialog');
const TABS = ['settings', 'connect', 'history'];

function showTab(name) {
  for (const t of TABS) {
    const on = t === name;
    $(`tab-${t}`).setAttribute('aria-selected', String(on));
    $(`tab-${t}`).tabIndex = on ? 0 : -1;
    $(`panel-${t}`).hidden = !on;
  }
  if (name === 'history' && snap) refreshHistory(snap, true);
}
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);
// Arrow keys move between tabs (standard tablist behaviour).
document.querySelector('.tabs').addEventListener('keydown', (e) => {
  const i = TABS.findIndex((t) => $(`tab-${t}`).getAttribute('aria-selected') === 'true');
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  const next = TABS[(i + d + TABS.length) % TABS.length];
  showTab(next);
  $(`tab-${next}`).focus();
});

$('btn-settings').onclick = () => {
  showTab('settings');
  settingsDialog.showModal();
};
$('settings-close').onclick = () => settingsDialog.close();
settingsDialog.addEventListener('click', (e) => {
  if (e.target === settingsDialog) settingsDialog.close(); // the backdrop, outside .modal-body
});

$('btn-next').onclick = () => act(() => api('POST', 'api/next'));
// Opens the display-only window filling a screen. Prefers a second screen
// (projector) when the browser supports the Window Management API.
$('btn-display').onclick = () => {
  const s = window.screen;
  const win = window.open('display.html', 'tms-display',
    `popup=yes,left=${s.availLeft || 0},top=${s.availTop || 0},width=${s.availWidth},height=${s.availHeight}`);
  if (!win) return showError('The browser blocked the popup. Allow popups for this site and try again.');
  win.focus();
  if (!s.isExtended || !('getScreenDetails' in window)) return;
  // The window is opened first so the click still counts as a user gesture;
  // then it is moved to the other screen.
  window.getScreenDetails().then((d) => {
    const target = d.screens.find((x) => x !== d.currentScreen);
    if (!target) return;
    win.moveTo(target.availLeft, target.availTop);
    win.resizeTo(target.availWidth, target.availHeight);
  }).catch(() => {});
};
$('btn-roll').onclick =() => act(() => api('POST', 'api/queue/roll'));
$('btn-flip').onclick = () => act(() => api('POST', 'api/queue/flip'));
$('btn-pause').onclick = () => act(() => api('POST', 'api/pause'));
$('btn-resume').onclick = () => act(() => api('POST', 'api/resume'));
$('btn-stop').onclick = () => act(() => api('POST', 'api/stop'));

// Errors for the playlist field show in red right below it.
function showPlaylistError(msg) {
  $('pl-error').hidden = !msg;
  $('pl-error').textContent = msg || '';
}

$('add-form').onsubmit = async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  showPlaylistError('');
  try {
    await api('POST', 'api/playlists', { input: $('add-input').value });
    $('add-input').value = '';
  } catch (err) {
    showPlaylistError(err.message);
  } finally {
    btn.disabled = false;
  }
};
$('add-input').addEventListener('input', () => showPlaylistError(''));

// Notes under the playlists: a share above 50% can't be reached, and
// nothing can be picked when every active playlist is at 0.
function renderShareNote(playlists) {
  const active = playlists.filter((p) => p.share !== null);
  const overHalf = active.find((p) => p.share > 50);
  const allZero = active.length > 0 && active.every((p) => p.share === 0);
  const note = allZero ? 'Every active playlist is at 0, so no track can be picked. Raise at least one slider.'
    // The same playlist never plays twice in a row, so more than half cannot be reached.
    : overHalf && active.length > 1 ? `${overHalf.title} has ${Math.round(overHalf.share)}%. The same playlist never plays twice in a row, so it plays about 50% of the time.`
    : '';
  $('share-note').hidden = !note;
  $('share-note').textContent = note;
}

// Priority sliders: moving one changes only its own value; the share labels
// of all active playlists follow live. The value is saved on release.
function showShares(id, value) {
  const priorities = { ...snap.settings.playlistPriorities, [id]: value };
  const pct = Shares.percentages(priorities, snap.settings.activePlaylistIds);
  const playlists = snap.playlists.map((p) => ({ ...p, share: p.id in pct ? pct[p.id] : null }));
  for (const p of playlists) {
    const label = $('playlists').querySelector(`[data-share-label="${p.id}"]`);
    if (label) label.textContent = fmtShare(p.share);
  }
  const own = $('playlists').querySelector(`[data-priority-label="${id}"]`);
  if (own) own.textContent = value;
  renderShareNote(playlists);
}
$('playlists').addEventListener('input', (e) => {
  const id = e.target.dataset.share;
  if (!id) return;
  shareDrag = { id, value: Number(e.target.value) };
  showShares(id, shareDrag.value);
});
$('playlists').addEventListener('change', (e) => {
  if (!e.target.dataset.share || !shareDrag) return;
  const { id, value } = shareDrag;
  shareDrag = null;
  snap.settings.playlistPriorities = { ...snap.settings.playlistPriorities, [id]: value };
  act(() => api('PATCH', 'api/settings', { playlistPriorities: { [id]: value } }));
});

// ---------- priority presets (icons next to "Playlists", see presets.js) ----------

// Each icon shows the values from the first playlist (left) to the last
// (right) as a line: flat, straight, S-curve, zigzag. Random is a die; Fast
// and Langsamer depend on the playlist names, so they get a symbol instead:
// fast-forward and a snail.
const PRESET_ICONS = {
  center: '<path d="M3 12H21"/>',
  linear: '<path d="M3 5L21 19"/>',
  'linear-rev': '<path d="M3 19L21 5"/>',
  bezier: '<path d="M3 5C11 5 13 19 21 19"/>',
  'bezier-rev': '<path d="M3 19C11 19 13 5 21 5"/>',
  chess: '<path d="M3 6L7.5 18L12 6L16.5 18L21 6"/>',
  fast: '<path d="M3 5l8.5 7L3 19zM12 5l8.5 7L12 19z" fill="currentColor" stroke="none"/>',
  slow: '<circle cx="10" cy="11.5" r="6"/><path d="M10 11.5a1.6 1.6 0 1 1 1.6 1.6 3.2 3.2 0 0 1-3.2-3.2 4.6 4.6 0 0 1 4.6-4.6"/><path d="M2.5 18.5H18c1.7 0 3-1.3 3-3V12M19.5 12l-1.2-3M21.5 12l1-3"/>',
  random: '<rect x="4" y="4" width="16" height="16" rx="3"/><g fill="currentColor" stroke="none"><circle cx="8.5" cy="8.5" r="1.4"/><circle cx="15.5" cy="8.5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="8.5" cy="15.5" r="1.4"/><circle cx="15.5" cy="15.5" r="1.4"/></g>',
};
const presetIcon = (p) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${PRESET_ICONS[p.id]}</svg>`;

$('presets').innerHTML = Presets.PRESETS.map((p) => `
  <button type="button" class="icon" data-preset="${p.id}" title="${esc(p.title)}" aria-label="${esc(p.label)}">${presetIcon(p)}</button>`).join('');

$('presets').onclick = (e) => {
  const btn = e.target.closest('button[data-preset]');
  if (!btn || !snap) return;
  const preset = Presets.PRESETS.find((p) => p.id === btn.dataset.preset);
  // Checked playlists only, in the order they are listed.
  const active = snap.playlists.filter((p) => p.share !== null);
  if (!active.length) return showError('Check at least one playlist first.');
  const values = preset.apply(active);
  const changed = Object.fromEntries(active.map((p, i) => [p.id, Shares.clampPriority(values[i])]));
  snap.settings.playlistPriorities = { ...snap.settings.playlistPriorities, ...changed };
  act(() => api('PATCH', 'api/settings', { playlistPriorities: changed }));
};

// ---------- playlist track panel ----------

let openPlaylistId = null;
// The key also changes while Spotify artwork is being filled in.
const trackKey = (p) => `${p.fetchedAt}|${p.coverCount}`;
const trackCache = new Map(); // playlistId -> { key, tracks }
let loadingTracks = null;
let lastPanelHtml = '';

function setOpenPlaylist(id) {
  if (id !== openPlaylistId) $('pl-track-filter').value = ''; // each opening starts unfiltered
  openPlaylistId = id;
  if (snap) render(snap);
  if (id) $('pl-track-filter').focus();
}

// Case- and accent-insensitive, so "senorita" finds "Señorita".
const foldText = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

async function loadTracks(p) {
  if (loadingTracks === p.id) return;
  loadingTracks = p.id;
  try {
    const data = await api('GET', `api/playlists/${p.id}/tracks`);
    trackCache.set(p.id, { key: trackKey(p), tracks: data.tracks });
  } catch (e) {
    showError(e.message);
  } finally {
    loadingTracks = null;
    if (snap) render(snap);
  }
}

// Right half of the Playlists card: the open playlist's tracks.
function renderTrackPanel(s) {
  const p = openPlaylistId && s.playlists.find((x) => x.id === openPlaylistId);
  if (!p) openPlaylistId = null;
  $('pl-layout').classList.toggle('open', !!p);
  $('pl-tracks').hidden = !p;
  if (!p) {
    lastPanelHtml = '';
    return;
  }
  $('pl-tracks-title').textContent = p.title;
  const filter = foldText($('pl-track-filter').value.trim());

  const cached = trackCache.get(p.id);
  let html;
  if (!cached || (cached.key !== trackKey(p) && !lastPanelHtml)) {
    loadTracks(p);
    $('pl-tracks-count').textContent = '';
    html = '<li class="muted">Loading tracks…</li>';
  } else {
    if (cached.key !== trackKey(p)) loadTracks(p); // refresh in the background, keep showing the list
    const queuedAt = new Map(s.queue.map((q, i) => [q.track.id, i + 1]));
    const playingId = s.current && !s.current.endedAt ? s.current.track.id : null;
    const shown = filter ? cached.tracks.filter((t) => foldText(t.title).includes(filter)) : cached.tracks;
    $('pl-tracks-count').textContent = filter ? `${shown.length} of ${cached.tracks.length} tracks` : `${cached.tracks.length} tracks`;
    html = shown.map((t) => {
      const mark = t.id === playingId ? '<span class="tag now">Playing</span>'
        : queuedAt.has(t.id) ? `<span class="tag">Queued #${queuedAt.get(t.id)}</span>` : '';
      return `
      <li${t.readable ? '' : ' class="unplayable"'}>
        ${t.cover ? `<img src="${esc(t.cover)}" alt="" loading="lazy">` : ''}
        <div class="grow">
          <div>${esc(t.title)}</div>
          <div class="muted small">${esc(t.artist)} · ${fmt(t.duration)}</div>
        </div>
        ${mark}
        <button data-next="${esc(t.id)}" ${t.readable ? '' : `disabled title="Not playable on ${serviceName(s)}"`}>Add to Next Queue</button>
      </li>`;
    }).join('') || `<li class="muted">${filter ? 'No titles match.' : 'This playlist is empty.'}</li>`;
  }
  if (html !== lastPanelHtml) {
    const list = $('pl-track-list');
    // Keep the scroll position on live updates; a new playlist or search starts at the top.
    const same = lastPanelHtml && list.dataset.playlist === p.id && list.dataset.filter === filter;
    const keepScroll = same ? list.scrollTop : 0;
    lastPanelHtml = html;
    list.innerHTML = html;
    list.dataset.playlist = p.id;
    list.dataset.filter = filter;
    list.scrollTop = keepScroll;
  }
}

$('pl-track-filter').addEventListener('input', () => {
  if (snap) renderTrackPanel(snap);
});

$('pl-track-list').onclick = (e) => {
  const btn = e.target.closest('button[data-next]');
  if (!btn) return;
  const playlistId = openPlaylistId;
  btn.disabled = true;
  act(async () => {
    await api('POST', 'api/queue/front', { playlistId, trackId: btn.dataset.next });
    setOpenPlaylist(null);
  }).finally(() => { btn.disabled = false; });
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openPlaylistId) setOpenPlaylist(null);
});

$('playlists').onclick = (e) => {
  const d = e.target.dataset;
  if (d.tracks) setOpenPlaylist(openPlaylistId === d.tracks ? null : d.tracks);
  if (d.refresh) act(() => api('POST', `api/playlists/${d.refresh}/refresh`));
  if (d.delete && confirm('Delete this playlist?')) act(() => api('DELETE', `api/playlists/${d.delete}`));
  if (d.toggle) {
    const ids = new Set(snap.settings.activePlaylistIds);
    e.target.checked ? ids.add(d.toggle) : ids.delete(d.toggle);
    act(() => api('PATCH', 'api/settings', { activePlaylistIds: [...ids] }));
  }
};

for (const k of ['output', 'maxPlaySeconds', 'fadeSeconds', 'gapSeconds']) {
  $('set-' + k).onchange = (e) => {
    const v = e.target.type === 'number' ? Number(e.target.value) : e.target.value;
    act(() => api('PATCH', 'api/settings', { [k]: v }));
  };
}
// Switching the service stops playback; each service keeps its own
// playlists, queue and song requests.
$('set-service').onchange = (e) => {
  const next = e.target.value;
  if (snap && snap.current && !snap.current.endedAt
    && !confirm(`Switch to ${SERVICE_NAMES[next]}? This stops the current track.`)) {
    e.target.value = snap.settings.service;
    return;
  }
  setOpenPlaylist(null);
  applyServiceTheme(next); // at once, before the server confirms
  act(() => api('PATCH', 'api/settings', { service: next }));
};
$('set-autoAdvance').onchange = (e) => act(() => api('PATCH', 'api/settings', { autoAdvance: e.target.checked }));
$('set-showSteps').onchange = (e) => act(() => api('PATCH', 'api/settings', { showSteps: e.target.checked }));

// ---------- preview player (30s MP3 previews, no Deezer account needed) ----------

const audio = $('preview-audio');
const PREVIEW_KEY = 'tms.previewHost';
let previewActive = null; // { seq, max, fade, ended }
let previewLoopRunning = false;

function previewEvent(ev) {
  return api('POST', 'api/player/event', {
    kind: 'preview',
    status: {
      seq: previewActive && previewActive.seq, // lets the clock ignore status left over from the previous clip
      playing: !audio.paused,
      position: audio.currentTime || 0,
      duration: previewLimit(),
    },
    ...ev,
  }).catch(() => {});
}

function previewLimit() {
  const d = audio.duration || 30;
  return previewActive && previewActive.max > 0 ? Math.min(previewActive.max, d) : d;
}

function previewFinish(type, message) {
  if (!previewActive || previewActive.ended) return;
  previewActive.ended = true;
  audio.pause();
  audio.volume = 1;
  previewEvent({ type, seq: previewActive.seq, message });
}

audio.ontimeupdate = () => {
  if (!previewActive || previewActive.ended) return;
  const limit = previewLimit();
  const left = limit - audio.currentTime;
  if (previewActive.max > 0 && previewActive.fade > 0) audio.volume = Math.max(0, Math.min(1, left / previewActive.fade));
  if (left <= 0.3) previewFinish('ended');
};
audio.onended = () => previewFinish('ended');
audio.onerror = () => previewFinish('error', 'Could not play the preview file.');

function handlePreviewCommand(cmd, seq) {
  switch (cmd.type) {
    case 'play':
      audio.pause();
      if (cmd.output !== 'preview') { previewActive = null; break; }
      previewActive = { seq, max: Number(cmd.maxPlaySeconds) || 0, fade: Number(cmd.fadeSeconds) || 0, ended: false };
      if (!cmd.previewUrl) { previewFinish('error', 'This track has no preview.'); break; }
      audio.volume = 1;
      audio.src = cmd.previewUrl;
      audio.play().catch((e) => previewFinish('error', e.message));
      break;
    case 'pause': audio.pause(); break;
    case 'resume': if (previewActive && !previewActive.ended) audio.play().catch(() => {}); break;
    case 'stop': audio.pause(); previewActive = null; break;
  }
}

async function previewLoop() {
  if (previewLoopRunning) return;
  previewLoopRunning = true;
  let since = -1;
  const statusTimer = setInterval(() => previewEvent({ type: 'status' }), 1000);
  while (localStorage.getItem(PREVIEW_KEY) === '1') {
    try {
      const r = await api('GET', `api/player/poll?kind=preview&since=${since}`);
      if (since !== -1 && r.seq > since && r.cmd) handlePreviewCommand(r.cmd, r.seq);
      since = r.seq;
    } catch {
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  clearInterval(statusTimer);
  audio.pause();
  previewLoopRunning = false;
}

$('preview-host').checked = localStorage.getItem(PREVIEW_KEY) === '1';
$('preview-host').onchange = (e) => {
  localStorage.setItem(PREVIEW_KEY, e.target.checked ? '1' : '0');
  if (e.target.checked) previewLoop();
};
if ($('preview-host').checked) previewLoop();

connectEvents();
