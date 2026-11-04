// ==UserScript==
// @name         Tanzen Music Shuffler – Spotify Probe
// @namespace    tanzen-music-shuffler
// @version      0.1.3
// @description  One-off probe: checks which ways of controlling the open.spotify.com web player work. Not part of the app.
// @match        https://open.spotify.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

// Runs in the page itself (@grant none) so the prototype hooks see Spotify's
// own calls. Everything found is collected in `report` and can be copied as
// JSON from the panel.
console.log('[spotify-probe] script loaded', location.href, document.readyState);

(function () {
  'use strict';

  const T0 = Date.now();
  const now = () => Date.now() - T0;
  const report = {
    version: '0.1.3',
    userAgent: navigator.userAgent,
    startedAt: new Date().toISOString(),
    media: [],          // media elements seen, with how they were found
    mediaEvents: [],    // play/pause/ended/... on those elements
    mediaSession: { actions: [], metadata: [] },
    selectors: {},
    nowPlayingIds: [],  // track id changes seen in the player bar
    playTests: [],
    volumeTests: [],
    playerState: null,  // shape of the player state found in the bar's React props
    trackLoads: [],     // each new track the media element loaded
    background: { samples: 0, hiddenSamples: 0, staleDomWhileHidden: 0, maxGapMs: 0, maxHiddenGapMs: 0 },
    internal: {},
    log: [],
  };
  const log = (msg) => {
    report.log.push(`${(now() / 1000).toFixed(1)}s ${msg}`);
    if (report.log.length > 300) report.log.shift();
    console.log('[spotify-probe]', msg);
  };

  // ---------- probe 1: media elements ----------

  const elements = [];
  function remember(el, how) {
    if (elements.includes(el)) return;
    elements.push(el);
    const info = { index: elements.length - 1, tag: el.tagName, how, at: now() };
    report.media.push(info);
    log(`media #${info.index} <${el.tagName.toLowerCase()}> via ${how}`);
    el.addEventListener('loadedmetadata', onLoaded);
    for (const type of ['play', 'playing', 'pause', 'ended', 'emptied', 'loadedmetadata', 'volumechange', 'ratechange', 'seeked']) {
      el.addEventListener(type, () => {
        report.mediaEvents.push({ el: info.index, type, at: now(), time: +el.currentTime.toFixed(2), dur: +(el.duration || 0).toFixed(2), vol: +el.volume.toFixed(2), hidden: document.hidden });
        if (report.mediaEvents.length > 400) report.mediaEvents.shift();
      });
    }
  }

  // Each new track loaded by a media element, with what the page says about
  // it shortly after (title from Media Session, id from the bar).
  function onLoaded() {
    if (this.muted || !(this.duration > 15)) return; // Canvas loop
    const entry = { at: now(), dur: +this.duration.toFixed(2), path: location.pathname + location.search };
    report.trackLoads.push(entry);
    setTimeout(() => {
      entry.meta = sessionMeta();
      entry.barId = nowPlayingId().id || null;
      entry.candidates = lastCandidates;
    }, 1500);
  }

  // Each hook is tried on its own, so one failing does not stop the probe.
  const hook = (name, fn) => {
    try { fn(); } catch (e) { log(`hook ${name} failed: ${e}`); }
  };
  const origCreate = Document.prototype.createElement;
  hook('play', () => {
    const origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      remember(this, 'play()');
      return origPlay.apply(this, arguments);
    };
  });
  hook('createElement', () => {
    Document.prototype.createElement = function (name) {
      const el = origCreate.apply(this, arguments);
      if (/^(audio|video)$/i.test(String(name))) remember(el, 'createElement');
      return el;
    };
  });
  hook('Audio', () => {
    const OrigAudio = window.Audio;
    window.Audio = function () {
      const el = new OrigAudio(...arguments);
      remember(el, 'new Audio()');
      return el;
    };
    window.Audio.prototype = OrigAudio.prototype;
  });

  // The element playing the track. Spotify plays audio through a <video>
  // outside the DOM; the "Canvas" loop is another <video>, muted and short.
  function mainMedia() {
    const cands = elements.filter((e) => !e.muted && e.duration > 15);
    return cands.find((e) => !e.paused) || cands[0] || null;
  }
  const mediaState = (el) => el && {
    index: elements.indexOf(el), tag: el.tagName, inDom: el.isConnected,
    src: String(el.currentSrc || el.src || '').slice(0, 40),
    time: +el.currentTime.toFixed(2), dur: +(el.duration || 0).toFixed(2),
    paused: el.paused, ended: el.ended, vol: +el.volume.toFixed(2), muted: el.muted, readyState: el.readyState,
  };

  // ---------- probe 2: Media Session (title/artist and Spotify's own handlers) ----------

  const handlers = {};
  hook('mediaSession', () => {
    if (!navigator.mediaSession) return;
    const ms = navigator.mediaSession;
    const origSet = ms.setActionHandler.bind(ms);
    ms.setActionHandler = (action, fn) => {
      handlers[action] = fn;
      if (!report.mediaSession.actions.includes(action)) report.mediaSession.actions.push(action);
      return origSet(action, fn);
    };
  });
  function sessionMeta() {
    const m = navigator.mediaSession && navigator.mediaSession.metadata;
    return m ? { title: m.title, artist: m.artist, album: m.album, artwork: (m.artwork || []).map((a) => a.src).slice(0, 1) } : null;
  }

  // ---------- probe 3: player bar DOM ----------

  const SELECTORS = {
    nowPlayingWidget: '[data-testid="now-playing-widget"]',
    nowPlayingBar: '[data-testid="now-playing-bar"]',
    title: '[data-testid="context-item-info-title"]',
    titleLink: '[data-testid="context-item-link"]',
    artist: '[data-testid="context-item-info-artist"]',
    playPause: '[data-testid="control-button-playpause"]',
    next: '[data-testid="control-button-skip-forward"]',
    repeat: '[data-testid="control-button-repeat"]',
    shuffle: '[data-testid="control-button-shuffle"]',
    position: '[data-testid="playback-position"]',
    duration: '[data-testid="playback-duration"]',
    progressInput: '[data-testid="playback-progressbar"] input[type="range"]',
    volumeInput: '[data-testid="volume-bar"] input[type="range"]',
    actionBarPlay: '[data-testid="action-bar-row"] [data-testid="play-button"]',
    anyPlayButton: '[data-testid="play-button"]',
    adMarker: '[data-testid="context-item-info-ad-title"], [data-testid="ad-link"]',
  };
  const $ = (sel) => document.querySelector(sel);

  const TRACK_RE = /(?:\/track\/|spotify:track:|spotify%3Atrack%3A)([A-Za-z0-9]{22})/;
  // Collects spotify:track: uris in an object, a few levels deep.
  function findTrackUris(obj, depth, path, seen, hits) {
    if (!obj || depth < 0 || hits.length > 20) return;
    if (typeof obj === 'string') {
      const m = obj.match(TRACK_RE);
      if (m) hits.push({ id: m[1], path });
      return;
    }
    if (typeof obj !== 'object' || seen.has(obj) || obj instanceof Node) return;
    seen.add(obj);
    let keys;
    try { keys = Object.keys(obj).slice(0, 60); } catch (e) { return; }
    for (const k of keys) {
      if (k === 'children' || k === '_owner' || k.startsWith('__react')) continue;
      let v;
      try { v = obj[k]; } catch (e) { continue; }
      findTrackUris(v, depth - 1, `${path}.${k}`, seen, hits);
    }
  }

  // The fiber of the bar whose props hold the player state (props.state).
  function stateFiber(root) {
    const key = Object.keys(root).find((k) => k.startsWith('__reactFiber$'));
    let f = key && root[key];
    for (let up = 0; f && up < 25; up++, f = f.return) {
      const st = f.memoizedProps && f.memoizedProps.state;
      if (st && typeof st === 'object' && ('context' in st || 'item' in st || 'track' in st)) return { f, up, st };
    }
    return null;
  }

  // The player bar links only to the album and artist, so the track id is
  // looked up in the React props of the bar's elements and their parents.
  // The context uri is the playlist/album/track that was started, not the
  // current track, so other uris win over it.
  let lastCandidates = [];
  function idFromReact(root) {
    const hits = [];
    const nodes = [root, ...root.querySelectorAll('[data-testid], a')].slice(0, 40);
    for (const node of nodes) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      let f = key && node[key];
      for (let up = 0; f && up < 25; up++, f = f.return) {
        findTrackUris(f.memoizedProps, 4, `${node.getAttribute('data-testid') || node.tagName}^${up}.props`, new Set(), hits);
      }
      if (hits.length > 20) break;
    }
    const uniq = [];
    for (const h of hits) if (!uniq.some((u) => u.id === h.id && u.path === h.path)) uniq.push(h);
    lastCandidates = uniq.slice(0, 12);
    return uniq.find((h) => !/\.context\b/.test(h.path)) || uniq[0] || null;
  }

  // Shape of the player state: keys, with nested keys one level down and
  // short sample values, so the right fields can be chosen.
  function describeState(st) {
    const out = {};
    for (const k of Object.keys(st).slice(0, 60)) {
      let v;
      try { v = st[k]; } catch (e) { continue; }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = {};
        for (const k2 of Object.keys(v).slice(0, 30)) {
          let v2;
          try { v2 = v[k2]; } catch (e) { continue; }
          inner[k2] = v2 && typeof v2 === 'object' ? (Array.isArray(v2) ? `[array ${v2.length}]` : `{${Object.keys(v2).slice(0, 12).join(',')}}`) : (typeof v2 === 'string' ? v2.slice(0, 80) : v2);
        }
        out[k] = inner;
      } else if (Array.isArray(v)) {
        out[k] = `[array ${v.length}]`;
      } else {
        out[k] = typeof v === 'string' ? v.slice(0, 80) : (typeof v === 'function' ? 'fn' : v);
      }
    }
    return out;
  }

  function nowPlayingId() {
    const root = $(SELECTORS.nowPlayingWidget) || $(SELECTORS.nowPlayingBar) || document.querySelector('footer');
    if (!root) return { id: '', hrefs: [] };
    const hrefs = [...root.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
    for (const h of hrefs) {
      const m = h.match(TRACK_RE);
      if (m) return { id: m[1], hrefs, via: 'href' };
    }
    const hit = idFromReact(root);
    return hit ? { id: hit.id, hrefs, via: hit.path } : { id: '', hrefs };
  }

  function domState() {
    const pp = $(SELECTORS.playPause);
    const rep = $(SELECTORS.repeat);
    const np = nowPlayingId();
    const widget = $(SELECTORS.nowPlayingWidget);
    return {
      trackId: np.id,
      trackIdVia: np.via || null,
      trackIdCandidates: lastCandidates,
      hrefs: np.hrefs.slice(0, 6),
      widgetLabel: widget ? widget.getAttribute('aria-label') : null,
      title: ($(SELECTORS.title) || {}).textContent || null,
      artist: ($(SELECTORS.artist) || {}).textContent || null,
      playPauseLabel: pp ? pp.getAttribute('aria-label') : null,
      repeatLabel: rep ? rep.getAttribute('aria-label') : null,
      repeatChecked: rep ? rep.getAttribute('aria-checked') : null,
      position: ($(SELECTORS.position) || {}).textContent || null,
      duration: ($(SELECTORS.duration) || {}).textContent || null,
      progressValue: ($(SELECTORS.progressInput) || {}).value || null,
      volumeValue: ($(SELECTORS.volumeInput) || {}).value || null,
      adMarker: !!$(SELECTORS.adMarker),
    };
  }

  function checkSelectors() {
    for (const [name, sel] of Object.entries(SELECTORS)) report.selectors[name] = document.querySelectorAll(sel).length;
  }

  // ---------- probe 4: background tab behaviour (DOM vs media clock) ----------

  let lastSampleAt = 0;
  let lastDomPos = null;
  let lastMediaTime = null;
  let lastId = '';
  function sample() {
    const t = Date.now();
    const gap = lastSampleAt ? t - lastSampleAt : 0;
    lastSampleAt = t;
    const b = report.background;
    b.samples++;
    b.maxGapMs = Math.max(b.maxGapMs, gap);
    const el = mainMedia();
    const pos = ($(SELECTORS.position) || {}).textContent || null;
    if (document.hidden) {
      b.hiddenSamples++;
      b.maxHiddenGapMs = Math.max(b.maxHiddenGapMs, gap);
      // Media clock moved but the position text did not: the DOM is stale.
      if (el && !el.paused && lastMediaTime != null && el.currentTime - lastMediaTime > 1.5 && pos === lastDomPos) b.staleDomWhileHidden++;
    }
    lastDomPos = pos;
    lastMediaTime = el ? el.currentTime : null;

    const id = nowPlayingId().id;
    if (id !== lastId) {
      lastId = id;
      const root = $(SELECTORS.nowPlayingWidget);
      const sf = root && stateFiber(root);
      if (sf) report.playerState = { fiberUp: sf.up, shape: describeState(sf.st) };
      report.nowPlayingIds.push({ id, at: now(), hidden: document.hidden, meta: sessionMeta(), media: mediaState(el), dom: domState() });
      log(`now playing id -> ${id || '(none)'}`);
    }
  }
  document.addEventListener('visibilitychange', () => log(`tab ${document.hidden ? 'hidden' : 'visible'}`));

  // ---------- probe 5: play a given track (SPA navigation + click) ----------

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await wait(200);
    }
    return null;
  }

  async function playTrack(input) {
    const m = String(input).match(/([A-Za-z0-9]{22})/);
    if (!m) return log('play test: no 22-character track id in input');
    const id = m[1];
    const test = { id, at: now(), steps: [] };
    report.playTests.push(test);
    const step = (s) => { test.steps.push(`${((now() - test.at) / 1000).toFixed(1)}s ${s}`); log(`play test: ${s}`); };

    const before = location.href;
    const loadsBefore = report.trackLoads.length;
    const oldButton = $(SELECTORS.actionBarPlay);
    const oldHeading = (document.querySelector('main h1') || {}).textContent || '';
    history.pushState({}, '', `/track/${id}`);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    step(`pushState+popstate from ${before} (old heading: ${oldHeading})`);

    // The old page's button stays in the DOM for a moment, so wait until the
    // button is a new element and the heading has changed.
    const routed = await waitFor(() => {
      const b = $(SELECTORS.actionBarPlay);
      const h = (document.querySelector('main h1') || {}).textContent || '';
      return b && b !== oldButton && h && h !== oldHeading ? b : null;
    }, 4000);
    test.routed = !!routed;
    test.heading = (document.querySelector('main h1') || {}).textContent || null;
    step(routed ? `track page rendered (heading: ${test.heading})` : `new page not seen within 4s (heading: ${test.heading})`);

    // Navigation alone may start the track (Spotify adds ?autoplay_ok=1).
    // Wait for that before clicking anything.
    const media = mainMedia();
    const oldDur = media ? media.duration : 0;
    const auto = await waitFor(() => report.trackLoads.length > loadsBefore && mainMedia() && !mainMedia().paused, 4000);
    test.autoplayedOnNavigate = !!auto;
    test.urlAfter = location.pathname + location.search;
    step(auto ? `started by navigation alone (url now ${test.urlAfter})` : 'navigation did not start playback within 4s');
    if (!auto) {
      if (!routed) return;
      const btn = $(SELECTORS.actionBarPlay);
      test.buttonLabel = btn.getAttribute('aria-label');
      btn.click();
      step(`clicked play button (aria-label: ${test.buttonLabel})`);
    }

    // Started: the bar shows the id, or the media loaded a new track.
    const started = await waitFor(() => {
      const m = mainMedia();
      return m && !m.paused && (report.trackLoads.length > loadsBefore || nowPlayingId().id === id || Math.abs(m.duration - oldDur) > 0.5);
    }, 15000);
    test.started = !!started;
    test.barId = nowPlayingId().id || null;
    test.barIdMatches = test.barId === id;
    test.meta = sessionMeta();
    test.media = mediaState(mainMedia());
    test.dom = domState();
    step(started ? `playing: ${test.meta && test.meta.title} (bar id ${test.barId || 'unknown'}, ${test.barIdMatches ? 'matches' : 'no match'})` : `not started within 15s (bar id: ${test.barId || 'none'})`);
  }

  // ---------- probe 6: volume control on the media element ----------

  async function volumeTest() {
    const el = mainMedia();
    if (!el) return log('volume test: no playing media element');
    const start = el.volume;
    const test = { start: +start.toFixed(2), sliderBefore: ($(SELECTORS.volumeInput) || {}).value || null, readings: [] };
    report.volumeTests.push(test);
    log(`volume test: fading from ${start.toFixed(2)} to 0 over 4s`);
    for (let i = 1; i <= 20; i++) {
      const want = start * (1 - i / 20);
      el.volume = want;
      await wait(200);
      test.readings.push({ want: +want.toFixed(2), got: +el.volume.toFixed(2) });
    }
    await wait(1000);
    test.after1s = +el.volume.toFixed(2); // did Spotify put its own volume back?
    test.sliderAfter = ($(SELECTORS.volumeInput) || {}).value || null;
    el.volume = start;
    log(`volume test: done, 1s after fade volume was ${test.after1s}; restored ${start.toFixed(2)}`);
  }

  // ---------- probe 7: Spotify's own handlers and internals ----------

  async function sessionHandlerTest() {
    const res = { available: Object.keys(handlers) };
    report.mediaSession.handlerTest = res;
    if (!handlers.pause || !handlers.play) return log('handler test: no play/pause handlers captured');
    const el = mainMedia();
    handlers.pause({ action: 'pause' });
    await wait(1200);
    res.pausedAfterPause = el ? el.paused : null;
    res.labelAfterPause = ($(SELECTORS.playPause) || { getAttribute: () => null }).getAttribute('aria-label');
    handlers.play({ action: 'play' });
    await wait(1200);
    res.pausedAfterPlay = el ? el.paused : null;
    if (handlers.seekto && el && el.duration > 20) {
      handlers.seekto({ action: 'seekto', seekTime: 10 });
      await wait(1200);
      res.timeAfterSeekTo10 = +el.currentTime.toFixed(2);
    }
    log(`handler test: ${JSON.stringify(res)}`);
  }

  // Looks for an internal player object (like Deezer's dzPlayer) through the
  // React tree, the way Spicetify finds Spotify's Platform.
  // Values the bar's components read with useContext: Spotify's services
  // (player, platform) are often handed down this way.
  function contextProbe(out) {
    const nodes = [$(SELECTORS.nowPlayingWidget), $(SELECTORS.playPause), $(SELECTORS.volumeInput)].filter(Boolean);
    const found = [];
    const seenCtx = new Set();
    for (const node of nodes) {
      const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
      let f = key && node[key];
      for (let up = 0; f && up < 60; up++, f = f.return) {
        for (let d = f.dependencies && f.dependencies.firstContext; d; d = d.next) {
          const ctx = d.context;
          if (!ctx || seenCtx.has(ctx)) continue;
          seenCtx.add(ctx);
          const v = ctx._currentValue;
          if (!v || typeof v !== 'object') continue;
          const methods = new Set();
          for (let o = v; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
            try { Object.getOwnPropertyNames(o).forEach((n) => { try { if (typeof v[n] === 'function') methods.add(n); } catch (e) { /* ignore */ } }); } catch (e) { /* ignore */ }
          }
          const keys = Object.keys(v).slice(0, 25);
          const interesting = [...methods].some((n) => /play|pause|resume|seek|skip|volume|getPlayerAPI|queue/i.test(n))
            || keys.some((k) => /player|platform|playback/i.test(k));
          if (interesting) {
            const i = found.length;
            window[`__probeCtx${i}`] = v;
            found.push({ index: i, from: `${node.getAttribute('data-testid')}^${up}`, name: ctx.displayName || null, keys, methods: [...methods].sort().slice(0, 60) });
          }
        }
      }
    }
    out.contexts = found;
  }

  function internalProbe() {
    const out = report.internal;
    try { contextProbe(out); } catch (e) { out.contextError = String(e); }
    out.webpackGlobals = Object.keys(window).filter((k) => /webpack/i.test(k));
    out.playerishGlobals = Object.keys(window).filter((k) => /player|platform|spotify/i.test(k)).slice(0, 30);

    const rootEl = document.getElementById('main') || document.body.firstElementChild;
    const fiberKey = rootEl && Object.keys(rootEl).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
    out.reactRootFound = !!fiberKey;
    if (!fiberKey) return log('internal probe: no React root found');

    const seen = new Set();
    const stack = [rootEl[fiberKey]];
    let visited = 0;
    let platform = null;
    const isPlatform = (c) => c && typeof c === 'object' && typeof c.getPlayerAPI === 'function';
    let contextHit = null;
    while (stack.length && visited < 400000 && !platform) {
      const f = stack.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      visited++;
      const props = f.memoizedProps;
      const value = props && props.value;
      const cands = [value, props && props.platform, props];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        try { for (const k of Object.keys(value).slice(0, 40)) cands.push(value[k]); } catch (e) { /* ignore */ }
      }
      for (const c of cands) {
        if (isPlatform(c)) { platform = c; break; }
      }
      // A player-like object (play/pause/skip) is worth noting even without Platform.
      if (!contextHit && value && typeof value === 'object') {
        for (const c of cands) {
          if (c && typeof c === 'object' && ['pause', 'resume', 'skipToNext'].every((n) => typeof c[n] === 'function')) {
            contextHit = c;
            break;
          }
        }
      }
      if (f.sibling) stack.push(f.sibling);
      if (f.child) stack.push(f.child);
    }
    out.fibersVisited = visited;
    out.platformFound = !!platform;
    if (contextHit) {
      window.__probePlayerLike = contextHit;
      const names = new Set();
      for (let o = contextHit; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
      out.playerLikeMethods = [...names].filter((n) => { try { return typeof contextHit[n] === 'function'; } catch (e) { return false; } }).sort().slice(0, 80);
    }
    if (!platform) return log(`internal probe: no Platform.getPlayerAPI in ${visited} fibers; player-like object: ${!!contextHit}; interesting contexts: ${(out.contexts || []).length}`);

    window.__probePlatform = platform;
    out.platformApis = Object.keys(platform).filter((k) => /^get/.test(k)).slice(0, 60);
    try {
      const api = platform.getPlayerAPI();
      window.__probePlayerAPI = api;
      const names = new Set();
      for (let o = api; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
      out.playerApiMethods = [...names].filter((n) => typeof api[n] === 'function').sort();
      const st = typeof api.getState === 'function' ? api.getState() : null;
      out.playerStateKeys = st ? Object.keys(st) : null;
      out.playerStateSample = st ? JSON.stringify(st, (k, v) => (typeof v === 'string' && v.length > 80 ? v.slice(0, 80) : v)).slice(0, 1500) : null;
    } catch (e) {
      out.playerApiError = String(e);
    }
    log('internal probe: Platform found, see report.internal (also window.__probePlayerAPI)');
  }

  // ---------- panel ----------

  function el(tag, props, ...children) {
    const e = origCreate.call(document, tag);
    Object.assign(e, props || {});
    for (const c of children) e.append(c);
    return e;
  }

  function buildPanel() {
    const out = el('pre', { style: 'margin:6px 0 0;max-height:220px;overflow:auto;white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace' });
    const input = el('input', { placeholder: 'track URL or ID', style: 'width:100%;box-sizing:border-box;margin:4px 0;padding:3px;color:#000' });
    const btn = (label, fn) => {
      const b = el('button', { textContent: label, style: 'margin:2px;padding:3px 6px;cursor:pointer;color:#000' });
      b.addEventListener('click', async () => { try { await fn(); } catch (e) { log(`${label}: ${e}`); } });
      return b;
    };
    const panel = el('div', { style: 'position:fixed;right:12px;bottom:100px;width:340px;z-index:2147483647;padding:8px;border-radius:8px;background:rgba(20,20,20,.94);color:#eee;font:12px system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.5)' },
      el('b', { textContent: 'Spotify probe' }),
      input,
      btn('Play track', () => playTrack(input.value)),
      btn('Volume fade', volumeTest),
      btn('Session pause/play/seek', sessionHandlerTest),
      btn('Internal API', internalProbe),
      btn('Copy report', async () => {
        checkSelectors();
        report.snapshot = { at: now(), media: mediaState(mainMedia()), allMedia: elements.map(mediaState), meta: sessionMeta(), dom: domState(), activated: navigator.userActivation ? navigator.userActivation.hasBeenActive : null };
        const text = JSON.stringify(report, null, 1);
        try { await navigator.clipboard.writeText(text); log('report copied to clipboard'); }
        catch (e) { console.log(text); log('clipboard blocked: report printed to the console'); }
      }),
      out);
    // Hung on <html>, not <body>, and put back if the page removes it.
    const mount = () => { if (!panel.isConnected) (document.documentElement || document.body).append(panel); };
    mount();
    setInterval(mount, 1000);
    setInterval(() => {
      const m = mediaState(mainMedia());
      const d = domState();
      out.textContent = [
        `media: ${m ? `#${m.index} ${m.tag} ${m.time}/${m.dur}s ${m.paused ? 'paused' : 'playing'} vol ${m.vol}` : 'none captured yet'}`,
        `bar id: ${d.trackId || '-'}  ad marker: ${d.adMarker}`,
        `bar: ${d.title || '-'} / ${d.artist || '-'}  ${d.position || '?'} / ${d.duration || '?'}`,
        `session: ${JSON.stringify(sessionMeta())}`,
        `handlers: ${Object.keys(handlers).join(', ') || '-'}`,
        '',
        ...report.log.slice(-8),
      ].join('\n');
    }, 500);
  }

  function onReady() {
    try {
      buildPanel();
    } catch (e) {
      console.error('[spotify-probe] panel failed', e);
      return;
    }
    setInterval(() => { try { sample(); } catch (e) { log(`sample failed: ${e}`); } }, 500);
    setTimeout(checkSelectors, 5000);
    log('probe ready');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();
})();
