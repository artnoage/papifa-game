// On-screen panel for the gamepad tutorial: an Xbox-style pad diagram (every button, trigger, bumper,
// stick and D-pad addressable by data-pad) plus the step's title and caption. During the demo the pad
// shows exactly what the script sends; on the player's turn it mirrors the real controller.

// Standard Gamepad API button indices.
const BUTTON_KEYS = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'VIEW', 'START', 'LS', 'RS', 'DU', 'DD', 'DL', 'DR'];

const PAD_SVG = `
<svg class="tut-pad-svg" viewBox="0 0 220 150" role="img" aria-label="Controller">
  <rect data-pad="LT" class="pad-trigger" x="34" y="4" width="34" height="16" rx="6"/>
  <rect data-pad="RT" class="pad-trigger" x="152" y="4" width="34" height="16" rx="6"/>
  <text class="pad-label" x="51" y="16">LT</text><text class="pad-label" x="169" y="16">RT</text>
  <rect data-pad="LB" class="pad-bumper" x="28" y="24" width="48" height="11" rx="5"/>
  <rect data-pad="RB" class="pad-bumper" x="144" y="24" width="48" height="11" rx="5"/>
  <text class="pad-label pad-label-sm" x="52" y="32.5">LB</text><text class="pad-label pad-label-sm" x="168" y="32.5">RB</text>
  <path class="pad-body" d="M44 38 C70 30 150 30 176 38 C200 45 214 92 214 118 C214 140 196 146 184 140 C170 133 160 112 146 108 L74 108 C60 112 50 133 36 140 C24 146 6 140 6 118 C6 92 20 45 44 38 Z"/>
  <g data-pad="LS" class="pad-stick"><circle class="pad-stick-well" cx="58" cy="64" r="17"/><circle class="pad-stick-knob" cx="58" cy="64" r="11"/></g>
  <g data-pad="RS" class="pad-stick"><circle class="pad-stick-well" cx="138" cy="92" r="17"/><circle class="pad-stick-knob" cx="138" cy="92" r="11"/></g>
  <g class="pad-dpad">
    <rect data-pad="DU" x="76" y="74" width="12" height="13" rx="2"/>
    <rect data-pad="DD" x="76" y="97" width="12" height="13" rx="2"/>
    <rect data-pad="DL" x="63" y="86" width="13" height="12" rx="2"/>
    <rect data-pad="DR" x="88" y="86" width="13" height="12" rx="2"/>
  </g>
  <rect data-pad="VIEW" class="pad-small" x="92" y="54" width="14" height="9" rx="4.5"/>
  <rect data-pad="START" class="pad-small" x="114" y="54" width="14" height="9" rx="4.5"/>
  <g data-pad="Y" class="pad-face pad-y"><circle cx="164" cy="50" r="9"/><text x="164" y="54">Y</text></g>
  <g data-pad="X" class="pad-face pad-x"><circle cx="148" cy="66" r="9"/><text x="148" y="70">X</text></g>
  <g data-pad="B" class="pad-face pad-b"><circle cx="180" cy="66" r="9"/><text x="180" y="70">B</text></g>
  <g data-pad="A" class="pad-face pad-a"><circle cx="164" cy="82" r="9"/><text x="164" y="86">A</text></g>
</svg>`;

const PHASE_LABEL = { watch: 'Watch', try: 'Your turn', done: '✓ Nice!' };

export function createTutorialUi(root, { padIndex = 0 } = {}) {
  const panel = document.createElement('section');
  panel.id = 'tutorial-panel';
  panel.setAttribute('aria-live', 'polite');
  panel.innerHTML = `
    <div class="tut-pad">${PAD_SVG}</div>
    <div class="tut-text">
      <p class="tut-meta"><span class="tut-count"></span><span class="tut-phase"></span></p>
      <h2 class="tut-title"></h2>
      <p class="tut-caption"></p>
      <p class="tut-keys"><b>View</b> skip · <b>Start</b> pause</p>
    </div>
    <div class="tut-complete" hidden>
      <h2>Tutorial complete</h2>
      <p>You know every move. Now go and win one for the monastery.</p>
      <button type="button" class="tut-menu">Back to the menu</button>
      <p class="tut-keys">or press <b>A</b></p>
    </div>`;
  root.append(panel);
  const q = sel => panel.querySelector(sel);
  const parts = new Map([...panel.querySelectorAll('[data-pad]')].map(el => [el.dataset.pad, el]));
  const knobs = { LS: parts.get('LS').querySelector('.pad-stick-knob'), RS: parts.get('RS').querySelector('.pad-stick-knob') };
  let prev = [], shown = '';

  function readPad() {
    const pad = navigator.getGamepads?.()[padIndex];
    if (!pad) return null;
    const press = new Set();
    BUTTON_KEYS.forEach((k, i) => { const b = pad.buttons?.[i]; if (b?.pressed || (b?.value ?? 0) > 0.5) press.add(k); });
    const [ax = 0, az = 0, rx = 0, rz = 0] = pad.axes ?? [];
    return { press, ls: [ax, az], rs: [rx, rz] };
  }

  function drawPad(state, targets) {
    for (const [k, el] of parts) {
      el.classList.toggle('on', !!state?.press.has(k));
      el.classList.toggle('target', targets.includes(k));
    }
    for (const k of ['LS', 'RS']) {
      const [x, z] = (k === 'LS' ? state?.ls : state?.rs) ?? [0, 0];
      const L = Math.hypot(x, z), s = L > 1 ? 1 / L : 1;
      knobs[k].setAttribute('transform', `translate(${(x * s * 7).toFixed(2)} ${(z * s * 7).toFixed(2)})`);
      if (Math.hypot(x, z) > 0.3) parts.get(k).classList.add('on');
    }
  }

  return {
    // Edges on the real pad that the tutorial itself handles: View (skip / quit) and A (finish).
    pollButtons() {
      const pad = navigator.getGamepads?.()[padIndex];
      const now = BUTTON_KEYS.map((_, i) => !!(pad?.buttons?.[i]?.pressed || (pad?.buttons?.[i]?.value ?? 0) > 0.5));
      const edge = i => now[i] && !prev[i];
      const out = { view: edge(8), a: edge(0) };
      prev = now;
      return out;
    },
    update(state, demoPad) {
      const { index, phase, step, total } = state;
      panel.dataset.phase = phase;
      const complete = phase === 'complete';
      q('.tut-complete').hidden = !complete;
      q('.tut-text').hidden = complete;
      q('.tut-pad').hidden = complete;
      if (complete) return;
      const key = `${index}:${phase}`;
      if (key !== shown) {
        shown = key;
        q('.tut-count').textContent = `${index + 1} / ${total}`;
        q('.tut-phase').textContent = PHASE_LABEL[phase] ?? '';
        q('.tut-title').textContent = step.title;
        q('.tut-caption').textContent = step.caption;
      }
      drawPad(phase === 'watch' ? demoPad : readPad(), phase === 'done' ? [] : step.keys);
    },
    onMenu(fn) { q('.tut-menu').addEventListener('click', fn); },
    destroy() { panel.remove(); },
  };
}
