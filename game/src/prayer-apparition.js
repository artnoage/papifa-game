// Dramatic prayer apparition (v4.1 Task B):
// When a team chooses Jesus or Mother Mary, an Orthodox icon descends smoothly from the top edge
// on the praying side with soft golden rays, holds ~1.5 s in the top third, and fades up and out
// (~3 s total), paired with a ~2 s "Jesus is with you!" / "Mother Mary is with you!" banner.
// Driven by match time `displayT` so live play, slow-motion goal replays, and online guests stay synchronized.

const HISTORY_S = 8.0;
const DESCENT_S = 0.55;
const HOLD_END_S = 2.05; // 0.55 + 1.50 s hold
const TOTAL_S = 3.00;
const BANNER_END_S = 2.15;

const ICON_SRC = {
  jesus: 'assets/ui/icon_christ.webp',
  mary: 'assets/ui/icon_mary.webp',
  george: 'assets/ui/icon_george.webp',
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOutCubic = (u) => 1 - (1 - u) ** 3;
const easeInCubic = (u) => u * u * u;

export function prayerBannerText(kind, langPref = 'en') {
  const lang = langPref === 'el' || langPref === 'en'
    ? langPref
    : ((globalThis.navigator?.language || '').toLowerCase().startsWith('el') ? 'el' : 'en');
  if (kind === 'mary') {
    return lang === 'el' ? 'Η Παναγία είναι μαζί σου!' : 'Mother Mary is with you!';
  }
  if (kind === 'george') {
    return lang === 'el' ? 'Ο Άγιος Γεώργιος είναι μαζί σου!' : 'St George is with you!';
  }
  return lang === 'el' ? 'Ο Χριστός είναι μαζί σου!' : 'Jesus is with you!';
}

export function createPrayerApparition(root) {
  let layer = root.querySelector('#prayer-apparition-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'prayer-apparition-layer';
    layer.setAttribute('aria-live', 'polite');
    root.append(layer);
  }
  layer.innerHTML = '';

  const slots = [0, 1].map((team) => {
    const el = document.createElement('div');
    el.id = `prayer-apparition-${team}`;
    el.className = 'prayer-apparition';
    el.dataset.team = String(team);
    el.hidden = true;
    el.innerHTML = `
      <div class="apparition-stage">
        <div class="apparition-rays" aria-hidden="true"></div>
        <div class="apparition-figure">
          <img class="apparition-img" alt="">
        </div>
      </div>
      <div class="apparition-banner"></div>
    `;
    layer.append(el);
    return {
      el,
      stage: el.querySelector('.apparition-stage'),
      rays: el.querySelector('.apparition-rays'),
      img: el.querySelector('.apparition-img'),
      banner: el.querySelector('.apparition-banner'),
      currentKind: '',
    };
  });

  let recordedMatch = null;
  let lastT = -Infinity;
  let preloaded = false;
  const preloadedImages = [];
  const history = []; // { t, team, kind }

  function preload() {
    if (preloaded || typeof Image === 'undefined') return;
    preloaded = true;
    for (const src of Object.values(ICON_SRC)) {
      const im = new Image();
      im.src = src;
      im.decode?.().catch(() => {});
      preloadedImages.push(im);
    }
  }

  function reset() {
    history.length = 0;
    lastT = -Infinity;
    for (const s of slots) {
      s.el.hidden = true;
      delete s.el.dataset.active;
    }
  }

  function recordEvents(match, events) {
    if (!match || !events?.length) return;
    if (match !== recordedMatch || match.t < lastT - 0.5) {
      history.length = 0;
      recordedMatch = match;
    }
    lastT = match.t;
    const cutoff = match.t - HISTORY_S;
    for (const e of events) {
      if (e.type !== 'prayer' || (e.team !== 0 && e.team !== 1)) continue;
      if (e.kind !== 'jesus' && e.kind !== 'mary' && e.kind !== 'george') continue;
      // Avoid duplicate entry on identical timestamp/team/kind.
      const dup = history.some((h) => h.team === e.team && h.kind === e.kind && Math.abs(h.t - match.t) < 0.12);
      if (!dup) history.push({ t: match.t, team: e.team, kind: e.kind });
    }
    while (history.length && history[0].t < cutoff) history.shift();
  }

  function update(displayT, { hidden = false, lang = 'en' } = {}) {
    if (hidden || displayT === null || displayT === undefined || !Number.isFinite(displayT)) {
      for (const s of slots) {
        s.el.hidden = true;
        delete s.el.dataset.active;
      }
      return;
    }

    for (let team = 0; team < 2; team++) {
      const s = slots[team];
      let ev = null;
      for (let i = history.length - 1; i >= 0; i--) {
        const h = history[i];
        if (h.team !== team || h.t > displayT + 0.001) continue;
        const age = Math.max(0, displayT - h.t);
        if (age <= TOTAL_S) { ev = { ...h, age }; break; }
        break;
      }
      if (!ev) {
        s.el.hidden = true;
        delete s.el.dataset.active;
        continue;
      }

      const age = ev.age;
      s.el.hidden = false;
      s.el.dataset.active = 'true';
      s.el.dataset.kind = ev.kind;
      if (s.currentKind !== ev.kind) {
        s.currentKind = ev.kind;
        s.img.src = ICON_SRC[ev.kind];
      }
      const text = prayerBannerText(ev.kind, lang);
      if (s.banner.textContent !== text) s.banner.textContent = text;

      // Vertical glide + opacity timeline (0..0.55 descent, 0.55..2.05 hold, 2.05..3.00 fade up & out).
      let yPct = 0;
      let opacity = 0.90;
      let rayScale = 1.0;
      if (age < DESCENT_S) {
        const u = easeOutCubic(clamp01(age / DESCENT_S));
        yPct = -108 * (1 - u);
        opacity = 0.22 + 0.68 * u;
        rayScale = 0.72 + 0.30 * u;
      } else if (age <= HOLD_END_S) {
        const holdU = (age - DESCENT_S) / (HOLD_END_S - DESCENT_S);
        yPct = Math.sin(holdU * Math.PI * 2) * 2.2;
        opacity = 0.90;
        rayScale = 1.02 + Math.sin(holdU * Math.PI) * 0.08;
      } else {
        const u = easeInCubic(clamp01((age - HOLD_END_S) / (TOTAL_S - HOLD_END_S)));
        yPct = -58 * u;
        opacity = 0.90 * (1 - u);
        rayScale = 1.04 - 0.16 * u;
      }

      s.el.style.transform = `translate3d(0, ${yPct.toFixed(1)}%, 0)`;
      s.stage.style.opacity = opacity.toFixed(3);
      s.rays.style.transform = `rotate(${(age * 16).toFixed(1)}deg) scale(${rayScale.toFixed(3)})`;

      // Praying-side banner (~2 s visible, starting on exact Frame 0 with icon + voice + aura).
      let bOp = 0;
      let bScale = 1;
      if (age < 0.20) {
        const u = easeOutCubic(clamp01(age / 0.20));
        bOp = 0.35 + 0.65 * u;
        bScale = 0.92 + 0.08 * u;
      } else if (age <= 1.75) {
        bOp = 1;
      } else if (age < BANNER_END_S) {
        const u = clamp01((age - 1.75) / (BANNER_END_S - 1.75));
        bOp = 1 - u;
        bScale = 1 - 0.04 * u;
      }
      s.banner.style.opacity = bOp.toFixed(3);
      s.banner.style.transform = `scale(${bScale.toFixed(3)})`;
      s.banner.hidden = bOp <= 0.01;
    }
  }

  return { preload, recordEvents, update, reset };
}
