'use strict';

const $ = (id) => document.getElementById(id);
let snap = null;

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
let shareDrag = null; // { base, next } while a share slider is being moved

function render(s) {
  snap = s;
  const plTitle = (id) => (s.playlists.find((p) => p.id === id) || {}).title || '';

  // badges
  const dz = s.players.deezer;
  const bd = $('badge-deezer');
  bd.className = 'badge' + (dz && dz.connected ? (dz.status && dz.status.activated === false ? ' warn' : ' ok') : '');
  bd.textContent = dz && dz.connected
    ? (dz.status && dz.status.limited ? 'Deezer tab (30s-limited account)' : 'Deezer tab connected')
    : 'No Deezer tab';
  const pv = s.players.preview;
  $('badge-preview').className = 'badge' + (pv && pv.connected ? ' ok' : '');
  $('badge-preview').textContent = pv && pv.connected ? 'Preview player connected' : 'No preview player';

  // now playing
  const cur = s.current;
  const t = cur && cur.track;
  $('np-title').textContent = t ? t.title : '—';
  $('np-artist').textContent = t ? t.artist : '';
  $('np-playlist').textContent = !t ? ''
    : cur.external ? 'Picked in Deezer · the queue continues after this track'
    : `${plTitle(cur.playlistId)} · ${cur.output === 'preview' ? 'Preview' : 'Deezer'}`;
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
  $('set-autoAdvance').checked = s.settings.autoAdvance;
  $('set-showSteps').checked = s.settings.showSteps !== false;
  $('preview-host-row').hidden = s.settings.output !== 'preview';

  // playlists
  $('pool').textContent = `· ${s.poolSize} tracks in the shuffle, ${s.remainingInBag} left in this round`;
  // The same playlist never plays twice in a row, so more than half cannot be reached.
  const overHalf = s.playlists.find((p) => p.share > 50);
  $('share-note').hidden = !overHalf;
  if (overHalf) $('share-note').textContent = `${overHalf.title} is set above 50%. The same playlist never plays twice in a row, so it plays about 50% of the time.`;
  // Share slider: % chance that the next track comes from this playlist.
  // Fixed at 100% when only one playlist is active; unused when inactive.
  const activeCount = s.playlists.filter((p) => p.share !== null).length;
  const html = s.playlists.length
    ? s.playlists.map((p) => {
      const off = p.share === null;
      return `
      <li>
        <input type="checkbox" data-toggle="${p.id}" ${s.settings.activePlaylistIds.includes(p.id) ? 'checked' : ''} title="Include in shuffle">
        ${p.picture ? `<img src="${esc(p.picture)}" alt="">` : ''}
        <div class="grow">
          <div><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a></div>
          <div class="muted small">${esc(p.creator)} · ${p.playableCount}/${p.trackCount} tracks playable</div>
        </div>
        <label class="share${off ? ' off' : ''}" title="Chance that the next track comes from this playlist. All active playlists add up to 100%.">
          <input type="range" min="0" max="100" step="1" value="${off ? 0 : p.share}" data-share="${p.id}"
            ${off || activeCount < 2 ? 'disabled' : ''} aria-label="Share for ${esc(p.title)}">
          <span class="share-value" data-share-label="${p.id}">${off ? '—' : `${p.share}%`}</span>
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

  // history
  $('history').innerHTML = s.history.map((h) => `
    <li><div class="grow"><div>${esc(h.title)} <span class="muted">— ${esc(h.artist)}</span></div>
    <div class="muted small">${new Date(h.at).toLocaleTimeString()} · ${h.external ? 'Picked in Deezer' : esc(plTitle(h.playlistId))}</div></div></li>`).join('');
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
    : '<li class="muted empty">Paste a Deezer song link (or its ID) and press Request.</li>';
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

// Settings live in a modal opened from the gear in the header. It closes with
// the Close button, Esc (built into <dialog>) or a click on the backdrop.
const settingsDialog = $('settings-dialog');
$('btn-settings').onclick = () => settingsDialog.showModal();
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

// Share sliders: moving one updates every other slider and percentage live
// (see shares.js); the result is saved when the slider is released.
function showShares(shares) {
  for (const [id, v] of Object.entries(shares)) {
    const input = $('playlists').querySelector(`input[data-share="${id}"]`);
    const label = $('playlists').querySelector(`[data-share-label="${id}"]`);
    if (input && Number(input.value) !== v) input.value = v;
    if (label) label.textContent = `${v}%`;
  }
}
$('playlists').addEventListener('input', (e) => {
  const id = e.target.dataset.share;
  if (!id) return;
  // Always start from the shares before this drag, so moving back and forth is reversible.
  if (!shareDrag) shareDrag = { base: { ...snap.settings.playlistShares }, next: null };
  shareDrag.next = Shares.setShare(shareDrag.base, id, Number(e.target.value));
  showShares(shareDrag.next);
  e.target.value = shareDrag.next[id]; // e.g. cannot go above what the others can give
});
$('playlists').addEventListener('change', (e) => {
  if (!e.target.dataset.share || !shareDrag) return;
  const shares = shareDrag.next;
  shareDrag = null;
  snap.settings.playlistShares = shares;
  act(() => api('PATCH', 'api/settings', { playlistShares: shares }));
});

// ---------- playlist track panel ----------

let openPlaylistId = null;
const trackCache = new Map(); // playlistId -> { fetchedAt, tracks }
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
    trackCache.set(p.id, { fetchedAt: data.fetchedAt, tracks: data.tracks });
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
  if (!cached || cached.fetchedAt !== p.fetchedAt) {
    loadTracks(p);
    $('pl-tracks-count').textContent = '';
    html = '<li class="muted">Loading tracks…</li>';
  } else {
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
        <button data-next="${esc(t.id)}" ${t.readable ? '' : 'disabled title="Not playable on Deezer"'}>Add to Next Queue</button>
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
