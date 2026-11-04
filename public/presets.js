'use strict';

// Priority presets: the icons next to "Playlists". Each one sets the slider
// value of every active playlist at once, in the order they are listed;
// unchecked playlists keep their values. Sloping presets run between 100
// and 10, so the last playlist still comes up now and then.
// Fast / Langsamer read the dance from the playlist name with detectDance()
// from steps.js.
(function (root) {
  const HIGH = 100;
  const LOW = 10;

  // CSS "ease-in-out" cubic Bézier (0.42, 0, 0.58, 1): flat at both ends,
  // steep in the middle. Solves x(t) = x by bisection, returns y(t).
  function easeInOut(x) {
    const bez = (t, a, b) => 3 * (1 - t) * (1 - t) * t * a + 3 * (1 - t) * t * t * b + t * t * t;
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, 0.42, 0.58) < x) lo = mid;
      else hi = mid;
    }
    return bez((lo + hi) / 2, 0, 1);
  }

  // From HIGH at the first playlist to LOW at the last, along `curve` (0..1 -> 0..1).
  const falling = (curve) => (playlists) => playlists.map((p, i, all) => {
    const t = all.length > 1 ? i / (all.length - 1) : 0;
    return Math.round(HIGH - (HIGH - LOW) * curve(t));
  });
  const rising = (curve) => (playlists) => falling(curve)(playlists).reverse();

  // How fast each dance feels on the floor (dance names from steps.js).
  const SPEED = {
    'Viennese Waltz': 'fast', Quickstep: 'fast', Jive: 'fast', 'Paso Doble': 'fast', Samba: 'fast', Tango: 'fast', Salsa: 'fast',
    'Cha Cha': 'medium', Discofox: 'medium',
    'Slow Waltz': 'slow', Slowfox: 'slow', Rumba: 'slow',
  };
  function speedOf(title) {
    const found = typeof detectDance === 'function' ? detectDance(title, '') : null;
    return found ? SPEED[found.dance.name] || null : null;
  }
  // Favoured speed 100, medium 50, the other end 20; unrecognised names 50.
  const bySpeed = (favour) => (playlists) => playlists.map((p) => {
    const speed = speedOf(p.title);
    return !speed || speed === 'medium' ? 50 : speed === favour ? 100 : 20;
  });

  // bars: the icon, five bars from left (first playlist) to right.
  const PRESETS = [
    { id: 'center', label: 'Center', title: 'Center: every playlist at 50 (equal shares)',
      apply: (pls) => pls.map(() => 50) },
    { id: 'linear', label: 'Linear', title: 'Linear: from 100 at the first playlist down to 10 at the last',
      apply: falling((t) => t) },
    { id: 'linear-rev', label: 'Reverse linear', title: 'Reverse linear: from 10 at the first playlist up to 100 at the last',
      apply: rising((t) => t) },
    { id: 'bezier', label: 'Bézier', title: 'Bézier: from 100 down to 10 along an S-curve (flat at both ends, steep in the middle)',
      apply: falling(easeInOut) },
    { id: 'bezier-rev', label: 'Reverse Bézier', title: 'Reverse Bézier: from 10 up to 100 along an S-curve',
      apply: rising(easeInOut) },
    { id: 'chess', label: 'Chess', title: 'Chess: alternating 100 and 30, row by row',
      apply: (pls) => pls.map((p, i) => (i % 2 === 0 ? 100 : 30)) },
    { id: 'fast', label: 'Fast', title: 'Fast: fast dances 100 (Viennese Waltz, Quickstep, Jive, Paso Doble, Samba, Tango, Salsa), Cha Cha and Discofox 50, slow dances 20 (Slow Waltz, Slowfox, Rumba). Playlists whose name names no dance get 50',
      apply: bySpeed('fast') },
    { id: 'slow', label: 'Langsamer', title: 'Langsamer: slow dances 100 (Slow Waltz, Slowfox, Rumba), Cha Cha and Discofox 50, fast dances 20 (Viennese Waltz, Quickstep, Jive, Paso Doble, Samba, Tango, Salsa). Playlists whose name names no dance get 50',
      apply: bySpeed('slow') },
    { id: 'random', label: 'Random', title: 'Random: a random value from 10 to 100 for each playlist',
      apply: (pls) => pls.map(() => LOW + Math.floor(Math.random() * (HIGH - LOW + 1))) },
  ];

  const api = { PRESETS, speedOf, easeInOut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Presets = api;
})(this);
