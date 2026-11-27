// Prayer HUD: dignified SVG hand affectionately holding a cross (top-left team 0, top-right team 1),
// crossbar gold charge fill, 2 remaining prayer beads/crosses, pulsing ready prompt, and 15 s active aura + countdown ring.
import { PRAYER } from './config.js';

const RING_R = 43;
const RING_C = 2 * Math.PI * RING_R;

function buildHandCrossSvg(team) {
  const uid = `pr-${team}`;
  // Dignified icon-style illustration: an open, gently upturned hand cradling a traditional
  // three-bar Orthodox cross (short top titulus, main crossbar gold charge meter, slanted footrest),
  // warm shaded skin tones and a hint of black-and-gold liturgical cassock cuff.
  return `
<svg class="prayer-svg" viewBox="0 0 96 96" width="76" height="76" aria-hidden="true">
  <defs>
    <clipPath id="${uid}-badge-clip">
      <circle cx="48" cy="48" r="41.5"/>
    </clipPath>
    <radialGradient id="${uid}-aura-jesus" cx="50%" cy="46%" r="50%">
      <stop offset="0%" stop-color="#fff7cc" stop-opacity="0.96"/>
      <stop offset="56%" stop-color="#f2b830" stop-opacity="0.48"/>
      <stop offset="100%" stop-color="#f2b830" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${uid}-aura-mary" cx="50%" cy="46%" r="50%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.96"/>
      <stop offset="56%" stop-color="#69bfff" stop-opacity="0.50"/>
      <stop offset="100%" stop-color="#4ba0f5" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${uid}-aura-george" cx="50%" cy="46%" r="50%">
      <stop offset="0%" stop-color="#fff8e0" stop-opacity="0.96"/>
      <stop offset="54%" stop-color="#e84a38" stop-opacity="0.54"/>
      <stop offset="100%" stop-color="#c92b24" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="${uid}-cross-wood" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#b4854d"/>
      <stop offset="48%" stop-color="#875d30"/>
      <stop offset="100%" stop-color="#583a1b"/>
    </linearGradient>
    <linearGradient id="${uid}-gold-fill" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#efae28"/>
      <stop offset="50%" stop-color="#fff4b8"/>
      <stop offset="100%" stop-color="#f6c43e"/>
    </linearGradient>
    <linearGradient id="${uid}-skin-palm" x1="15%" y1="10%" x2="85%" y2="95%">
      <stop offset="0%" stop-color="#f5d2ae"/>
      <stop offset="55%" stop-color="#dfa979"/>
      <stop offset="100%" stop-color="#bc8153"/>
    </linearGradient>
    <linearGradient id="${uid}-skin-finger" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#f2caa1"/>
      <stop offset="65%" stop-color="#d69c6d"/>
      <stop offset="100%" stop-color="#b2764a"/>
    </linearGradient>
    <linearGradient id="${uid}-skin-shadow" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#c98e60"/>
      <stop offset="100%" stop-color="#9c623b"/>
    </linearGradient>
    <linearGradient id="${uid}-cuff" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#2b2c32"/>
      <stop offset="100%" stop-color="#141519"/>
    </linearGradient>
    <clipPath id="${uid}-bar-clip">
      <rect class="prayer-bar-clip-rect" x="48" y="25" width="0" height="14" rx="2"/>
    </clipPath>
  </defs>
  <circle class="prayer-aura prayer-aura-jesus" cx="48" cy="48" r="46" fill="url(#${uid}-aura-jesus)"/>
  <circle class="prayer-aura prayer-aura-mary" cx="48" cy="48" r="46" fill="url(#${uid}-aura-mary)"/>
  <circle class="prayer-aura prayer-aura-george" cx="48" cy="48" r="46" fill="url(#${uid}-aura-george)"/>
  <circle class="prayer-ring-bg" cx="48" cy="48" r="${RING_R}" fill="rgba(14,29,22,0.78)" stroke="rgba(244,239,226,0.22)" stroke-width="2.8"/>
  <circle class="prayer-ring-fg" cx="48" cy="48" r="${RING_R}" fill="none" stroke-width="4" stroke-linecap="round"
    stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}" transform="rotate(-90 48 48)"/>
  <g clip-path="url(#${uid}-badge-clip)">
    <!-- Subtle luminous halo behind the cross -->
    <circle class="prayer-ready-halo" cx="48" cy="34" r="22" fill="rgba(255,224,128,0.24)"/>
    <!-- Back of open hand: slightly upturned palm & relaxed lower fingers cradling behind the cross -->
    <g class="prayer-hand-back" stroke="#6c4223" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round">
      <!-- Cassock sleeve + embroidered gold liturgical cuff emerging gently from lower-left -->
      <path d="M5 84 L24 67 C28.5 70.5 34.5 76.5 36.8 82.5 L20 96 L4 96 Z" fill="url(#${uid}-cuff)" stroke="#111216"/>
      <path d="M22.5 68.2 C27.2 71.5 33.2 77.2 35.6 83.2" fill="none" stroke="#e4bc55" stroke-width="2.6"/>
      <path d="M19.5 71.0 C24.2 74.4 29.8 79.8 32.3 85.4" fill="none" stroke="#b68a2c" stroke-width="1.2" opacity="0.85"/>
      <!-- Open upturned palm cradle supporting the base of the cross -->
      <path d="M24.8 68.4 C29.5 63.0 34.8 59.5 41.2 59.0 L53.5 59.6 C59.8 60.0 65.5 63.0 66.8 67.2 C68.0 71.2 63.8 77.6 55.2 80.6 C46.8 83.4 39.2 83.0 34.0 80.2 C30.6 76.0 27.6 72.0 24.8 68.4 Z" fill="url(#${uid}-skin-palm)"/>
      <!-- Soft hollow palm shadow where the lower shaft rests -->
      <path d="M35.5 66.5 C41.5 63.8 51.0 64.2 57.5 67.2 C54.5 72.4 45.8 75.5 38.2 73.2 C35.2 72.2 34.0 68.8 35.5 66.5 Z" fill="url(#${uid}-skin-shadow)" stroke="none" opacity="0.34"/>
      <!-- Gently curved, softly parted fingers cradling from the right side -->
      <path d="M57.6 60.4 C62.6 56.2 67.4 51.6 70.6 49.0 C72.6 47.4 75.0 49.0 73.6 51.6 C71.0 56.0 66.4 60.8 60.6 64.0" fill="url(#${uid}-skin-finger)"/>
      <path d="M60.8 64.2 C66.0 61.0 71.6 57.4 74.8 55.8 C77.0 54.7 78.6 57.0 76.6 59.4 C73.2 63.2 67.8 67.0 61.8 69.2" fill="url(#${uid}-skin-finger)"/>
      <path d="M60.6 69.2 C65.8 67.0 70.6 64.6 73.4 63.8 C75.5 63.2 76.6 65.6 74.4 67.6 C70.8 70.6 65.6 73.2 59.8 74.6" fill="url(#${uid}-skin-finger)"/>
      <path d="M57.5 74.4 C62.0 73.2 66.0 71.8 68.2 71.6 C70.1 71.5 70.7 73.7 68.6 75.2 C64.8 77.6 59.8 79.4 54.0 80.2" fill="url(#${uid}-skin-finger)"/>
    </g>
    <!-- Traditional Three-Bar Orthodox Cross resting tenderly in the open palm -->
    <g class="prayer-cross" stroke="#2f1c0c" stroke-width="1.2" stroke-linejoin="round">
      <!-- Vertical beam -->
      <rect x="44.4" y="11.5" width="7.2" height="60.5" rx="2.1" fill="url(#${uid}-cross-wood)"/>
      <!-- Subtle warm shaft gleam inside the vertical wood beam (beneath crossbars) -->
      <rect class="prayer-shaft-glow" x="46.4" y="13.5" width="3.2" height="54" rx="1.2" fill="#ffe694" stroke="none"/>
      <!-- Short top titulus bar -->
      <rect x="36.8" y="17.8" width="22.4" height="4.4" rx="1.4" fill="url(#${uid}-cross-wood)"/>
      <!-- Main horizontal crossbar (dark carved recess filled dynamically with warm gold light) -->
      <rect x="19" y="28.0" width="58" height="8.6" rx="2.5" fill="#412913"/>
      <g clip-path="url(#${uid}-bar-clip)">
        <rect x="19.8" y="28.8" width="56.4" height="7.0" rx="2.0" fill="url(#${uid}-gold-fill)" stroke="none"/>
        <rect x="21.2" y="29.9" width="53.6" height="2.2" rx="1.1" fill="#fffce4" opacity="0.82" stroke="none"/>
      </g>
      <!-- Slanted Orthodox lower footrest (suppedaneum: higher on viewer's left, lower on right) -->
      <polygon points="36.4,50.8 59.6,57.4 58.6,61.2 35.4,54.6" fill="url(#${uid}-cross-wood)"/>
    </g>
    <!-- Foreground thumb & inner palm edge gently resting over the lower shaft -->
    <g class="prayer-hand-front" stroke="#6c4223" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round">
      <!-- Thumb gently curved across the lower shaft in an affectionate embrace -->
      <path d="M26.6 67.2 C28.8 60.6 34.4 56.2 41.2 56.0 C45.4 55.9 49.4 58.0 50.0 60.8 C50.5 63.2 48.0 65.2 44.2 65.4 C39.4 65.6 35.2 67.8 32.4 71.2" fill="url(#${uid}-skin-palm)"/>
      <!-- Soft thumb highlight & palm contour -->
      <path d="M44.2 58.5 C46.8 58.6 48.2 59.8 48.2 61.3 C48.2 62.6 46.6 63.4 44.4 63.3" fill="none" stroke="#fce2c4" stroke-width="1.1" opacity="0.72"/>
      <!-- Soft palm lower rim cradling underneath the cross base -->
      <path d="M33.2 76.2 C39.4 80.2 49.2 80.6 56.6 77.6" fill="none" stroke="#99613b" stroke-width="1.2" opacity="0.55"/>
    </g>
  </g>
</svg>`;
}

export function prayerIdleCaption(deviceType, langPref = 'en', { narrow = false, browserLang } = {}) {
  if (!deviceType) return null;
  const nav = typeof browserLang === 'string' ? browserLang : (globalThis.navigator?.language || '');
  const lang = langPref === 'el' || langPref === 'en'
    ? langPref
    : (nav.toLowerCase().startsWith('el') ? 'el' : 'en');
  const title = lang === 'el'
    ? (narrow ? 'Προσευχή για ευλογία' : 'Προσευχήσου για να λάβεις ευλογία')
    : (narrow ? 'Pray for a blessing' : 'Pray to receive a blessing');
  let hint = '';
  if (deviceType === 'keyboard') hint = lang === 'el' ? 'κράτα R' : 'hold R';
  else if (deviceType === 'gamepad') hint = lang === 'el' ? 'κράτα δεξί μοχλό ◀ / ▲ / ▶' : 'hold right stick ◀ / ▲ / ▶';
  else if (deviceType === 'touch') hint = lang === 'el' ? 'κράτα Προσευχή' : 'hold Pray';
  return hint ? { title, hint } : null;
}

export function createPrayerHud(root, devices = []) {
  let layer = root.querySelector('#prayer-hud');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'prayer-hud';
    root.append(layer);
  }
  layer.innerHTML = '';

  // Jesus uses both prayer slots, so with one slot left the prompt leaves him out.
  const promptFor = (team, jesus = true) => {
    const dev = devices[team]?.type;
    if (dev === 'gamepad') return jesus ? '◀ Jesus · ▲ George · ▶ Mary' : '▲ George · ▶ Mary';
    if (dev === 'touch') return '';
    if (dev === 'keyboard') return jesus ? '1 Jesus · 2 Mary · 3 George' : '2 Mary · 3 George';
    return '';
  };

  const slots = [0, 1].map((team) => {
    const card = document.createElement('div');
    card.id = `prayer-${team}`;
    card.className = 'prayer-slot';
    card.dataset.team = String(team);
    card.dataset.state = 'idle';
    card.innerHTML = `
      <div class="prayer-badge" aria-live="polite">
        <div class="prayer-emblem">${buildHandCrossSvg(team)}<span class="prayer-timer" hidden></span></div>
        <div class="prayer-meta">
          <div class="prayer-beads" aria-label="Prayers remaining">
            <span class="prayer-bead" data-bead="0">✚</span>
            <span class="prayer-bead" data-bead="1">✚</span>
          </div>
          <div class="prayer-caption" hidden>
            <span class="prayer-caption-title"></span>
            <span class="prayer-caption-hint"></span>
          </div>
          <div class="prayer-status" hidden></div>
          <div class="prayer-wheel" hidden aria-hidden="true">
            <img class="pw-icon pw-george" src="assets/ui/icon_george.webp" alt="">
            <img class="pw-icon pw-jesus" src="assets/ui/icon_christ.webp" alt="">
            <span class="pw-stick">R</span>
            <img class="pw-icon pw-mary" src="assets/ui/icon_mary.webp" alt="">
          </div>
        </div>
      </div>
    `;
    layer.append(card);
    return {
      card,
      deviceType: devices[team]?.type ?? null,
      emblem: card.querySelector('.prayer-emblem'),
      clipRect: card.querySelector('.prayer-bar-clip-rect'),
      ringFg: card.querySelector('.prayer-ring-fg'),
      timer: card.querySelector('.prayer-timer'),
      beads: [...card.querySelectorAll('.prayer-bead')],
      caption: card.querySelector('.prayer-caption'),
      captionTitle: card.querySelector('.prayer-caption-title'),
      captionHint: card.querySelector('.prayer-caption-hint'),
      status: card.querySelector('.prayer-status'),
      wheel: card.querySelector('.prayer-wheel'),
      prompt: promptFor(team),
    };
  });

  function update(match, { hidden = false, lang = 'en' } = {}) {
    layer.hidden = hidden || !match?.prayersEnabled;
    if (layer.hidden) return;
    const hideAll = match.phase === 'over';
    layer.hidden = hideAll;
    if (hideAll) return;

    const narrow = typeof window !== 'undefined' && window.innerWidth <= 430;

    for (let t = 0; t < 2; t++) {
      const pr = match.prayers?.[t];
      const s = slots[t];
      if (!pr) continue;

      let state = 'idle';
      if (pr.active === 'jesus') state = 'jesus';
      else if (pr.active === 'mary') state = 'mary';
      else if (pr.active === 'george') state = 'george';
      else if (pr.ready) state = 'ready';
      else if (pr.charging || pr.charge > 0.005) state = 'charging';
      else if (pr.remaining <= 0) state = 'spent';

      s.card.dataset.state = state;
      s.card.dataset.remaining = String(pr.remaining);

      // Update remaining prayer beads/crosses.
      s.beads.forEach((b, i) => {
        b.classList.toggle('spent', i >= pr.remaining);
      });

      // Idle human caption: "Pray to receive a blessing" + device hint; hides in charging/ready/active/spent and on AI side.
      const cap = state === 'idle' && pr.remaining > 0 ? prayerIdleCaption(s.deviceType, lang, { narrow }) : null;
      if (cap) {
        if (s.captionTitle.textContent !== cap.title) s.captionTitle.textContent = cap.title;
        if (s.captionHint.textContent !== cap.hint) s.captionHint.textContent = cap.hint;
        s.caption.hidden = false;
      } else {
        s.caption.hidden = true;
      }

      // Gamepad players see which way to push the right stick for each blessing (Jesus dims when only one slot is left).
      const showWheel = s.deviceType === 'gamepad' && !pr.active && pr.remaining > 0;
      s.wheel.hidden = !showWheel;
      if (showWheel) {
        s.wheel.classList.toggle('no-jesus', pr.remaining < (PRAYER.cost?.jesus ?? 1));
        s.wheel.dataset.state = state;
      }

      // Fill crossbar horizontally with warm gold light (width 0..58 inside viewBox x=19..77).
      const fillRatio = pr.active ? 1 : pr.ready ? 1 : Math.max(0, Math.min(1, pr.charge));
      const barWidth = 58 * fillRatio;
      // Fill smoothly outward from the center of the cross for a luminous, balanced look.
      s.clipRect.setAttribute('x', (48 - barWidth / 2).toFixed(2));
      s.clipRect.setAttribute('width', barWidth.toFixed(2));

      // Countdown ring during active 15 s prayer.
      if (pr.active) {
        const frac = Math.max(0, Math.min(1, pr.timeLeft / PRAYER.duration));
        s.ringFg.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
        s.timer.textContent = `${Math.ceil(pr.timeLeft)}s`;
        s.timer.hidden = false;
        s.status.textContent = pr.active === 'jesus' ? 'Jesus' : pr.active === 'mary' ? 'Mary' : 'St George';
        s.status.hidden = false;
      } else if (pr.ready) {
        s.ringFg.setAttribute('stroke-dashoffset', '0');
        s.timer.hidden = true;
        const prompt = promptFor(t, pr.remaining >= (PRAYER.cost?.jesus ?? 1));
        s.status.textContent = prompt;
        s.status.hidden = !prompt;
      } else {
        s.ringFg.setAttribute('stroke-dashoffset', RING_C.toFixed(2));
        s.timer.hidden = true;
        s.status.textContent = state === 'charging' ? 'Keep holding to pray…' : '';
        s.status.hidden = state !== 'charging';
      }
    }
  }

  return { update };
}
