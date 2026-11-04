'use strict';

// Playlist priorities: each playlist has its own value from 0 to 100
// (default 50), set on its slider without touching the others. A playlist's
// share, its chance of supplying the next track, is its value divided by the
// sum of the values of all active playlists. Ten playlists at 50 sum to 500
// and get 10% each; raising one to 100 makes the sum 550 and gives it 18%.
// Shared by the server (authoritative) and the control page (live labels).
(function (root) {
  const DEFAULT_PRIORITY = 50;

  const clampPriority = (v) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)));

  function priorityOf(priorities, id) {
    const v = priorities && priorities[id];
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_PRIORITY;
  }

  // Whole numbers 0-100 only; anything else is dropped (and reads as the default).
  function sanitize(priorities) {
    const out = {};
    for (const [id, v] of Object.entries(priorities || {})) {
      if (v !== null && v !== '' && Number.isFinite(Number(v))) out[String(id)] = clampPriority(v);
    }
    return out;
  }

  // Share in percent (not rounded) of each active playlist. All 0 when every
  // active playlist is at 0.
  function percentages(priorities, activeIds) {
    const ids = activeIds.map(String);
    const total = ids.reduce((s, id) => s + priorityOf(priorities, id), 0);
    return Object.fromEntries(ids.map((id) => [id, total > 0 ? (priorityOf(priorities, id) * 100) / total : 0]));
  }

  // Older versions stored shares: whole percentages over the active playlists
  // that added up to 100. They become priorities with the same proportions,
  // equal shares mapping to the default 50 (values above 100 are capped).
  function fromShares(shares) {
    const ids = Object.keys(shares || {});
    const out = {};
    for (const id of ids) out[id] = clampPriority(((Number(shares[id]) || 0) * ids.length * DEFAULT_PRIORITY) / 100);
    return out;
  }

  const api = { DEFAULT_PRIORITY, clampPriority, priorityOf, sanitize, percentages, fromShares };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shares = api;
})(this);
