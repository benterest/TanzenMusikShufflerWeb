'use strict';

// Dance step footprints shown next to the timer. The dance is recognised from
// the playlist name (or the track title), and its basic rhythm is animated in
// time with the play clock: the animation stops when the clock stops.
//
// steps: [beats, count label, small?]. Small footprints mark quick steps,
// e.g. the "cha-cha-cha" of the Cha Cha.
// barsPerMin: standard competition tempo, used unless the track title names one.
const DANCES = [
  { name: 'Viennese Waltz', match: ['wienerwalzer', 'viennesewaltz'], beatsPerBar: 3, barsPerMin: 59,
    steps: [[1, '1'], [1, '2'], [1, '3']] },
  { name: 'Slow Waltz', match: ['langsamerwalzer', 'slowwaltz', 'englishwaltz', 'englischerwalzer', 'walzer', 'waltz'], beatsPerBar: 3, barsPerMin: 29,
    steps: [[1, '1'], [1, '2'], [1, '3']] },
  { name: 'Tango', match: ['tango'], beatsPerBar: 4, barsPerMin: 32,
    steps: [[1, 'S'], [1, 'S'], [0.5, 'Q', true], [0.5, 'Q', true], [1, 'S']] },
  { name: 'Slowfox', match: ['slowfox', 'foxtrot'], beatsPerBar: 4, barsPerMin: 29,
    steps: [[2, 'S'], [1, 'Q', true], [1, 'Q', true]] },
  { name: 'Quickstep', match: ['quickstep'], beatsPerBar: 4, barsPerMin: 51,
    steps: [[2, 'S'], [1, 'Q', true], [1, 'Q', true], [2, 'S']] },
  { name: 'Cha Cha', match: ['chacha'], beatsPerBar: 4, barsPerMin: 31,
    steps: [[1, '2'], [1, '3'], [0.5, '4', true], [0.5, '&', true], [1, '1', true]] },
  { name: 'Rumba', match: ['rumba'], beatsPerBar: 4, barsPerMin: 26,
    steps: [[1, '2'], [1, '3'], [2, '4-1']] },
  { name: 'Samba', match: ['samba'], beatsPerBar: 2, barsPerMin: 51,
    steps: [[0.75, '1'], [0.25, 'a', true], [1, '2']] },
  { name: 'Paso Doble', match: ['pasodoble'], beatsPerBar: 2, barsPerMin: 61,
    steps: [[1, '1'], [1, '2']] },
  { name: 'Jive', match: ['jive'], beatsPerBar: 4, barsPerMin: 43,
    steps: [[1, '1'], [1, '2'], [0.75, '3', true], [0.25, 'a', true], [1, '4', true], [0.75, '5', true], [0.25, 'a', true], [1, '6', true]] },
  { name: 'Discofox', match: ['discofox'], beatsPerBar: 4, barsPerMin: 31,
    steps: [[1, '1'], [1, '2'], [1, 'tap', true]] },
  { name: 'Salsa', match: ['salsa'], beatsPerBar: 4, barsPerMin: 45,
    steps: [[1, '1'], [1, '2'], [2, '3'], [1, '5'], [1, '6'], [2, '7']] },
];

const normalize = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '');

// Returns { dance, beatsPerSec } or null.
function detectDance(playlistTitle, trackTitle) {
  const find = (text) => {
    const n = normalize(text);
    return n && DANCES.find((d) => d.match.some((m) => n.includes(m)));
  };
  const dance = find(playlistTitle) || find(trackTitle);
  if (!dance) return null;

  // Dance labels often put the tempo in the title, e.g. "Slow Waltz: 29BPM".
  // Small numbers are bars per minute, larger ones beats per minute.
  let barsPerMin = dance.barsPerMin;
  const m = String(trackTitle || '').match(/(\d{2,3})\s*bpm/i);
  if (m) {
    const n = Number(m[1]);
    const bars = n <= 70 ? n : n / dance.beatsPerBar;
    if (bars >= 10 && bars <= 90) barsPerMin = bars;
  }
  return { dance, beatsPerSec: (barsPerMin * dance.beatsPerBar) / 60 };
}

const FOOT_SVG = '<svg viewBox="0 0 20 40" aria-hidden="true"><ellipse cx="10" cy="13" rx="7.5" ry="12"/><ellipse cx="10" cy="33.5" rx="5.5" ry="6"/></svg>';

class StepsView {
  constructor(el) {
    this.el = el;
    this.info = null;
    this.key = '';
    this.lastStep = -1;
    this.lastCycle = -1;
  }

  // Call when the track, playlist or setting changes.
  set(info, visible) {
    const key = visible && info ? `${info.dance.name}:${info.beatsPerSec}` : '';
    if (key === this.key) return;
    this.key = key;
    this.info = visible ? info : null;
    this.lastStep = -1;
    this.lastCycle = -1;
    this.el.hidden = !this.info;
    if (!this.info) return (this.el.innerHTML = '');
    const steps = this.info.dance.steps;
    this.el.title = this.info.dance.name;
    this.el.innerHTML = steps.map(([, label, small]) =>
      `<span class="step${small ? ' quick' : ''}"><span class="foot">${FOOT_SVG}</span><span class="count">${label}</span></span>`).join('');
    this.starts = [];
    let b = 0;
    for (const [beats] of steps) {
      this.starts.push(b);
      b += beats;
    }
    this.cycleBeats = b;
  }

  // Call every animation frame with the play clock position in seconds.
  frame(positionSec) {
    if (!this.info) return;
    const beats = positionSec * this.info.beatsPerSec;
    const cycle = Math.floor(beats / this.cycleBeats);
    const within = beats - cycle * this.cycleBeats;
    let step = 0;
    while (step + 1 < this.starts.length && this.starts[step + 1] <= within) step++;
    if (step === this.lastStep && cycle === this.lastCycle) return;

    const n = this.starts.length;
    const els = this.el.children;
    for (let i = 0; i < n; i++) {
      const e = els[i];
      e.classList.toggle('landed', i <= step);
      e.classList.toggle('current', i === step);
      // Alternate feet across cycles too, so a 3-step waltz goes L R L, R L R.
      e.classList.toggle('right', (cycle * n + i) % 2 === 1);
    }
    // Restart the stamp animation on the new step.
    const cur = els[step];
    cur.classList.remove('stamp');
    void cur.offsetWidth;
    cur.classList.add('stamp');
    this.lastStep = step;
    this.lastCycle = cycle;
  }
}
