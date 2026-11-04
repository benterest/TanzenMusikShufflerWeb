// Tanzen Music Shuffler: picks random tracks from public Deezer or Spotify
// playlists and sends "play" commands to a player (userscript in a deezer.com
// or open.spotify.com tab, or the preview player in the control page).
// Zero dependencies, Node >= 20.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const deezer = require('./deezer');
const spotify = require('./spotify');
const store = require('./store');
const Shares = require('../public/shares');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const POLL_TIMEOUT_MS = 25000;
const SYNC_HOLD_MS = 1000;
const PLAYER_ALIVE_MS = POLL_TIMEOUT_MS + 10000;
const HISTORY_MAX = 500;
const QUEUE_ROLL = 10; // tracks added per Rolling Dice / Flip Board (and when the queue runs empty)

const state = store.load();
// Older versions stored -1/0/+1 weights (½x, 1x, 2x), and later shares that
// added up to 100 (also kept per service in the stash). Turn them into
// priorities once, keeping their proportions.
{
  const pr = state.settings.playlistPriorities;
  const keep = (from) => { for (const [id, v] of Object.entries(from)) if (!(id in pr)) pr[id] = v; };
  if (state.settings.playlistWeights) {
    const w = state.settings.playlistWeights;
    keep(Object.fromEntries(Object.keys(w).map((id) => [id, Shares.clampPriority(Shares.DEFAULT_PRIORITY * 2 ** (Number(w[id]) || 0))])));
    delete state.settings.playlistWeights;
  }
  for (const holder of [state.settings, ...Object.values(state.stash || {})]) {
    if (holder.playlistShares) keep(Shares.fromShares(holder.playlistShares));
    delete holder.playlistShares;
  }
  state.settings.playlistPriorities = Shares.sanitize(pr);
}
// Older versions had only Deezer, and output 'deezer' meant the Deezer tab.
if (state.settings.output !== 'preview') state.settings.output = 'tab';
for (const p of Object.values(state.playlists)) p.provider ||= 'deezer';

// ---------- music service ----------
// One service is used at a time. Its playlists, active set, queue and
// requests are what the rest of the server works with; the other service's
// active set, queue and requests wait in state.stash. Priorities are kept per
// playlist id, so they need no stash.

const PROVIDERS = { deezer, spotify };
const SERVICE_NAMES = { deezer: 'Deezer', spotify: 'Spotify' };
if (!PROVIDERS[state.settings.service]) state.settings.service = 'deezer';

const provider = () => PROVIDERS[state.settings.service];
const serviceName = () => SERVICE_NAMES[state.settings.service];
const ofService = (pl) => !!pl && pl.provider === state.settings.service;
// Output for play commands and the current track: the service's tab
// ('deezer' / 'spotify', as the userscripts expect) or 'preview'.
const playOutput = () => (state.settings.output === 'preview' ? 'preview' : state.settings.service);

const runtime = {
  bags: {},                          // playlistId -> { key, ids } shuffle bag per playlist
  // Only the latest command matters. seq starts at boot time so it keeps
  // increasing across restarts and players never miss a command.
  command: { seq: Date.now(), cmd: null },
  waiters: [],                       // pending long-poll responses
  players: {},                       // kind -> { lastSeen, status }
  advanceTimer: null,
  lastError: null,
};
// The current track { seq, track, playlistId, startedAt, output, endedAt?, hint? }
// is saved with the state, so restarting the server (e.g. a redeploy) does not
// interrupt playback tracking or auto-advance.
Object.defineProperty(runtime, 'current', {
  get: () => state.current,
  set: (v) => {
    state.current = v;
    store.save(state);
  },
});
const sseClients = new Set();

// ---------- shuffling ----------

function pool() {
  const seen = new Set();
  const tracks = [];
  for (const pid of state.settings.activePlaylistIds) {
    const pl = state.playlists[pid];
    if (!pl) continue;
    for (const t of pl.tracks) {
      if (!t.readable || seen.has(t.id)) continue;
      seen.add(t.id);
      tracks.push({ ...t, playlistId: pid });
    }
  }
  return tracks;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Playlist priorities (settings.playlistPriorities, see shares.js): each
// playlist's own 0-100 value. Its share is its value divided by the sum over
// the active playlists. The next track comes from a playlist picked by share,
// regardless of how many tracks it has; inside that playlist a "bag" plays
// every track once before any repeats. Tracks that are already queued or
// playing are never drawn again.
function shares() {
  return Shares.percentages(state.settings.playlistPriorities, state.settings.activePlaylistIds);
}

function playableIds(pid) {
  const pl = state.playlists[pid];
  return pl ? pl.tracks.filter((t) => t.readable).map((t) => t.id) : [];
}

// Next track from one playlist's bag, or null if it has nothing left to offer.
function drawFromPlaylist(pid, exclude) {
  const ids = playableIds(pid);
  const key = [...ids].sort().join(',');
  let bag = runtime.bags[pid];
  if (!bag || bag.key !== key) bag = runtime.bags[pid] = { key, ids: [] };
  const valid = new Set(ids);
  bag.ids = bag.ids.filter((id) => valid.has(id) && !exclude.has(id));
  if (bag.ids.length === 0) bag.ids = shuffle(ids.filter((id) => !exclude.has(id)));
  const id = bag.ids.pop();
  if (!id) return null;
  const t = state.playlists[pid].tracks.find((x) => x.id === id);
  return { ...t, playlistId: pid };
}

// Picking never takes the previous playlist again right away. On its own
// that pulls the mix toward equal, so the pick weights are corrected for it:
// with weights w, the long-run mix is proportional to w_i * (W - w_i), and
// this solves for weights whose long-run mix equals the shares. Exact when
// no share is above 50%; a playlist above 50% ends up at about 50%, since
// there are not enough other tracks to put between its own.
function noRepeatWeights(shares) {
  const ids = Object.keys(shares).filter((id) => shares[id] > 0);
  const plain = Object.fromEntries(ids.map((id) => [id, shares[id] / 100]));
  if (ids.length < 3) return plain; // with 2 playlists picks simply alternate

  // Reachable target mix: a playlist above 50% is held just under 50%,
  // and the others keep their proportions in the rest.
  const target = { ...plain };
  const top = ids.reduce((a, b) => (target[a] >= target[b] ? a : b));
  if (target[top] >= 0.5) {
    const rest = 1 - target[top];
    target[top] = 0.49;
    for (const id of ids) if (id !== top) target[id] = (plain[id] / rest) * 0.51;
  }

  const w = { ...target };
  for (let it = 0; it < 200; it++) {
    const W = ids.reduce((s, id) => s + w[id], 0);
    const mix = Object.fromEntries(ids.map((id) => [id, w[id] * (W - w[id])]));
    const Z = ids.reduce((s, id) => s + mix[id], 0);
    if (!(Z > 0)) break;
    for (const id of ids) w[id] *= target[id] / (mix[id] / Z);
    const sum = ids.reduce((s, id) => s + w[id], 0);
    for (const id of ids) w[id] /= sum;
  }
  return ids.every((id) => Number.isFinite(w[id]) && w[id] > 0) ? w : plain;
}

// Draws n tracks. `prevPid` is the playlist of the track just before them.
function draw(n, prevPid) {
  const weights = noRepeatWeights(shares());
  const exclude = new Set(state.queue.map((q) => q.track.id));
  if (runtime.current) exclude.add(runtime.current.track.id);
  const exhausted = new Set();

  const out = [];
  let prev = prevPid;
  while (out.length < n) {
    let candidates = state.settings.activePlaylistIds
      .filter((pid) => (weights[pid] || 0) > 0 && !exhausted.has(pid));
    // Not the same playlist twice in a row, unless it is the only one left.
    if (candidates.some((pid) => pid !== prev)) candidates = candidates.filter((pid) => pid !== prev);
    const total = candidates.reduce((s, pid) => s + weights[pid], 0);
    if (total <= 0) break;
    let r = Math.random() * total;
    const pid = candidates.find((p) => (r -= weights[p]) < 0) || candidates[candidates.length - 1];
    const track = drawFromPlaylist(pid, exclude);
    if (!track) {
      exhausted.add(pid); // everything in it is queued or playing: pick again without it
      continue;
    }
    exclude.add(track.id);
    out.push(track);
    prev = pid;
  }
  return out;
}

// Tracks removed from the queue without playing go back into their playlist's bag.
function returnToBag(items) {
  for (const q of items) {
    const bag = runtime.bags[q.track.playlistId];
    if (bag) bag.ids.splice(Math.floor(Math.random() * (bag.ids.length + 1)), 0, q.track.id);
  }
}

// ---------- queue ----------

// Avoids the same playlist (genre) twice in a row: when an item has the same
// playlist as the one before it, it swaps places with the next item from a
// different playlist. `prevPid` is the playlist of whatever plays just before.
// If no different playlist is left, the remaining items stay as they are.
function spreadPlaylists(items, prevPid) {
  for (let i = 0; i < items.length; i++) {
    const before = i === 0 ? prevPid : items[i - 1].track.playlistId;
    if (!before || items[i].track.playlistId !== before) continue;
    const j = items.findIndex((q, k) => k > i && q.track.playlistId !== before);
    if (j === -1) break;
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function rollDice() {
  const last = state.queue.length ? state.queue[state.queue.length - 1].track : runtime.current && runtime.current.track;
  const prevPid = last && last.playlistId;
  const added = draw(QUEUE_ROLL, prevPid).map((track) => ({ qid: crypto.randomUUID(), track }));
  // Safety net for when only one playlist had tracks left to give.
  spreadPlaylists(added, prevPid);
  state.queue.push(...added);
  return added.length;
}

function ensureQueue() {
  if (state.queue.length === 0) rollDice();
}

function flipBoard() {
  const old = state.queue;
  state.queue = [];
  returnToBag(old);
  rollDice();
}

function removeFromQueue(qid) {
  const removed = state.queue.filter((q) => q.qid === qid);
  state.queue = state.queue.filter((q) => q.qid !== qid);
  returnToBag(removed);
}

// Unknown qids are ignored; items missing from `order` keep their relative order at the end.
function reorderQueue(order) {
  const byQid = new Map(state.queue.map((q) => [q.qid, q]));
  const next = [];
  for (const qid of order) {
    const q = byQid.get(qid);
    if (q) { next.push(q); byQid.delete(qid); }
  }
  state.queue = [...next, ...byQid.values()];
}

// ---------- player commands ----------

function sendCommand(cmd) {
  runtime.command = { seq: runtime.command.seq + 1, cmd };
  const waiters = runtime.waiters;
  runtime.waiters = [];
  for (const w of waiters) respondPoll(w);
  return runtime.command.seq;
}

function respondPoll(w) {
  clearTimeout(w.timer);
  if (!w.res.writableEnded) sendJson(w.res, 200, runtime.command);
}

// Answers at once if a command newer than `since` exists, otherwise holds the
// response until one arrives or `timeoutMs` passes.
function waitForCommand(res, since, timeoutMs) {
  const w = { res, timer: null };
  if (runtime.command.seq > since) return respondPoll(w);
  w.timer = setTimeout(() => {
    runtime.waiters = runtime.waiters.filter((x) => x !== w);
    respondPoll(w);
  }, timeoutMs);
  runtime.waiters.push(w);
  res.on('close', () => {
    clearTimeout(w.timer);
    runtime.waiters = runtime.waiters.filter((x) => x !== w);
  });
}

async function playNext() {
  clearTimeout(runtime.advanceTimer);
  ensureQueue();
  const item = state.queue.shift();
  if (!item) throw new Error('No playable tracks in the active playlists.');
  const { track } = item;
  const { maxPlaySeconds, fadeSeconds } = state.settings;
  const output = playOutput();
  const cmd = { type: 'play', output, track, maxPlaySeconds, fadeSeconds };
  if (output === 'preview') {
    try {
      // Deezer preview URLs are signed and expire, so they are fetched right
      // before playing; Spotify's come with the playlist.
      cmd.previewUrl = track.previewUrl || await provider().fetchPreviewUrl(track.id);
    } catch (e) {
      state.queue.unshift(item); // keep the track at the head of the queue
      throw e;
    }
  }

  const seq = sendCommand(cmd);
  runtime.current = { seq, track, playlistId: track.playlistId, startedAt: Date.now(), output };
  runtime.lastError = null;
  addHistory(track);
  ensureQueue();
  store.save(state);
  broadcast();
  return track;
}

function scheduleAdvance() {
  clearTimeout(runtime.advanceTimer);
  if (!state.settings.autoAdvance) return;
  runtime.advanceTimer = setTimeout(() => {
    playNext().catch((e) => { runtime.lastError = e.message; broadcast(); });
  }, Math.max(0, state.settings.gapSeconds) * 1000);
}

// The playlist name is stored too, so entries keep it after the playlist is deleted.
function addHistory(track, extra = {}) {
  const pl = track.playlistId && state.playlists[track.playlistId];
  state.history.unshift({
    id: track.id, title: track.title, artist: track.artist,
    playlistId: track.playlistId || null, playlistTitle: pl ? pl.title : '',
    provider: state.settings.service,
    ...extra, at: new Date().toISOString(),
  });
  state.history.length = Math.min(state.history.length, HISTORY_MAX);
}

// Total play time counts while the player reports the current track playing
// (not ads, not pauses). Status arrives about once a second; longer gaps are
// not counted. Saved at most every 30s (and on shutdown). Today's play time
// starts again from 0 at local midnight (TZ in docker-compose.yml).
let statsSavedAt = 0;

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function statsView() {
  return { playMs: state.stats.playMs, todayMs: state.stats.day === todayKey() ? state.stats.todayMs : 0 };
}
function countPlayTime(kind, p, status) {
  const cur = runtime.current;
  const now = Date.now();
  const playing = !!(cur && cur.output === kind && status.playing && !cur.endedAt
    && (kind === 'preview' ? status.seq === cur.seq
      : status.songId === cur.track.id || (!!status.title && status.title === cur.track.title)));
  if (playing && p.playingSince) {
    const d = now - p.playingSince;
    if (d > 0 && d < 5000) {
      const day = todayKey();
      if (state.stats.day !== day) {
        state.stats.day = day;
        state.stats.todayMs = 0;
      }
      state.stats.playMs += d;
      state.stats.todayMs += d;
    }
    if (now - statsSavedAt > 30000) {
      statsSavedAt = now;
      store.save(state);
    }
  }
  p.playingSince = playing ? now : null;
}

function findKnownTrack(id) {
  const ids = [...state.settings.activePlaylistIds, ...Object.keys(state.playlists)];
  for (const pid of ids) {
    const t = state.playlists[pid] && state.playlists[pid].tracks.find((x) => x.id === id);
    if (t) return { ...t, playlistId: pid };
  }
  return null;
}

// A track picked directly in the Deezer or Spotify tab becomes the current
// track. The queue is kept as it is, so playback continues from it once this
// track ends.
function startExternal(kind, ev) {
  const id = String(ev.songId || '');
  if (!id || playOutput() !== kind) return;
  clearTimeout(runtime.advanceTimer);

  const known = findKnownTrack(id);
  const track = known || {
    id,
    title: ev.title || '',
    artist: ev.artist || '',
    album: ev.album || '',
    cover: ev.cover || (ev.albumPicture ? `https://cdn-images.dzcdn.net/images/cover/${ev.albumPicture}/250x250-000000-80-0-0.jpg` : ''),
    duration: Math.round(Number(ev.duration) || 0),
    readable: true,
    playlistId: null,
  };
  const seq = `ext-${Date.now()}`;
  runtime.current = {
    seq, track, playlistId: track.playlistId, startedAt: Date.now(), output: kind,
    external: true, startPosition: Number(ev.position) || 0,
  };
  // Don't play it twice: drop it from the queue if it was waiting there.
  state.queue = state.queue.filter((q) => q.track.id !== id);
  ensureQueue();
  addHistory(track, { external: true });
  store.save(state);

  // Fill in artwork and length from the public API for tracks not in any playlist.
  if (!known) {
    provider().fetchTrack(id).then((t) => {
      if (!runtime.current || runtime.current.seq !== seq) return;
      const cover = t.cover || runtime.current.track.cover;
      runtime.current = { ...runtime.current, track: { ...t, cover, playlistId: null } };
      broadcast();
    }).catch(() => {});
  }
}

function handlePlayerEvent(ev) {
  const kind = ['preview', 'spotify'].includes(ev.kind) ? ev.kind : 'deezer';
  const p = (runtime.players[kind] ||= { lastSeen: 0, status: null });
  p.lastSeen = Date.now();
  if (ev.status) {
    p.status = ev.status;
    countPlayTime(kind, p, ev.status);
    // The Spotify tab knows the artwork of what it plays: use it when the
    // background fill (fillCovers) has not reached this track yet.
    const cur = runtime.current;
    if (kind === 'spotify' && ev.status.cover && cur && !cur.track.cover && ev.status.songId === cur.track.id) {
      setCover(cur.track.id, ev.status.cover);
    }
  }

  const cur = runtime.current;
  const isCurrent = cur && cur.output === kind
    && (ev.seq === cur.seq || (cur.external && ev.external && String(ev.songId) === cur.track.id));
  if (ev.type === 'external' && kind !== 'preview') {
    startExternal(kind, ev);
  } else if (ev.type === 'ended' && isCurrent) {
    runtime.current = { ...cur, endedAt: Date.now() };
    scheduleAdvance();
  } else if (ev.type === 'error' && isCurrent) {
    runtime.lastError = `${cur.track.title}: ${ev.message || 'playback failed'}`;
    scheduleAdvance();
  }
  broadcast();
}

// ---------- Spotify artwork ----------
// The Spotify playlist embed has no artwork per track. It is filled in from
// each track's own embed page in the background, a few at a time.

function setCover(id, cover) {
  const lists = [
    ...Object.values(state.playlists).filter((p) => p.provider === 'spotify').map((p) => p.tracks),
    state.queue.map((q) => q.track),
    state.requests.map((x) => x.track),
  ];
  for (const list of lists) for (const t of list) if (t.id === id && !t.cover) t.cover = cover;
  const cur = runtime.current;
  if (cur && cur.track.id === id && !cur.track.cover) runtime.current = { ...cur, track: { ...cur.track, cover } };
}

const coverFills = new Set();
async function fillCovers(pid) {
  if (coverFills.has(pid)) return;
  coverFills.add(pid);
  let shownAt = Date.now();
  try {
    const pl = state.playlists[pid];
    const todo = pl ? pl.tracks.filter((t) => !t.cover).map((t) => t.id) : [];
    const worker = async () => {
      while (todo.length && state.playlists[pid]) {
        const id = todo.shift();
        try {
          const t = await spotify.fetchTrack(id);
          if (t.cover) setCover(id, t.cover);
        } catch { /* keep going without this one */ }
        if (Date.now() - shownAt > 2000) {
          shownAt = Date.now();
          broadcast();
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally {
    coverFills.delete(pid);
    store.save(state);
    broadcast();
  }
}

// Each service keeps its own active playlists, queue and requests.
// Switching stops playback and brings back the other service's set.
function switchService(next) {
  clearTimeout(runtime.advanceTimer);
  if (runtime.current) {
    sendCommand({ type: 'stop' });
    runtime.current = null;
  }
  const s = state.settings;
  state.stash[s.service] = {
    activePlaylistIds: s.activePlaylistIds,
    queue: state.queue, requests: state.requests,
  };
  const saved = state.stash[next] || {};
  delete state.stash[next];
  s.service = next;
  s.activePlaylistIds = (saved.activePlaylistIds || []).filter((id) => ofService(state.playlists[id]));
  state.queue = (saved.queue || []).filter((q) => !q.track.playlistId || ofService(state.playlists[q.track.playlistId]));
  state.requests = saved.requests || [];
  runtime.lastError = null;
}

// ---------- snapshot / SSE ----------

function snapshot() {
  const now = Date.now();
  const pct = shares();
  const players = {};
  for (const [kind, p] of Object.entries(runtime.players)) {
    players[kind] = { connected: now - p.lastSeen < PLAYER_ALIVE_MS, status: p.status };
  }
  return {
    settings: state.settings,
    // Only the current service's playlists.
    playlists: Object.values(state.playlists).filter(ofService).map((p) => ({
      id: p.id, title: p.title, creator: p.creator, picture: p.picture, link: p.link,
      trackCount: p.tracks.length, playableCount: p.tracks.filter((t) => t.readable).length,
      truncated: !!p.truncated,
      priority: Shares.priorityOf(state.settings.playlistPriorities, p.id),
      share: state.settings.activePlaylistIds.includes(p.id) ? pct[p.id] : null, // percent, not rounded
      fetchedAt: p.fetchedAt,
      coverCount: p.tracks.filter((t) => t.cover).length, // grows while Spotify artwork is filled in
    })),
    poolSize: pool().length,
    remainingInBag: state.settings.activePlaylistIds.reduce((s, pid) => s + ((runtime.bags[pid] || {}).ids || []).length, 0),
    current: runtime.current,
    queue: state.queue,
    requests: state.requests,
    // The full history is fetched from /api/history; this tells pages when it changed.
    historyInfo: { count: state.history.length, latestAt: state.history.length ? state.history[0].at : null },
    stats: statsView(),
    players,
    lastError: runtime.lastError,
  };
}

function broadcast() {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of sseClients) res.write(data);
}

// Refresh connection indicators when players silently go away.
setInterval(broadcast, 10000).unref();

// ---------- HTTP helpers ----------

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    let body = buf;
    if (pathname.endsWith('.user.js')) {
      // Bake this server's address into the userscript so it works after install.
      const proto = req.headers['x-forwarded-proto'] || 'http';
      body = buf.toString('utf8').replaceAll('__SERVER_URL__', `${proto}://${req.headers.host}`);
    }
    res.writeHead(200, {
      'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  });
}

// ---------- routes ----------

const SETTING_KEYS = Object.keys(state.settings);

async function route(req, res, url) {
  const { pathname } = url;
  const m = (method, pattern) => req.method === method && pattern.test(pathname) && pathname.match(pattern);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  if (m('GET', /^\/api\/state$/)) return sendJson(res, 200, snapshot());

  if (m('GET', /^\/api\/events$/)) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (m('POST', /^\/api\/playlists$/)) {
    const body = await readJson(req);
    const id = await provider().resolvePlaylistId(body.input);
    const pl = await provider().fetchPlaylist(id);
    state.playlists[pl.id] = pl;
    if (pl.provider === 'spotify') fillCovers(pl.id);
    if (!state.settings.activePlaylistIds.includes(pl.id)) state.settings.activePlaylistIds.push(pl.id);
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { id: pl.id, title: pl.title, trackCount: pl.tracks.length });
  }

  let r;
  if ((r = m('POST', /^\/api\/playlists\/([A-Za-z0-9]+)\/refresh$/))) {
    const old = state.playlists[r[1]];
    if (!ofService(old)) return sendJson(res, 404, { error: 'Playlist not found.' });
    const pl = await PROVIDERS[old.provider].fetchPlaylist(r[1]);
    // Keep artwork already filled in for Spotify tracks.
    const covers = new Map(old.tracks.map((t) => [t.id, t.cover]));
    for (const t of pl.tracks) if (!t.cover && covers.get(t.id)) t.cover = covers.get(t.id);
    state.playlists[pl.id] = pl;
    if (pl.provider === 'spotify') fillCovers(pl.id);
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { id: pl.id, trackCount: pl.tracks.length });
  }

  if ((r = m('DELETE', /^\/api\/playlists\/([A-Za-z0-9]+)$/))) {
    delete state.playlists[r[1]];
    delete state.settings.playlistPriorities[r[1]];
    state.settings.activePlaylistIds = state.settings.activePlaylistIds.filter((id) => id !== r[1]);
    state.queue = state.queue.filter((q) => q.track.playlistId !== r[1]);
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (m('PATCH', /^\/api\/settings$/)) {
    const body = await readJson(req);
    if (PROVIDERS[body.service] && body.service !== state.settings.service) switchService(body.service);
    const prioritiesBefore = state.settings.playlistPriorities;
    for (const k of SETTING_KEYS) if (k in body && k !== 'service') state.settings[k] = body[k];
    if (state.settings.output !== 'preview') state.settings.output = 'tab';
    // Priorities are merged, so a page only needs to send the ones it changed.
    if ('playlistPriorities' in body) {
      state.settings.playlistPriorities = Shares.sanitize({ ...prioritiesBefore, ...Shares.sanitize(body.playlistPriorities) });
    }
    state.settings.activePlaylistIds = state.settings.activePlaylistIds.map(String).filter((id) => ofService(state.playlists[id]));
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, state.settings);
  }

  if (m('POST', /^\/api\/next$/)) {
    const track = await playNext();
    return sendJson(res, 200, { track });
  }

  if ((r = m('GET', /^\/api\/playlists\/([A-Za-z0-9]+)\/tracks$/))) {
    const pl = state.playlists[r[1]];
    if (!pl) return sendJson(res, 404, { error: 'Playlist not found.' });
    return sendJson(res, 200, { id: pl.id, fetchedAt: pl.fetchedAt, tracks: pl.tracks });
  }

  // Puts a chosen track near the top of the queue. Picks made while the same
  // track is playing line up in the order they were made (#1, #2, ...); once
  // the next track starts, the next pick goes to #1 again. A track that was
  // already queued moves up instead of appearing twice.
  if (m('POST', /^\/api\/queue\/front$/)) {
    const body = await readJson(req);
    const pl = state.playlists[String(body.playlistId)];
    const t = ofService(pl) && pl.tracks.find((x) => x.id === String(body.trackId));
    if (!t) return sendJson(res, 404, { error: 'Track not found.' });
    if (!t.readable) return sendJson(res, 400, { error: `This track is not playable on ${serviceName()}.` });
    const pickedFor = runtime.current ? runtime.current.seq : null;
    state.queue = state.queue.filter((q) => q.track.id !== t.id);
    let at = 0;
    while (at < state.queue.length && state.queue[at].pickedFor === pickedFor) at++;
    state.queue.splice(at, 0, { qid: crypto.randomUUID(), track: { ...t, playlistId: pl.id }, pickedFor });
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (m('POST', /^\/api\/queue\/roll$/)) {
    const added = rollDice();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { added });
  }

  // "Adding Song" panel: songs requested by URL or ID wait here, untouched by
  // playback, until they are added to the queue or cleared.
  if (m('POST', /^\/api\/requests$/)) {
    const body = await readJson(req);
    const id = await provider().resolveTrackId(body.input);
    if (state.requests.some((x) => x.track.id === id)) throw new Error('This song is already in the list.');
    const known = findKnownTrack(id);
    const t = known || { ...(await provider().fetchTrack(id)), playlistId: null };
    if (!t.readable) throw new Error(`"${t.title}" is not playable on ${serviceName()}.`);
    state.requests.push({ rid: crypto.randomUUID(), track: t });
    store.save(state);
    broadcast();
    return sendJson(res, 200, { track: t });
  }

  if ((r = m('DELETE', /^\/api\/requests\/([\w-]+)$/))) {
    state.requests = state.requests.filter((x) => x.rid !== r[1]);
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (m('POST', /^\/api\/requests\/clear$/)) {
    state.requests = [];
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  // Moves the requested songs into the queue without touching the current track:
  // "first" puts them at #1, #2, ... (a song already queued moves up);
  // "last" appends them (a song already queued stays where it is).
  if (m('POST', /^\/api\/requests\/add$/)) {
    const body = await readJson(req);
    const items = state.requests.map((x) => ({ qid: crypto.randomUUID(), track: x.track }));
    if (body.where === 'first') {
      const ids = new Set(items.map((q) => q.track.id));
      state.queue = [...items, ...state.queue.filter((q) => !ids.has(q.track.id))];
    } else {
      const queued = new Set(state.queue.map((q) => q.track.id));
      state.queue.push(...items.filter((q) => !queued.has(q.track.id)));
    }
    state.requests = [];
    store.save(state);
    broadcast();
    return sendJson(res, 200, { added: items.length });
  }

  if (m('GET', /^\/api\/history$/)) return sendJson(res, 200, { history: state.history, stats: statsView() });

  // Clears the list only; the total play time is kept.
  if (m('POST', /^\/api\/history\/clear$/)) {
    state.history = [];
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (m('POST', /^\/api\/queue\/flip$/)) {
    flipBoard();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { queued: state.queue.length });
  }

  if (m('POST', /^\/api\/queue\/reorder$/)) {
    const body = await readJson(req);
    reorderQueue(Array.isArray(body.order) ? body.order : []);
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if ((r = m('DELETE', /^\/api\/queue\/([\w-]+)$/))) {
    removeFromQueue(r[1]);
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if ((r = m('POST', /^\/api\/(pause|resume|stop)$/))) {
    clearTimeout(runtime.advanceTimer);
    sendCommand({ type: r[1] });
    if (r[1] === 'stop') runtime.current = null;
    // Lets clocks react at once, before the player reports the change.
    else if (runtime.current) runtime.current = { ...runtime.current, hint: { state: r[1] === 'pause' ? 'paused' : 'playing', at: Date.now() } };
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  // Player long-poll: returns as soon as a command newer than `since` exists.
  if (m('GET', /^\/api\/player\/poll$/)) {
    const since = Number(url.searchParams.get('since') || 0);
    handlePlayerEvent({ kind: url.searchParams.get('kind'), type: 'poll' });
    return waitForCommand(res, since, POLL_TIMEOUT_MS);
  }

  // Userscript channel: one request at a time carries the status and queued
  // events up, and the latest command down. Held for at most SYNC_HOLD_MS so
  // status arrives about every second while commands still arrive at once.
  // (A separate long-poll made the browser hold the userscript's other requests back.)
  if (m('POST', /^\/api\/player\/sync$/)) {
    const body = await readJson(req);
    const kind = body.kind;
    for (const ev of Array.isArray(body.events) ? body.events : []) handlePlayerEvent({ ...ev, kind });
    handlePlayerEvent({ kind, type: 'status', status: body.status });
    return waitForCommand(res, Number(body.since ?? -1), SYNC_HOLD_MS);
  }

  if (m('POST', /^\/api\/player\/event$/)) {
    handlePlayerEvent(await readJson(req));
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);
  return sendJson(res, 404, { error: 'not found' });
}

// Pre-fill the queue so tracks are ready before the first Next Track.
if (state.queue.length === 0 && rollDice() > 0) store.save(state);
// Finish Spotify artwork that a restart interrupted.
for (const p of Object.values(state.playlists)) if (p.provider === 'spotify' && p.tracks.some((t) => !t.cover)) fillCovers(p.id);

// Docker stops the container with SIGTERM: write pending changes first.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    store.flush();
    process.exit(0);
  });
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  route(req, res, url).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 400, { error: e.message });
  });
}).listen(PORT, () => console.log(`Tanzen Music Shuffler listening on :${PORT}`));
