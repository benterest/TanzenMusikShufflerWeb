// Tanzen Music Shuffler: picks random tracks from public Deezer playlists and
// sends "play" commands to a player (userscript in a deezer.com tab, or the
// preview player in the control page). Zero dependencies, Node >= 20.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const deezer = require('./deezer');
const store = require('./store');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const POLL_TIMEOUT_MS = 25000;
const SYNC_HOLD_MS = 1000;
const PLAYER_ALIVE_MS = POLL_TIMEOUT_MS + 10000;
const HISTORY_MAX = 100;
const QUEUE_ROLL = 5; // tracks added per Rolling Dice

const state = store.load();
const runtime = {
  bag: [],
  bagKey: '',
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

// "Bag" shuffle: every track is drawn once before any repeats. Tracks that
// are already queued or playing are never drawn again.
// Playlist weight: -1, 0 or +1 (settings.playlistWeights).
function weightOf(playlistId) {
  const w = Math.round(Number(state.settings.playlistWeights[playlistId]) || 0);
  return Math.max(-1, Math.min(1, w));
}

// One round of the bag. Weights change how often a track appears per round:
// +1 = twice, 0 = once, -1 = in about half of the rounds. Over time a +1
// playlist is heard about 2x as often and a -1 playlist about half as often.
function buildBag(tracks, exclude) {
  const bag = [];
  for (const t of tracks) {
    if (exclude.has(t.id)) continue;
    const w = weightOf(t.playlistId);
    const copies = w > 0 ? 2 : w < 0 ? (Math.random() < 0.5 ? 1 : 0) : 1;
    for (let i = 0; i < copies; i++) bag.push(t.id);
  }
  return shuffle(bag);
}

function draw(n) {
  const tracks = pool();
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const key = tracks.map((t) => `${t.id}:${weightOf(t.playlistId)}`).sort().join(',');
  if (key !== runtime.bagKey) {
    runtime.bagKey = key;
    runtime.bag = [];
  }
  const exclude = new Set(state.queue.map((q) => q.track.id));
  if (runtime.current) exclude.add(runtime.current.track.id);
  runtime.bag = runtime.bag.filter((id) => byId.has(id));

  const out = [];
  const skipped = []; // second copies of tracks already queued or playing
  let refilled = false;
  while (out.length < n) {
    if (runtime.bag.length === 0) {
      if (refilled) break; // nothing left that isn't already queued
      refilled = true;
      runtime.bag = buildBag(tracks, exclude);
      // Only -1 playlists active and every coin flip lost: take them all.
      if (runtime.bag.length === 0) runtime.bag = shuffle(tracks.map((t) => t.id).filter((id) => !exclude.has(id)));
      if (runtime.bag.length === 0) break;
    }
    const id = runtime.bag.pop();
    if (exclude.has(id)) {
      skipped.push(id);
      continue;
    }
    exclude.add(id);
    out.push(byId.get(id));
  }
  // Skipped copies stay in this round, at random later positions.
  for (const id of skipped) runtime.bag.splice(Math.floor(Math.random() * (runtime.bag.length + 1)), 0, id);
  return out;
}

// Tracks removed from the queue without playing go back into the bag.
function returnToBag(items) {
  for (const q of items) {
    runtime.bag.splice(Math.floor(Math.random() * (runtime.bag.length + 1)), 0, q.track.id);
  }
}

// ---------- queue ----------

function rollDice() {
  const added = draw(QUEUE_ROLL).map((track) => ({ qid: crypto.randomUUID(), track }));
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
  const { output, maxPlaySeconds, fadeSeconds } = state.settings;
  const cmd = { type: 'play', output, track, maxPlaySeconds, fadeSeconds };
  if (output === 'preview') {
    try {
      cmd.previewUrl = await deezer.fetchPreviewUrl(track.id);
    } catch (e) {
      state.queue.unshift(item); // keep the track at the head of the queue
      throw e;
    }
  }

  const seq = sendCommand(cmd);
  runtime.current = { seq, track, playlistId: track.playlistId, startedAt: Date.now(), output };
  runtime.lastError = null;
  state.history.unshift({ id: track.id, title: track.title, artist: track.artist, playlistId: track.playlistId, at: new Date().toISOString() });
  state.history.length = Math.min(state.history.length, HISTORY_MAX);
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

function findKnownTrack(id) {
  const ids = [...state.settings.activePlaylistIds, ...Object.keys(state.playlists)];
  for (const pid of ids) {
    const t = state.playlists[pid] && state.playlists[pid].tracks.find((x) => x.id === id);
    if (t) return { ...t, playlistId: pid };
  }
  return null;
}

// A track picked directly in Deezer becomes the current track. The queue is
// kept as it is, so playback continues from it once this track ends.
function startExternal(ev) {
  const id = String(ev.songId || '');
  if (!id || state.settings.output !== 'deezer') return;
  clearTimeout(runtime.advanceTimer);

  const known = findKnownTrack(id);
  const track = known || {
    id,
    title: ev.title || '',
    artist: ev.artist || '',
    album: ev.album || '',
    cover: ev.albumPicture ? `https://cdn-images.dzcdn.net/images/cover/${ev.albumPicture}/250x250-000000-80-0-0.jpg` : '',
    duration: Math.round(Number(ev.duration) || 0),
    readable: true,
    playlistId: null,
  };
  const seq = `ext-${Date.now()}`;
  runtime.current = {
    seq, track, playlistId: track.playlistId, startedAt: Date.now(), output: 'deezer',
    external: true, startPosition: Number(ev.position) || 0,
  };
  // Don't play it twice: drop it from the queue if it was waiting there.
  state.queue = state.queue.filter((q) => q.track.id !== id);
  ensureQueue();
  state.history.unshift({ id, title: track.title, artist: track.artist, playlistId: track.playlistId, external: true, at: new Date().toISOString() });
  state.history.length = Math.min(state.history.length, HISTORY_MAX);
  store.save(state);

  // Fill in artwork and length from the public API for tracks not in any playlist.
  if (!known) {
    deezer.fetchTrack(id).then((t) => {
      if (!runtime.current || runtime.current.seq !== seq) return;
      runtime.current = { ...runtime.current, track: { ...t, playlistId: null } };
      broadcast();
    }).catch(() => {});
  }
}

function handlePlayerEvent(ev) {
  const kind = ev.kind === 'preview' ? 'preview' : 'deezer';
  const p = (runtime.players[kind] ||= { lastSeen: 0, status: null });
  p.lastSeen = Date.now();
  if (ev.status) p.status = ev.status;

  const cur = runtime.current;
  const isCurrent = cur && cur.output === kind
    && (ev.seq === cur.seq || (cur.external && ev.external && String(ev.songId) === cur.track.id));
  if (ev.type === 'external' && kind === 'deezer') {
    startExternal(ev);
  } else if (ev.type === 'ended' && isCurrent) {
    runtime.current = { ...cur, endedAt: Date.now() };
    scheduleAdvance();
  } else if (ev.type === 'error' && isCurrent) {
    runtime.lastError = `${cur.track.title}: ${ev.message || 'playback failed'}`;
    scheduleAdvance();
  }
  broadcast();
}

// ---------- snapshot / SSE ----------

function snapshot() {
  const now = Date.now();
  const poolCounts = {};
  for (const t of pool()) poolCounts[t.playlistId] = (poolCounts[t.playlistId] || 0) + 1;
  const players = {};
  for (const [kind, p] of Object.entries(runtime.players)) {
    players[kind] = { connected: now - p.lastSeen < PLAYER_ALIVE_MS, status: p.status };
  }
  return {
    settings: state.settings,
    playlists: Object.values(state.playlists).map((p) => ({
      id: p.id, title: p.title, creator: p.creator, picture: p.picture, link: p.link,
      trackCount: p.tracks.length, playableCount: p.tracks.filter((t) => t.readable).length,
      poolCount: poolCounts[p.id] || 0, // tracks this playlist adds to the shuffle (duplicates counted once)
      weight: weightOf(p.id),
      fetchedAt: p.fetchedAt,
    })),
    poolSize: pool().length,
    remainingInBag: runtime.bag.length,
    current: runtime.current,
    queue: state.queue,
    history: state.history.slice(0, 30),
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
    const id = await deezer.resolvePlaylistId(body.input);
    const pl = await deezer.fetchPlaylist(id);
    state.playlists[pl.id] = pl;
    if (!state.settings.activePlaylistIds.includes(pl.id)) state.settings.activePlaylistIds.push(pl.id);
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { id: pl.id, title: pl.title, trackCount: pl.tracks.length });
  }

  let r;
  if ((r = m('POST', /^\/api\/playlists\/(\d+)\/refresh$/))) {
    const pl = await deezer.fetchPlaylist(r[1]);
    state.playlists[pl.id] = pl;
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { id: pl.id, trackCount: pl.tracks.length });
  }

  if ((r = m('DELETE', /^\/api\/playlists\/(\d+)$/))) {
    delete state.playlists[r[1]];
    state.settings.activePlaylistIds = state.settings.activePlaylistIds.filter((id) => id !== r[1]);
    state.queue = state.queue.filter((q) => q.track.playlistId !== r[1]);
    delete state.settings.playlistWeights[r[1]];
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { ok: true });
  }

  if (m('PATCH', /^\/api\/settings$/)) {
    const body = await readJson(req);
    for (const k of SETTING_KEYS) if (k in body) state.settings[k] = body[k];
    const weights = {};
    for (const [id, w] of Object.entries(state.settings.playlistWeights || {})) {
      const v = Math.max(-1, Math.min(1, Math.round(Number(w) || 0)));
      if (state.playlists[id] && v !== 0) weights[id] = v;
    }
    state.settings.playlistWeights = weights;
    state.settings.activePlaylistIds = state.settings.activePlaylistIds.map(String).filter((id) => state.playlists[id]);
    ensureQueue();
    store.save(state);
    broadcast();
    return sendJson(res, 200, state.settings);
  }

  if (m('POST', /^\/api\/next$/)) {
    const track = await playNext();
    return sendJson(res, 200, { track });
  }

  if (m('POST', /^\/api\/queue\/roll$/)) {
    const added = rollDice();
    store.save(state);
    broadcast();
    return sendJson(res, 200, { added });
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

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  route(req, res, url).catch((e) => {
    console.error(e);
    if (!res.headersSent) sendJson(res, 400, { error: e.message });
  });
}).listen(PORT, () => console.log(`Tanzen Music Shuffler listening on :${PORT}`));
