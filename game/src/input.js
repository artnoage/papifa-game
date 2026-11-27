import { createButtonGestures } from './gestures.js';
import { createMouseControls } from './mouse-controls.js';

const RB_PRESS_REPEAT_MS = 750;
// Right stick = prayer wheel: a firm push (past PRAYER_STICK_MIN) within PRAYER_STICK_CONE of left / right / up
// holds that prayer (charge, then it fires when the cross is full). Diagonals and light brushes do nothing.
const PRAYER_STICK_MIN = 0.7;
const PRAYER_STICK_CONE = Math.PI / 6;
// LT = autopilot: the priest runs by himself (predicted path) for at most this long per press while the left stick aims.
export const AUTOPILOT_MS = 2000;

// Produces a per-frame input object in world space (x along the pitch, z toward the camera).
export function createInput(device = { type: 'keyboard' }, { touch, pitchTarget, liveMatch, team = 0 } = {}) {
  const keyboard = device.type === 'keyboard';
  const touchControls = device.type === 'touch' ? touch : null;
  const readPad = () => device.type === 'gamepad' ? navigator.getGamepads?.()[device.index] : null;
  const btn = (pad, i) => Boolean(pad?.buttons?.[i]?.pressed || (pad?.buttons?.[i]?.value ?? 0) > 0.5);
  const padInUse = pad => pad && (pad.buttons.some((b) => b?.pressed || (b?.value ?? 0) > 0.5) || pad.axes.some((a) => Math.abs(a) > 0.2));
  let padPrev = [], skipPad = !!padInUse(readPad()), connected = !!readPad();
  const down = new Set(), pressed = new Set(), released = new Set();
  const input = { move: { x: 0, z: 0 }, aim: null };
  const emit = (edge) => { input[edge] = true; };
  const mouse = keyboard && pitchTarget ? createMouseControls(pitchTarget, liveMatch, emit, team) : null;
  const keyboardGestures = createButtonGestures(emit), padGestures = createButtonGestures(emit);
  const sprintKeys = ['ShiftLeft', 'ShiftRight'];
  const held = (keys) => keys.some((code) => down.has(code));

  let keyboardChipActive = false;
  let keyboardQAttacking = false;
  let padChipActive = false;
  let padLbUsed = false;
  let padRbNextPressAt = Infinity;
  let padLtDownAt = -Infinity;

  function activeMatchHuman() {
    const m = liveMatch?.();
    if (!m) return null;
    const h = m.humans ? m.humans[team] : m.human;
    return h ? { m, h } : null;
  }

  function hasBall() {
    const cur = activeMatchHuman();
    if (!cur) return null; // unknown when liveMatch is not wired (e.g. unit tests)
    return cur.m.ball?.owner === cur.h;
  }

  // An action can arrive on a display frame between two simulation ticks.
  function clearActions() {
    input.passPressed = false;
    input.shootPressed = false;
    input.shootReleased = false;
    input.switchPressed = false;
    input.switchToAim = false;
    input.throughPressed = false;
    input.oneTwoPressed = false;
    input.chipReleased = false;
    input.knockOnPressed = false;
    input.pressPressed = false;
    input.prayerJesus = false;
    input.prayerMary = false;
    input.prayerGeorge = false;
    input.prayerPhanourios = false;
  }
  clearActions();

  if (keyboard) addEventListener('keydown', (e) => {
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    if (e.repeat || down.has(e.code)) return;
    if (e.code === 'Digit1' || e.code === 'Numpad1') input.prayerJesus = true;
    if (e.code === 'Digit2' || e.code === 'Numpad2') input.prayerMary = true;
    if (e.code === 'Digit3' || e.code === 'Numpad3') input.prayerGeorge = true;
    if (e.code === 'Digit4' || e.code === 'Numpad4') input.prayerPhanourios = true;
    if (sprintKeys.includes(e.code) && !held(sprintKeys)) keyboardGestures.sprintTap();
    if (e.code === 'Space') {
      input.passPressed = true;
    } else if (e.code === 'KeyE') {
      input.throughPressed = true;
    } else if (e.code === 'KeyQ') {
      const own = hasBall();
      if (own === true) {
        keyboardQAttacking = true;
        input.oneTwoPressed = true;
      } else if (own === false) {
        keyboardQAttacking = false;
        keyboardGestures.beginSwitch();
      } else {
        // Without liveMatch (headless unit tests), oneTwoPressed acts only with the ball while Q tap/hold switches/presses off it.
        keyboardQAttacking = false;
        input.oneTwoPressed = true;
        keyboardGestures.beginSwitch();
      }
    } else if (e.code === 'KeyC') {
      const own = hasBall();
      if (own !== false) {
        keyboardChipActive = true;
        input.shootPressed = true;
      }
    }
    pressed.add(e.code);
    down.add(e.code);
  });

  if (keyboard) addEventListener('keyup', (e) => {
    if (!down.has(e.code)) return;
    down.delete(e.code);
    released.add(e.code);
    if (e.code === 'KeyQ') {
      if (!keyboardQAttacking) keyboardGestures.endSwitch();
      keyboardQAttacking = false;
    } else if (e.code === 'KeyC') {
      if (keyboardChipActive) {
        if (hasBall() !== false) input.chipReleased = true;
        keyboardChipActive = false;
      }
    }
  });

  function reset() {
    down.clear(); pressed.clear(); released.clear();
    mouse?.reset();
    input.aim = null;
    input.prayerHeld = false;
    input.autoRun = false;
    keyboardGestures.reset(); padGestures.reset();
    keyboardChipActive = false;
    keyboardQAttacking = false;
    padChipActive = false;
    padLbUsed = false;
    padRbNextPressAt = Infinity;
    padLtDownAt = -Infinity;
    touchControls?.reset();
    padPrev = [];
    skipPad = !!padInUse(readPad());
    clearActions();
  }
  addEventListener('blur', reset);
  addEventListener('pagehide', reset);
  globalThis.document?.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });

  function ownedPad() {
    const pad = readPad();
    if (!pad || pad.connected === false) {
      if (connected) reset();
      connected = false;
      return null;
    }
    if (!connected) skipPad = !!padInUse(pad);
    connected = true;
    if (skipPad) skipPad = !!padInUse(pad);
    return skipPad ? null : pad;
  }

  function poll() {
    const k = (...codes) => codes.some((c) => down.has(c));
    const p = (...codes) => codes.some((c) => pressed.has(c));
    const r = (...codes) => codes.some((c) => released.has(c));
    const move = input.move;
    move.x = Number(k('KeyD', 'ArrowRight')) - Number(k('KeyA', 'ArrowLeft'));
    move.z = Number(k('KeyS', 'ArrowDown')) - Number(k('KeyW', 'ArrowUp'));
    input.sprint = held(sprintKeys);
    input.shootHeld = down.has('KeyF') || (keyboardChipActive && down.has('KeyC'));
    input.pausePressed = p('KeyP', 'Escape');
    input.menuStep = 0;
    input.menuConfirm = false;
    input.shootPressed ||= p('KeyF');
    input.shootReleased ||= r('KeyF');
    let prayerHeld = down.has('KeyR');
    keyboardGestures.poll();

    let autoRun = false;
    // Standard Xbox-style controller layout:
    // Left stick move (aims while LT autopilot runs), Right stick prayer wheel (hold left Jesus / right Mary /
    // up St George / down St Phanourios), LT hold autopilot run (up to 2 s), RT sprint / double-tap knock-on, A pass/standing tackle,
    // Y through ball, LB+A one-two, B shoot (far tap knock-on, keeper punt), LB+B chip,
    // X slide tackle (defending; RT+A also slides), tap LB switch priest, hold RB teammate press, Start pause.
    const pad = ownedPad();
    if (pad) {
      const [ax = 0, az = 0, rx = 0, rz = 0] = pad.axes;
      if (Math.hypot(ax, az) > 0.2) { move.x = ax; move.z = az; }

      const rLen = Math.hypot(rx, rz);
      if (rLen > PRAYER_STICK_MIN) {
        const near = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) <= PRAYER_STICK_CONE;
        const ang = Math.atan2(rz, rx);
        const slot = near(ang, Math.PI) ? 'prayerJesus' : near(ang, 0) ? 'prayerMary' : near(ang, -Math.PI / 2) ? 'prayerGeorge'
          : near(ang, Math.PI / 2) ? 'prayerPhanourios' : null;
        if (slot) { prayerHeld = true; input[slot] = true; }
      }

      const b = (i) => btn(pad, i);
      const edge = (i) => b(i) && !padPrev[i];
      const fall = (i) => !b(i) && Boolean(padPrev[i]);

      // RT (7): sprint + double-tap knock-on (RB no longer sprints).
      const sprint = b(7);
      if (edge(7)) padGestures.sprintTap();
      input.sprint ||= sprint;

      // LB (4): modifier for LB+A (one-two) and LB+B (chip), or tap LB to switch priest when defending.
      if (edge(4)) padLbUsed = false;
      const lbHeld = b(4);

      // A (0): pass / standing tackle (RT+A slides), or LB+A one-two.
      if (edge(0)) {
        if (lbHeld) {
          padLbUsed = true;
          input.oneTwoPressed = true;
        } else {
          input.passPressed = true;
        }
      }

      // Y (3): through ball.
      if (edge(3)) input.throughPressed = true;

      // B (1): shoot (sprinting no longer turns B into a chip); LB+B chips.
      if (b(1) && lbHeld) {
        padLbUsed = true;
        padChipActive = true;
      }
      if (edge(1)) input.shootPressed = true;
      input.shootHeld ||= b(1);
      if (fall(1)) {
        if (padChipActive || lbHeld) {
          if (hasBall() !== false) input.chipReleased = true;
          padChipActive = false;
          if (lbHeld) padLbUsed = true;
        } else {
          input.shootReleased = true;
        }
      }

      // X (2): dedicated slide tackle while defending.
      if (edge(2) && !b(1) && hasBall() !== true) {
        input.chipReleased = true;
      }

      // LB release: if LB wasn't used as a chord with A or B, switch priest (pointing with right stick if active).
      if (fall(4)) {
        if (!padLbUsed) {
          input.switchPressed = true;
        }
        padLbUsed = false;
      }

      // RB (5): hold for teammate press.
      const nowMs = performance.now();
      if (edge(5)) {
        input.pressPressed = true;
        padRbNextPressAt = nowMs + RB_PRESS_REPEAT_MS;
      } else if (b(5) && nowMs >= padRbNextPressAt) {
        input.pressPressed = true;
        padRbNextPressAt = nowMs + RB_PRESS_REPEAT_MS;
      } else if (!b(5)) {
        padRbNextPressAt = Infinity;
      }

      // LT (6): autopilot while held, for at most AUTOPILOT_MS per press.
      if (edge(6)) padLtDownAt = performance.now();
      autoRun = b(6) && performance.now() - padLtDownAt < AUTOPILOT_MS;

      // Pause & pause-menu navigation (D-pad Left/Right + A).
      input.pausePressed ||= edge(9);
      input.menuStep = Number(edge(15)) - Number(edge(14));
      input.menuConfirm = edge(0);

      padPrev = pad.buttons.map((_, i) => btn(pad, i));
    }

    input.prayerHeld = prayerHeld;
    input.autoRun = autoRun;
    input.aim = mouse?.point() ?? null;
    input.shootHeld ||= !!mouse?.shooting;
    touchControls?.poll(input);
    pressed.clear(); released.clear();
    return input;
  }

  return { poll, clearActions, reset, padActive: () => !!padInUse(ownedPad()) };
}
