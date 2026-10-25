'use strict';

// Display-only view: reads the same SSE snapshot as the control page and
// never sends commands.
const $ = (id) => document.getElementById(id);
const QUEUE_SHOWN = 4;

let snap = null;
const clock = new PlayClock();
const steps = new StepsView($('steps'));

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// Deezer cover URLs encode the size (".../250x250-000000-80-0-0.jpg").
const bigCover = (url) => (url ? url.replace(/\/\d+x\d+-/, '/1000x1000-') : '');

const playlistTitle = (id) => ((snap && snap.playlists.find((p) => p.id === id)) || {}).title || '';

// ---------- carousel transition between tracks ----------

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const SLIDE_MS = 750;
const SLIDE_EASE = 'cubic-bezier(.65, 0, .35, 1)';
let trackKey;        // undefined until the first render, then seq or null
let outgoing = null; // clone of the previous track sliding out
let queueKey = '';

// Step 1, before the new track is rendered: freeze the current track in a
// clone that slides out to the left.
function slideOutOldTrack() {
  if (outgoing) outgoing.remove();
  const now = $('now');
  for (const a of now.getAnimations()) a.finish();

  outgoing = now.cloneNode(true);
  outgoing.removeAttribute('id');
  for (const el of outgoing.querySelectorAll('[id]')) el.removeAttribute('id');
  outgoing.classList.add('outgoing');
  outgoing.setAttribute('aria-hidden', 'true');
  now.after(outgoing);
  const leaving = outgoing;
  leaving.animate(
    [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-55%)', opacity: 0 }],
    { duration: SLIDE_MS, easing: SLIDE_EASE, fill: 'forwards' },
  ).finished.then(() => {
    leaving.remove();
    if (outgoing === leaving) outgoing = null;
  }).catch(() => {});
  now.style.opacity = '0';
}

// Step 2, after the new track is rendered: slide it in from the right once
// its artwork is ready (or after a short wait).
function slideInNewTrack(cover) {
  const now = $('now');
  const img = $('cover');
  const ready = cover && img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  Promise.race([ready, new Promise((r) => setTimeout(r, 250))]).then(() => {
    now.style.opacity = '';
    now.animate(
      [{ transform: 'translateX(55%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: SLIDE_MS, easing: SLIDE_EASE },
    );
  });
}

function slideQueueIn() {
  [...$('queue').children].forEach((li, i) => {
    li.animate(
      [{ transform: 'translateX(40%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
      { duration: 600, delay: 200 + i * 80, easing: SLIDE_EASE, fill: 'backwards' },
    );
  });
}

function render(s) {
  snap = s;
  const cur = s.current;
  const t = cur && cur.track;

  const key = cur ? cur.seq : null;
  const changed = trackKey !== undefined && key !== trackKey && !reduceMotion.matches;
  trackKey = key;
  if (changed) slideOutOldTrack();

  // current track
  $('title').textContent = t ? t.title : 'Waiting for the next track';
  $('artist').textContent = t ? t.artist : '';
  $('dance').textContent = t ? playlistTitle(cur.playlistId) : '';
  const cover = t ? bigCover(t.cover) : '';
  if ($('cover').dataset.src !== cover) {
    $('cover').dataset.src = cover;
    $('cover').hidden = !cover;
    $('cover-ph').hidden = !!cover;
    if (cover) $('cover').src = cover;
    $('bg').style.backgroundImage = cover ? `url("${cover}")` : 'none';
  }
  if (changed) slideInNewTrack(cover);

  // playback position (when a max play time is set, the clock ends when the track will actually stop)
  clock.update(s);
  steps.set(t ? detectDance(playlistTitle(cur.playlistId), t.title) : null, s.settings.showSteps !== false);

  // state label
  let label = '';
  if (t && cur.endedAt) label = 'Next track coming up';
  else if (clock.running) label = cur.external ? 'Now playing · picked in Deezer' : 'Now playing';
  else if (t && clock.position() > 0) label = 'Paused';
  $('state').textContent = label;
  $('state').className = 'state' + (label === 'Paused' ? ' paused' : '');

  // up next
  const items = s.queue.slice(0, QUEUE_SHOWN);
  // Rebuild only when the queue changes, so running animations are not cut off.
  const qKey = items.map((q) => q.qid).join() + '|' + s.playlists.map((p) => p.title).join();
  if (qKey === queueKey) return;
  queueKey = qKey;
  $('queue').innerHTML = items.length
    ? items.map((q) => `
      <li>
        ${q.track.cover ? `<img src="${esc(q.track.cover)}" alt="">` : '<div class="ph"></div>'}
        <div class="meta">
          <div class="q-dance">${esc(playlistTitle(q.track.playlistId))}</div>
          <div class="q-title">${esc(q.track.title)}</div>
          <div class="q-artist">${esc(q.track.artist)}</div>
        </div>
      </li>`).join('')
    : '<li class="empty">Nothing queued</li>';
  if (changed) slideQueueIn();
}

// The bar moves smoothly; the numbers tick once per second.
function frame() {
  const v = clock.view();
  $('bar-fill').style.width = `${v.fraction * 100}%`;
  $('elapsed').textContent = v.active ? fmt(v.elapsed) : '';
  $('remaining').textContent = v.active && v.dur ? `-${fmt(v.remaining)}` : '';
  steps.frame(clock.position());
  requestAnimationFrame(frame);
}

function tickClock() {
  $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function connectEvents() {
  const es = new EventSource('api/events');
  es.onmessage = (e) => render(JSON.parse(e.data));
  es.onerror = () => {
    es.close();
    setTimeout(connectEvents, 2000);
  };
}

// ---------- fullscreen, cursor, wake lock ----------

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else document.documentElement.requestFullscreen().catch(() => {});
}

document.addEventListener('fullscreenchange', () => {
  $('fs-hint').hidden = !!document.fullscreenElement;
  requestWakeLock();
});
$('fs-hint').onclick = toggleFullscreen;
document.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

let idleTimer = null;
document.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
});

// Keep the projector screen from going to sleep.
let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && !wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', requestWakeLock);

// Some browsers allow this without a click (e.g. when opened by the control page).
document.documentElement.requestFullscreen().catch(() => {});
requestWakeLock();
tickClock();
setInterval(tickClock, 1000);
requestAnimationFrame(frame);
connectEvents();
