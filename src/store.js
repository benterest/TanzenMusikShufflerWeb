// Persists playlists, settings, history, the queue and the current track as one JSON file (Docker volume).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_SETTINGS = {
  activePlaylistIds: [],
  autoAdvance: true,
  service: 'deezer',    // 'deezer' | 'spotify': the music service in use (playlists are never mixed)
  output: 'tab',        // 'tab' (userscript in the service's browser tab) | 'preview' (30s MP3 in this page)
  maxPlaySeconds: 0,    // 0 = play the whole track
  fadeSeconds: 3,
  gapSeconds: 2,
  showSteps: false,     // dance step footprints on the display page (off unless turned on)
  playlistShares: {},   // active playlistId -> % chance of supplying the next track (sum 100)
};

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      playlists: raw.playlists || {},
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) },
      history: raw.history || [],
      queue: raw.queue || [],    // [{ qid, track }], head plays next
      current: raw.current || null,
      requests: raw.requests || [], // songs waiting in the "Adding Song" panel: [{ rid, track }]
      stash: raw.stash || {},       // the other service's active playlists, shares, queue and requests
      stats: { playMs: 0, todayMs: 0, day: '', ...(raw.stats || {}) }, // kept when the history is cleared
    };
  } catch {
    return { playlists: {}, settings: { ...DEFAULT_SETTINGS }, history: [], queue: [], current: null, requests: [], stash: {}, stats: { playMs: 0, todayMs: 0, day: '' } };
  }
}

let saveTimer = null;
let pending = null;

function write(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, FILE);
}

// Saves are batched for 200ms.
function save(state) {
  pending = state;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 200);
}

// Writes a batched save right away (e.g. when the server is stopped).
function flush() {
  clearTimeout(saveTimer);
  if (pending) write(pending);
  pending = null;
}

module.exports = { load, save, flush };
