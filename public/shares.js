'use strict';

// Playlist shares: how likely each active playlist is to supply the next
// track. Whole percentages, never below 0, always adding up to 100.
// Shared by the server (authoritative) and the control page (live sliders).
(function (root) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Removes `amount` units spread equally over `ids`, never below 0.
  // Odd units come from the largest shares. Returns how much was taken.
  function takeEqually(shares, ids, amount) {
    let left = amount;
    while (left > 0) {
      const live = ids.filter((id) => shares[id] > 0);
      if (!live.length) break;
      const per = Math.floor(left / live.length);
      if (per === 0) {
        live.sort((a, b) => shares[b] - shares[a]);
        for (const id of live.slice(0, left)) shares[id] -= 1;
        left = 0;
        break;
      }
      for (const id of live) {
        const d = Math.min(per, shares[id]);
        shares[id] -= d;
        left -= d;
      }
    }
    return amount - left;
  }

  // Adds `amount` units spread equally over `ids`; odd units go to the smallest shares.
  function giveEqually(shares, ids, amount) {
    if (!ids.length || amount <= 0) return;
    const per = Math.floor(amount / ids.length);
    for (const id of ids) shares[id] += per;
    const order = [...ids].sort((a, b) => shares[a] - shares[b]);
    for (const id of order.slice(0, amount - per * ids.length)) shares[id] += 1;
  }

  // Sets one playlist's share; the others make up the difference equally.
  function setShare(shares, id, value) {
    const out = { ...shares };
    const others = Object.keys(out).filter((k) => k !== id);
    if (!others.length) return { [id]: 100 };
    const delta = clamp(Math.round(value), 0, 100) - out[id];
    if (delta > 0) out[id] += takeEqually(out, others, delta);
    else if (delta < 0) {
      out[id] += delta;
      giveEqually(out, others, -delta);
    }
    return out;
  }

  function median(values) {
    const v = [...values].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // A new playlist gets the median of the others' shares (at most 50, the
  // middle of the slider, so a second playlist splits 50/50), taken from the
  // others equally.
  function addPlaylist(shares, id) {
    const out = { ...shares };
    const others = Object.keys(out);
    if (!others.length) return { [id]: 100 };
    const want = Math.min(50, Math.round(median(others.map((k) => out[k]))));
    out[id] = takeEqually(out, others, want);
    return out;
  }

  // A removed playlist's share goes back to the others equally.
  function removePlaylist(shares, id) {
    const out = { ...shares };
    const freed = out[id] || 0;
    delete out[id];
    giveEqually(out, Object.keys(out), freed);
    return out;
  }

  // Scales any values to whole numbers adding up to 100 (largest remainder).
  function scaleTo100(shares) {
    const ids = Object.keys(shares);
    if (!ids.length) return {};
    const total = ids.reduce((s, id) => s + shares[id], 0);
    const exact = ids.map((id) => (total > 0 ? (shares[id] * 100) / total : 100 / ids.length));
    const out = {};
    ids.forEach((id, i) => { out[id] = Math.floor(exact[i]); });
    let left = 100 - ids.reduce((s, id) => s + out[id], 0);
    const order = ids.map((id, i) => [id, exact[i] - out[id]]).sort((a, b) => b[1] - a[1]);
    for (const [id] of order) {
      if (left-- <= 0) break;
      out[id] += 1;
    }
    return out;
  }

  // Makes shares valid for exactly `activeIds`: playlists that are no longer
  // active give their share back, new ones are added with the median share.
  function normalize(shares, activeIds) {
    const active = activeIds.map(String);
    let out = {};
    for (const [id, v] of Object.entries(shares || {})) out[id] = Math.max(0, Number(v) || 0);
    const valid = Object.values(out).every(Number.isInteger)
      && Object.values(out).reduce((s, v) => s + v, 0) === 100;
    if (!valid) out = scaleTo100(out);
    for (const id of Object.keys(out)) if (!active.includes(id)) out = removePlaylist(out, id);
    for (const id of active) if (!(id in out)) out = addPlaylist(out, id);
    return out;
  }

  const api = { setShare, addPlaylist, removePlaylist, normalize, scaleTo100 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Shares = api;
})(this);
