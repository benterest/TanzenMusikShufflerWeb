// ==UserScript==
// @name         Tanzen Music Shuffler – Spotify Player
// @namespace    tanzen-music-shuffler
// @version      0.1.0
// @description  Plays tracks chosen by the Tanzen Music Shuffler server in this open.spotify.com tab.
// @match        https://open.spotify.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @sandbox      JavaScript
// @connect      *
// @run-at       document-start
// ==/UserScript==

// The Spotify web player has no public player object like Deezer's dzPlayer.
// This script uses what the page offers instead:
// - playing a track: moving the page to /track/{id}, which Spotify starts by itself
// - pause / resume: the Media Session handlers Spotify registers
// - position, length, volume: the media element Spotify plays through (a <video> outside the DOM)
// - which track is playing: the player state in the React props of the player bar
// These are internals and may need fixing when Spotify updates its web app.
(function () {
  'use strict';

  const W = unsafeWindow;

  // ---------- hooks (installed before Spotify's code runs) ----------

  // Every media element Spotify creates or plays.
  const mediaEls = [];
  function remember(el) {
    if (mediaEls.includes(el)) return;
    mediaEls.push(el);
    // React at once to the end of a track: Spotify starts its autoplay within milliseconds.
    for (const type of ['ended', 'pause', 'play', 'loadedmetadata']) el.addEventListener(type, () => tick());
  }
  try {
    const origPlay = W.HTMLMediaElement.prototype.play;
    W.HTMLMediaElement.prototype.play = function () {
      remember(this);
      return origPlay.apply(this, arguments);
    };
    const origCreate = W.Document.prototype.createElement;
    W.Document.prototype.createElement = function (name) {
      const el = origCreate.apply(this, arguments);
      if (/^(audio|video)$/i.test(String(name))) remember(el);
      return el;
    };
  } catch (e) {
    console.error('[shuffler] media hook failed', e);
  }

  // Spotify's own play/pause handlers (also used by media keys).
  const handlers = {};
  try {
    const ms = W.navigator.mediaSession;
    const origSet = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, fn) => {
      handlers[action] = fn;
      return origSet(action, fn);
    };
  } catch (e) {
    console.error('[shuffler] media session hook failed', e);
  }

  // ---------- reading and controlling the web player ----------

  const $ = (sel) => W.document.querySelector(sel);
  const SEL = {
    widget: '[data-testid="now-playing-widget"]',
    playPause: '[data-testid="control-button-playpause"]',
    actionBarPlay: '[data-testid="action-bar-row"] [data-testid="play-button"]',
    adMarker: '[data-testid="context-item-info-ad-title"], [data-testid="ad-link"]',
  };

  // The element playing the track: not muted and longer than a few seconds
  // (Spotify's "Canvas" loop is another <video>, muted and short).
  function media() {
    const cands = mediaEls.filter((e) => !e.muted && e.duration > 15);
    return cands.find((e) => !e.paused) || cands[0] || null;
  }

  // Player state item { uri, name, artists, album, duration, ... } from the
  // React props of the player bar. Its `context` is the list or track that
  // was started, so only `item` tells the current track.
  function item() {
    const root = $(SEL.widget);
    if (!root) return null;
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    let f = key && root[key];
    for (let up = 0; f && up < 30; up++, f = f.return) {
      const st = f.memoizedProps && f.memoizedProps.state;
      if (st && st.item && typeof st.item.uri === 'string') return st.item;
    }
    return null;
  }

  const trackIdOf = (it) => ((it && String(it.uri).match(/^spotify:track:([A-Za-z0-9]{22})$/)) || [])[1] || '';

  // Not seen yet on a Free account, so this checks several signs: an item
  // that is not a track, or Spotify's ad markers in the player bar.
  function isAd(it) {
    if ($(SEL.adMarker)) return true;
    if (!it) return false;
    return it.type === 'ad' || it.mediaType === 'ad' || /^spotify:ad:/.test(it.uri) || !trackIdOf(it);
  }

  function coverOf(it) {
    const imgs = (it && it.album && it.album.images) || it && it.images || [];
    const list = imgs.filter((i) => i && i.url);
    if (!list.length) return '';
    const w = (i) => i.width || i.maxWidth || 0;
    return list.reduce((best, i) => (Math.abs(w(i) - 300) < Math.abs(w(best) - 300) ? i : best)).url;
  }

  // The same calls the Deezer userscript makes on dzPlayer.
  const sp = {
    ready: () => !!$(SEL.widget),
    songId: () => trackIdOf(item()),
    isPlaying: () => {
      const m = media();
      return !!m && !m.paused && !m.ended;
    },
    position: () => {
      const m = media();
      return m ? Number(m.currentTime) || 0 : 0;
    },
    duration: () => {
      const m = media();
      if (m && Number.isFinite(m.duration) && m.duration > 0) return m.duration;
      const it = item();
      return it && it.duration ? (Number(it.duration.milliseconds) || 0) / 1000 : 0;
    },
    volume: () => {
      const m = media();
      return m ? m.volume : 1;
    },
    setVolume: (v) => {
      const m = media();
      if (m) m.volume = Math.max(0, Math.min(1, v));
    },
    pause: () => {
      if (handlers.pause) handlers.pause({ action: 'pause' });
      else if (sp.isPlaying() && $(SEL.playPause)) $(SEL.playPause).click();
    },
    play: () => {
      if (handlers.play) handlers.play({ action: 'play' });
      else if (!sp.isPlaying() && $(SEL.playPause)) $(SEL.playPause).click();
    },
  };

  // ---------- server connection ----------

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

  // ---------- on-page badge ----------

  const badge = document.createElement('div');
  badge.style.cssText = [
    'position:fixed', 'left:12px', 'bottom:96px', 'z-index:2147483647',
    'padding:6px 10px', 'border-radius:8px', 'font:12px/1.3 system-ui,sans-serif',
    'color:#fff', 'background:#555', 'box-shadow:0 2px 8px rgba(0,0,0,.3)', 'pointer-events:none',
  ].join(';');

  let connected = false;
  function renderBadge() {
    // Spotify's page may replace parts of the DOM: put the badge back if needed.
    if (!badge.isConnected && document.body) document.body.appendChild(badge);
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

  const PICK_CONFIRM_MS = 1500;      // another song must play this long to count as a direct pick
  const AFTER_END_GUARD_MS = 10000;  // Spotify's own autoplay right after a track ends is not a pick

  // active: track requested by the server
  //   { seq, trackId, max, fade, started, ended, retryAt, tries, deadline, lastPos, lastDur, savedVolume }
  let active = null;
  // external: track picked directly in Spotify { songId, lastPos, lastDur }
  let external = null;
  let candidate = null;   // possible direct pick being confirmed { songId, since }
  let guardUntil = 0;
  let lastKnownId = '';   // last track we handled, still loaded in the player

  // The same track jumped from its end back to the start: it ended and was
  // started again (repeat), even if the very last moment was never seen.
  const restartedAfterEnd = (last, pos) => last.lastDur > 0 && last.lastPos >= last.lastDur - 3 && pos < last.lastPos - 5;

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
      tries: 0,
      deadline: Date.now() + START_TIMEOUT_MS,
      lastPos: 0,
      lastDur: 0,
      savedVolume: null,
    };
  }

  // Moving the page to the track's page makes Spotify play it (it adds
  // ?autoplay_ok=1 to the address). If that did not start it, the next try
  // presses the page's play button instead.
  function requestTrack() {
    const id = active.trackId;
    const path = `/track/${id}`;
    active.tries++;
    const onPage = W.location.pathname.endsWith(path);
    const btn = $(SEL.actionBarPlay);
    if (onPage && btn && active.tries % 2 === 0 && !(sp.songId() === id && sp.isPlaying())) {
      btn.click();
      return;
    }
    W.history.pushState({}, '', path);
    W.dispatchEvent(new W.PopStateEvent('popstate', { state: {} }));
  }

  function restoreVolume() {
    if (active && active.savedVolume != null) sp.setVolume(active.savedVolume);
    if (active) active.savedVolume = null;
  }

  function finish(type, message) {
    if (sp.isPlaying()) sp.pause();
    restoreVolume();
    const seq = active.seq;
    active.ended = true;
    lastKnownId = active.trackId;
    guardUntil = Date.now() + AFTER_END_GUARD_MS;
    sendEvent({ type, seq, message });
  }

  function tick() {
    if (!sp.ready()) return;
    if (active && !active.ended) tickActive();
    else tickIdle();
  }

  // Follows the track the server asked for.
  function tickActive() {
    const now = Date.now();
    const it = item();
    const songId = trackIdOf(it);
    const ad = isAd(it);
    const playing = sp.isPlaying();
    const pos = sp.position();
    const dur = sp.duration();

    if (!active.started) {
      if (songId === active.trackId && playing && !ad) {
        active.started = true;
      } else if (now > active.deadline) {
        finish('error', 'Timed out waiting for playback (the track may be unavailable for this account or country)');
      } else if (!ad && now >= active.retryAt) {
        // No retries during an ad: the track follows it by itself.
        active.retryAt = now + RETRY_PLAY_MS;
        requestTrack();
      }
      return;
    }

    if (songId !== active.trackId) {
      if (ad) return;
      // Near the end: Spotify moved on by itself (its autoplay).
      if (active.lastDur > 0 && active.lastPos >= active.lastDur - 3) return finish('ended');
      // Otherwise another song was picked in Spotify: stop managing ours
      // (without pausing) and let tickIdle() confirm the pick.
      restoreVolume();
      active.ended = true;
      lastKnownId = active.trackId;
      return;
    }

    const limit = active.max > 0 && dur > 0 ? Math.min(active.max, dur) : dur;

    if (active.max > 0 && active.fade > 0 && playing && pos >= limit - active.fade) {
      if (active.savedVolume == null) active.savedVolume = sp.volume();
      const left = Math.max(0, limit - pos);
      sp.setVolume(active.savedVolume * (left / active.fade));
    }

    // Stop just before the end: when a track ends, Spotify's autoplay starts
    // another one within milliseconds.
    if (limit > 0 && pos >= limit - 0.4) return finish('ended');
    if (restartedAfterEnd(active, pos)) return finish('ended');
    // Natural end: player stopped right after being near the end.
    if (!playing && dur > 0 && active.lastPos >= dur - 2) return finish('ended');
    active.lastPos = pos;
    active.lastDur = dur;
  }

  // No server track playing: follow a direct pick, or detect a new one.
  function tickIdle() {
    const now = Date.now();
    const it = item();
    const songId = trackIdOf(it);
    const ad = isAd(it);
    const playing = sp.isPlaying();
    const pos = sp.position();
    const dur = sp.duration();

    if (external) {
      const nearEnd = external.lastDur > 0 && external.lastPos >= external.lastDur - 3;
      if (songId === external.songId) {
        if (!playing && external.lastDur > 0 && external.lastPos >= external.lastDur - 2) return endExternal();
        if (restartedAfterEnd(external, pos)) {
          sp.pause(); // the queue's next track is on its way
          return endExternal();
        }
        // Stop before Spotify's autoplay takes over; the queue continues.
        if (dur > 0 && pos >= dur - 0.4) {
          sp.pause();
          return endExternal();
        }
        external.lastPos = pos;
        external.lastDur = dur;
        candidate = null;
        return;
      }
      // The pick ended and Spotify moved on by itself: hand back to the queue.
      if (!ad && nearEnd) {
        sp.pause();
        return endExternal();
      }
    }

    const expected = external ? external.songId : lastKnownId;
    if (!playing || !songId || ad || now < guardUntil || songId === expected) {
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
      title: it.name || '',
      artist: (it.artists || []).map((a) => a.name).join(', '),
      album: (it.album && it.album.name) || '',
      cover: coverOf(it),
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
    switch (cmd.type) {
      case 'play':
        if (cmd.output === 'spotify') startPlay(cmd, seq);
        else {
          if (sp.isPlaying()) sp.pause();
          active = null;
        }
        break;
      case 'pause':
        sp.pause();
        break;
      case 'resume':
        if ((active && !active.ended) || external) sp.play();
        break;
      case 'stop':
        if (sp.isPlaying()) sp.pause();
        restoreVolume();
        if (external) lastKnownId = external.songId;
        active = null;
        external = null;
        break;
    }
    tick(); // act now instead of waiting for the (possibly throttled) timer
  }

  function status() {
    if (!sp.ready()) return { ready: false, hooks: { media: mediaEls.length, handlers: Object.keys(handlers) } };
    const it = item();
    return {
      ready: true,
      songId: trackIdOf(it),
      title: (it && it.name) || '',
      artist: it ? (it.artists || []).map((a) => a.name).join(', ') : '',
      cover: coverOf(it),
      playing: sp.isPlaying(),
      position: sp.position(),
      duration: sp.duration(),
      ad: isAd(it),
      activated: !navigator.userActivation || navigator.userActivation.hasBeenActive,
      // For checking the hooks from the server's /api/state, e.g. during an ad.
      hooks: { media: mediaEls.length, handlers: Object.keys(handlers), item: it ? `${it.type || '?'} ${String(it.uri).split(':')[1] || ''}` : null },
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
  // not timers, so it keeps its pace in a background tab.
  async function syncLoop() {
    // since=-1 only syncs the sequence number, so reloading the tab does not
    // replay the last command.
    let since = -1;
    for (;;) {
      const events = outbox.splice(0);
      try {
        tick();
        const r = await request('POST', '/api/player/sync', { kind: 'spotify', since, status: status(), events });
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

  // The hooks above had to run at document-start; the rest needs the page.
  function start() {
    renderBadge();
    syncLoop();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
