// ==UserScript==
// @name         Tanzen Music Shuffler – Deezer Player
// @namespace    tanzen-music-shuffler
// @version      0.3.0
// @description  Plays tracks chosen by the Tanzen Music Shuffler server in this deezer.com tab.
// @match        https://www.deezer.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Replaced by the server when this file is downloaded.
  const DEFAULT_SERVER = '__SERVER_URL__';
  let server = GM_getValue('serverUrl', DEFAULT_SERVER);

  GM_registerMenuCommand('Change Shuffler server address', () => {
    const v = prompt('Shuffler server address (e.g. http://localhost:8787)', server);
    if (v) {
      server = v.replace(/\/+$/, '');
      GM_setValue('serverUrl', server);
      location.reload();
    }
  });

  const TICK_MS = 250;
  const RETRY_PLAY_MS = 4000;
  const START_TIMEOUT_MS = 90000; // covers ads on free accounts

  // GM_xmlhttpRequest runs in the extension, so it is not blocked as mixed
  // content when the server is plain http on the LAN.
  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: server + path,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 40000,
        responseType: 'json',
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r.response) : reject(new Error('HTTP ' + r.status))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  const dz = () => unsafeWindow.dzPlayer;

  // ---------- on-page badge ----------

  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:96px', 'z-index:2147483647',
    'padding:6px 10px', 'border-radius:8px', 'font:12px/1.3 system-ui,sans-serif',
    'color:#fff', 'background:#555', 'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(badge);

  let connected = false;
  function renderBadge() {
    const activated = !navigator.userActivation || navigator.userActivation.hasBeenActive;
    let text = connected ? 'Shuffler connected' : 'Shuffler not connected: ' + server;
    let color = connected ? '#1b7f4b' : '#a33';
    if (connected && !activated) {
      text = 'Shuffler: click this tab once to allow autoplay';
      color = '#b7791f';
    }
    badge.textContent = text;
    badge.style.background = color;
  }
  setInterval(renderBadge, 1000);

  // ---------- playback control ----------

  const AD_TYPES = ['ads', 'triton_ads', 'jingle'];
  const PICK_CONFIRM_MS = 1500;      // another song must play this long to count as a direct pick
  const AFTER_END_GUARD_MS = 10000;  // Deezer's own autoplay right after a track ends is not a pick

  // active: track requested by the server
  //   { seq, trackId, max, fade, started, ended, retryAt, deadline, lastPos, lastDur, savedVolume }
  let active = null;
  // external: track picked directly in Deezer { songId, lastPos, lastDur }
  let external = null;
  let candidate = null;   // possible direct pick being confirmed { songId, since }
  let guardUntil = 0;
  let lastKnownId = '';   // last track we handled, still loaded in the player

  const isAd = (p) => typeof p.getPlayerType === 'function' && AD_TYPES.includes(p.getPlayerType());

  function startPlay(cmd, seq) {
    restoreVolume();
    external = null;
    candidate = null;
    guardUntil = 0;
    active = {
      seq,
      trackId: String(cmd.track.id),
      max: Number(cmd.maxPlaySeconds) || 0,
      fade: Number(cmd.fadeSeconds) || 0,
      started: false,
      ended: false,
      retryAt: 0,
      deadline: Date.now() + START_TIMEOUT_MS,
      lastPos: 0,
      lastDur: 0,
      savedVolume: null,
    };
  }

  function requestTrack() {
    const p = dz();
    if (!p || typeof p.play !== 'function') return;
    const id = active.trackId;
    p.play({
      type: 'track',
      id,
      data: [],
      autoplay: true,
      radio: false,
      context: { ID: id, TYPE: 'track', CONTEXT_ID: id },
    });
  }

  function restoreVolume() {
    const p = dz();
    if (active && active.savedVolume != null && p) p.control.setVolume(active.savedVolume);
    if (active) active.savedVolume = null;
  }

  function finish(type, message) {
    const p = dz();
    if (p && p.isPlaying()) p.control.pause();
    restoreVolume();
    const seq = active.seq;
    active.ended = true;
    lastKnownId = active.trackId;
    guardUntil = Date.now() + AFTER_END_GUARD_MS;
    sendEvent({ type, seq, message });
  }

  function tick() {
    const p = dz();
    if (!p) return;
    if (active && !active.ended) tickActive(p);
    else tickIdle(p);
  }

  // Follows the track the server asked for.
  function tickActive(p) {
    const now = Date.now();
    const songId = String(p.getSongId() || '');
    const playing = p.isPlaying();
    const pos = Number(p.getPosition()) || 0;
    const dur = Number(p.getDuration()) || 0;

    if (!active.started) {
      if (songId === active.trackId && playing) {
        active.started = true;
      } else if (now > active.deadline) {
        finish('error', 'Timed out waiting for playback (the track may be unavailable for this account or country)');
      } else if (now >= active.retryAt) {
        active.retryAt = now + RETRY_PLAY_MS;
        requestTrack();
      }
      return;
    }

    if (songId !== active.trackId) {
      if (isAd(p)) return;
      // Near the end: Deezer moved on by itself (e.g. its autoplay).
      if (active.lastDur > 0 && active.lastPos >= active.lastDur - 3) return finish('ended');
      // Otherwise another song was picked in Deezer: stop managing ours
      // (without pausing) and let tickIdle() confirm the pick.
      restoreVolume();
      active.ended = true;
      lastKnownId = active.trackId;
      return;
    }

    const limit = active.max > 0 && dur > 0 ? Math.min(active.max, dur) : dur;

    if (active.max > 0 && active.fade > 0 && playing && pos >= limit - active.fade) {
      if (active.savedVolume == null) active.savedVolume = p.volume;
      const left = Math.max(0, limit - pos);
      p.control.setVolume(active.savedVolume * (left / active.fade));
    }

    if (limit > 0 && pos >= limit - 0.4) return finish('ended');
    // Natural end: player stopped right after being near the end.
    if (!playing && dur > 0 && active.lastPos >= dur - 2) return finish('ended');
    active.lastPos = pos;
    active.lastDur = dur;
  }

  // No server track playing: follow a direct pick, or detect a new one.
  function tickIdle(p) {
    const now = Date.now();
    const songId = String(p.getSongId() || '');
    const playing = p.isPlaying();
    const pos = Number(p.getPosition()) || 0;
    const dur = Number(p.getDuration()) || 0;

    if (external) {
      const nearEnd = external.lastDur > 0 && external.lastPos >= external.lastDur - 3;
      if (songId === external.songId) {
        if (!playing && external.lastDur > 0 && external.lastPos >= external.lastDur - 2) return endExternal();
        external.lastPos = pos;
        external.lastDur = dur;
        candidate = null;
        return;
      }
      // The pick ended and Deezer moved on by itself: hand back to the queue.
      if (!isAd(p) && nearEnd) return endExternal();
    }

    const expected = external ? external.songId : lastKnownId;
    if (!playing || !songId || isAd(p) || now < guardUntil || songId === expected) {
      candidate = null;
      return;
    }
    if (!candidate || candidate.songId !== songId) {
      candidate = { songId, since: now };
      return;
    }
    if (now - candidate.since < PICK_CONFIRM_MS) return;

    candidate = null;
    external = { songId, lastPos: pos, lastDur: dur };
    sendEvent({
      type: 'external',
      songId,
      title: p.getCurrentSong('SNG_TITLE') || '',
      artist: p.getCurrentSong('ART_NAME') || '',
      album: p.getCurrentSong('ALB_TITLE') || '',
      albumPicture: p.getCurrentSong('ALB_PICTURE') || '',
      duration: dur,
      position: pos,
    });
  }

  function endExternal() {
    const songId = external.songId;
    external = null;
    lastKnownId = songId;
    guardUntil = Date.now() + AFTER_END_GUARD_MS;
    sendEvent({ type: 'ended', external: true, songId });
  }
  setInterval(tick, TICK_MS);

  function handleCommand(cmd, seq) {
    const p = dz();
    switch (cmd.type) {
      case 'play':
        if (cmd.output === 'deezer') startPlay(cmd, seq);
        else if (p && p.isPlaying()) { p.control.pause(); active = null; }
        break;
      case 'pause':
        if (p) p.control.pause();
        break;
      case 'resume':
        if (p && ((active && !active.ended) || external)) p.control.play();
        break;
      case 'stop':
        if (p) p.control.pause();
        restoreVolume();
        if (external) lastKnownId = external.songId;
        active = null;
        external = null;
        break;
    }
    tick(); // act now instead of waiting for the (possibly throttled) timer
  }

  // ---------- server communication ----------

  function status() {
    const p = dz();
    if (!p) return { ready: false };
    return {
      ready: true,
      songId: String(p.getSongId() || ''),
      title: p.getCurrentSong('SNG_TITLE') || '',
      artist: p.getCurrentSong('ART_NAME') || '',
      playing: p.isPlaying(),
      position: Number(p.getPosition()) || 0,
      duration: Number(p.getDuration()) || 0,
      limited: typeof p.isLimited === 'function' ? p.isLimited() : null,
      activated: !navigator.userActivation || navigator.userActivation.hasBeenActive,
    };
  }

  // Events wait here and go up with the next sync request.
  const outbox = [];
  function sendEvent(ev) {
    outbox.push(ev);
  }

  // Only one request is ever in flight: it carries status and events up and
  // the latest command down. The server holds it for at most ~1s, so status
  // arrives about every second. This loop is driven by network responses,
  // not timers, so it keeps its pace in a background tab. (With a separate
  // long-poll the browser held the status requests back for many seconds.)
  async function syncLoop() {
    // since=-1 only syncs the sequence number, so reloading the tab does not
    // replay the last command.
    let since = -1;
    for (;;) {
      const events = outbox.splice(0);
      try {
        tick();
        const r = await request('POST', '/api/player/sync', { kind: 'deezer', since, status: status(), events });
        connected = true;
        if (since !== -1 && r.seq > since && r.cmd) handleCommand(r.cmd, r.seq);
        since = r.seq;
      } catch (e) {
        outbox.unshift(...events);
        connected = false;
        await new Promise((res) => setTimeout(res, 3000));
      }
      renderBadge();
    }
  }

  renderBadge();
  syncLoop();
})();
