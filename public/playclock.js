'use strict';

// Local play clock shared by the control page and the display page.
// It deliberately never syncs with the position the player reports: syncing
// made the display jump. Instead the known track length is counted down
// locally, and the clock only reacts to events: playback starting, pausing
// (including ads or another song playing), resuming, a new track, stop, end.
// Pause/resume pressed in the control page arrive as a server "hint" and act
// immediately; the player's own report takes over a few seconds later.
const HINT_MS = 3000;

class PlayClock {
  constructor() {
    this.key = null;          // seq of the play command this clock belongs to
    this.dur = 0;             // seconds
    this.acc = 0;             // ms counted before the current run
    this.runningSince = null; // performance.now() when the current run started
    this.fresh = true;        // page just opened: may join a track mid-way
    this.hintAt = null;       // server time of the last pause/resume hint seen
    this.hintSeenAt = 0;      // local time it was first seen
  }

  get running() {
    return this.runningSince !== null;
  }

  // Seconds played, clamped to the track length.
  position() {
    let ms = this.acc;
    if (this.running) ms += performance.now() - this.runningSince;
    return Math.max(0, Math.min(ms / 1000, this.dur || Infinity));
  }

  reset(key) {
    this.key = key;
    this.acc = 0;
    this.runningSince = null;
  }

  freeze() {
    if (!this.running) return;
    this.acc += performance.now() - this.runningSince;
    this.runningSince = null;
  }

  // Feed every state snapshot from the server.
  update(s) {
    const cur = s.current;
    const t = cur && cur.track;
    if (!t) {
      this.dur = 0;
      return this.reset(null);
    }

    const st = s.players[cur.output] && s.players[cur.output].status;
    const sameTrack = (x) => cur.output === 'preview'
      ? x.seq === cur.seq
      // Deezer may play an alternative version with another id; accept the same title too.
      : x.songId === t.id || (!!x.title && x.title.trim().toLowerCase() === t.title.trim().toLowerCase());
    const matches = !!st && sameTrack(st);

    let dur = t.duration || 0;
    // Preview clips and 30s-limited accounts are shorter than the track.
    if (matches && st.duration && (cur.output === 'preview' || st.limited)) dur = Math.min(dur, st.duration);
    if (s.settings.maxPlaySeconds > 0) dur = Math.min(dur, s.settings.maxPlaySeconds);
    this.dur = Math.round(dur);

    const wasFresh = this.fresh;
    this.fresh = false;
    if (cur.seq !== this.key) {
      this.reset(cur.seq);
      // The reported position is used only when joining a track mid-way: when
      // the page opens, or when a track was picked directly in Deezer.
      if ((wasFresh || cur.external) && matches) this.acc = (Number(st.position) || 0) * 1000;
      else if (cur.external) this.acc = (Number(cur.startPosition) || 0) * 1000;
    }

    if (cur.endedAt) {
      this.runningSince = null;
      this.acc = this.dur * 1000;
      return;
    }

    const hint = cur.hint;
    if (hint && hint.at !== this.hintAt) {
      this.hintAt = hint.at;
      // A hint that already existed when the page opened is old news.
      this.hintSeenAt = wasFresh ? -Infinity : performance.now();
    }
    const hintFresh = !!hint && performance.now() - this.hintSeenAt < HINT_MS;

    let playing = matches && st.playing;
    if (hintFresh) playing = hint.state === 'playing' && (matches || this.position() > 0);

    if (playing) {
      if (!this.running) this.runningSince = performance.now();
    } else {
      this.freeze();
    }
  }

  // Whole seconds, so elapsed and remaining always change together.
  view() {
    const pos = this.position();
    const elapsed = Math.floor(pos);
    return {
      active: this.key !== null,
      running: this.running,
      dur: this.dur,
      elapsed,
      remaining: Math.max(0, this.dur - elapsed),
      fraction: this.dur ? pos / this.dur : 0,
    };
  }
}
