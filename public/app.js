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

const WEIGHT_LABELS = ['½×', '1×', '2×'];
let lastPlaylistsHtml = '';

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
  // Expected share of picks: tracks in the shuffle x weight multiplier (½, 1, 2).
  const pickWeight = (p) => (s.settings.activePlaylistIds.includes(p.id) ? p.poolCount * 2 ** p.weight : 0);
  const totalWeight = s.playlists.reduce((sum, p) => sum + pickWeight(p), 0);
  const html = s.playlists.length
    ? s.playlists.map((p) => {
      const share = totalWeight ? Math.round((pickWeight(p) / totalWeight) * 100) : 0;
      return `
      <li>
        <input type="checkbox" data-toggle="${p.id}" ${s.settings.activePlaylistIds.includes(p.id) ? 'checked' : ''} title="Include in shuffle">
        ${p.picture ? `<img src="${esc(p.picture)}" alt="">` : ''}
        <div class="grow">
          <div><a href="${esc(p.link)}" target="_blank" rel="noopener">${esc(p.title)}</a></div>
          <div class="muted small">${esc(p.creator)} · ${p.playableCount}/${p.trackCount} tracks playable${pickWeight(p) ? ` · ≈ ${share}% of picks` : ''}</div>
        </div>
        <label class="weight" title="Weight: how often this playlist is picked (−1 ≈ half as often, +1 ≈ twice as often)">
          <input type="range" min="-1" max="1" step="1" value="${p.weight}" data-weight="${p.id}" aria-label="Weight for ${esc(p.title)}">
          <span class="weight-value w${p.weight + 1}">${WEIGHT_LABELS[p.weight + 1]}</span>
        </label>
        <button class="icon" data-refresh="${p.id}" title="Reload">↻</button>
        <button class="icon" data-delete="${p.id}" title="Delete">✕</button>
      </li>`;
    }).join('')
    : '<li class="muted">Add a public playlist to get started.</li>';
  // Rebuild only on change, so a slider being dragged is not replaced mid-drag.
  if (html !== lastPlaylistsHtml) {
    lastPlaylistsHtml = html;
    $('playlists').innerHTML = html;
  }

  if (!dragQid) renderQueue(s);

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
          <div class="muted small">${esc(q.track.artist)} · ${esc(plTitle(q.track.playlistId))}</div>
        </div>
        <span class="dur">${fmt(q.track.duration)}</span>
        <div class="acts">
          <button data-move="-1" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button data-move="1" title="Move down" ${i === last ? 'disabled' : ''}>↓</button>
          <button data-remove title="Remove from queue">✕</button>
        </div>
      </li>`).join('')
    : '<li class="muted">The queue is empty. Press 🎲 Rolling Dice.</li>';
}

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

$('add-form').onsubmit = (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  act(async () => {
    await api('POST', 'api/playlists', { input: $('add-input').value });
    $('add-input').value = '';
  }).finally(() => { btn.disabled = false; });
};

// Weight slider: update the label while dragging, save when released.
$('playlists').addEventListener('input', (e) => {
  if (!e.target.dataset.weight) return;
  const v = Number(e.target.value);
  const label = e.target.nextElementSibling;
  label.textContent = WEIGHT_LABELS[v + 1];
  label.className = `weight-value w${v + 1}`;
});
$('playlists').addEventListener('change', (e) => {
  const id = e.target.dataset.weight;
  if (!id) return;
  const weights = { ...snap.settings.playlistWeights, [id]: Number(e.target.value) };
  act(() => api('PATCH', 'api/settings', { playlistWeights: weights }));
});

$('playlists').onclick = (e) => {
  const d = e.target.dataset;
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
