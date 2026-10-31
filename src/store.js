// Persists playlists, settings, history, the queue and the current track as one JSON file (Docker volume).
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_SETTINGS = {
  activePlaylistIds: [],
  autoAdvance: true,
  output: 'deezer',     // 'deezer' (userscript in a deezer.com tab) | 'preview' (30s MP3 in this page)
  maxPlaySeconds: 0,    // 0 = play the whole track
  fadeSeconds: 3,
  gapSeconds: 2,
  showSteps: true,      // dance step footprints on the display page
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
    };
  } catch {
    return { playlists: {}, settings: { ...DEFAULT_SETTINGS }, history: [], queue: [], current: null };
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
