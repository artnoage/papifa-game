// Prayer controls unit test (Task E):
// Keyboard R hold (instant, zero 300 ms delay) + Digit1/2 & Numpad1/2, Space instant pass on keydown (no pray),
// Gamepad right-stick prayer wheel (left Jesus, right Mary, up St George), and end-to-end sim charge -> ready -> choose.
import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';
import { createMatch, step } from '../src/sim.js';

const dt = 1 / 60;

// 1. Keyboard: Space fires passPressed immediately on keydown (never prays); R holds prayer immediately without passing.
{
  const events = new EventTarget();
  let now = 1000;
  globalThis.addEventListener = events.addEventListener.bind(events);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [] }, configurable: true });
  const kb = createInput({ type: 'keyboard' });
  const key = (code, type = 'keydown') => events.dispatchEvent(Object.assign(new Event(type), { code }));

  // Space fires passPressed immediately on keydown and never sets prayerHeld even if held.
  key('Space', 'keydown');
  let inp = kb.poll();
  assert.equal(inp.passPressed, true, 'Space fires passPressed immediately on keydown');
  assert.equal(inp.prayerHeld, false);
  kb.clearActions();
  now += 500;
  inp = kb.poll();
  assert.equal(inp.prayerHeld, false, 'holding Space never charges prayer');
  key('Space', 'keyup'); kb.poll(); kb.clearActions();

  // Hold R -> prayerHeld activates immediately, releasing does NOT fire passPressed.
  const m = createMatch(42);
  key('KeyR', 'keydown');
  for (let i = 0; i < 125; i++) {
    now += 16.7;
    inp = kb.poll();
    assert.equal(inp.prayerHeld, true, 'holding R holds prayer immediately');
    assert.equal(inp.passPressed, false);
    step(m, inp, dt);
    kb.clearActions();
  }
  assert.equal(m.prayers[0].ready, true, 'holding R charges prayer to ready');
  key('KeyR', 'keyup');
  inp = kb.poll();
  assert.equal(inp.prayerHeld, false);
  assert.equal(inp.passPressed, false, 'releasing R does not pass/tackle');
  kb.clearActions();

  // Top-row Digit1 chooses Jesus.
  key('Digit1', 'keydown');
  inp = kb.poll();
  assert.equal(inp.prayerJesus, true);
  step(m, inp, dt);
  kb.clearActions();
  key('Digit1', 'keyup'); kb.poll();
  assert.equal(m.prayers[0].active, 'jesus');
  assert.equal(m.prayers[0].remaining, 0, 'Jesus uses both prayer slots');

  // Numpad2 chooses Mary once charged again (give the slot back for the test).
  m.prayers[0].active = null; m.prayers[0].timeLeft = 0; m.prayers[0].ready = true; m.prayers[0].remaining = 1;
  key('Numpad2', 'keydown');
  inp = kb.poll();
  assert.equal(inp.prayerMary, true);
  step(m, inp, dt);
  kb.clearActions();
  key('Numpad2', 'keyup'); kb.poll();
  assert.equal(m.prayers[0].active, 'mary');
  assert.equal(m.prayers[0].remaining, 0);

  // Numpad1, Digit2, Digit3/Numpad3 and Digit4/Numpad4 also emit prayerJesus / prayerMary / prayerGeorge / prayerPhanourios.
  key('Numpad1', 'keydown'); assert.equal(kb.poll().prayerJesus, true); kb.clearActions(); key('Numpad1', 'keyup');
  key('Digit2', 'keydown'); assert.equal(kb.poll().prayerMary, true); kb.clearActions(); key('Digit2', 'keyup');
  key('Digit3', 'keydown'); assert.equal(kb.poll().prayerGeorge, true); kb.clearActions(); key('Digit3', 'keyup');
  key('Numpad3', 'keydown'); assert.equal(kb.poll().prayerGeorge, true); kb.clearActions(); key('Numpad3', 'keyup');
  key('Digit4', 'keydown'); assert.equal(kb.poll().prayerPhanourios, true); kb.clearActions(); key('Digit4', 'keyup');
  key('Numpad4', 'keydown'); assert.equal(kb.poll().prayerPhanourios, true); kb.clearActions(); key('Numpad4', 'keyup');
}

// 2. Gamepad prayer wheel on the right stick: hold left = Jesus, right = Mary, up = St George, down = St Phanourios.
// The hold charges the cross; when it is full the held prayer fires. Light pushes, diagonals, LT and LB never pray.
{
  const events = new EventTarget();
  globalThis.addEventListener = events.addEventListener.bind(events);
  const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true });
  const gp = createInput({ type: 'gamepad', index: 0 });
  const m = createMatch(43);

  for (const b of [4, 6]) {
    pad.buttons[b].pressed = true;
    assert.equal(gp.poll().prayerHeld, false, `button ${b} does not pray`);
    pad.buttons[b].pressed = false;
    gp.poll(); gp.clearActions();
  }
  pad.axes = [0, 0, -0.5, 0];
  assert.equal(gp.poll().prayerHeld, false, 'a light push does not pray');
  pad.axes = [0, 0, -0.75, -0.75];
  let inp = gp.poll();
  assert.equal(inp.prayerHeld || inp.prayerJesus || inp.prayerMary || inp.prayerGeorge, false, 'a diagonal does not pray');
  gp.clearActions();

  pad.axes = [0, 0, -1, 0];
  for (let i = 0; i < 125 && !m.prayers[0].active; i++) {
    inp = gp.poll();
    assert.equal(inp.prayerHeld, true, 'right stick left charges');
    assert.equal(inp.prayerJesus, true, 'right stick left holds Jesus');
    step(m, inp, dt);
    gp.clearActions();
  }
  assert.equal(m.prayers[0].active, 'jesus', 'holding right stick left fires Jesus once the cross is full');
  pad.axes = [0, 0, 0, 0]; gp.poll(); gp.clearActions();

  m.prayers[0].active = null; m.prayers[0].timeLeft = 0; m.prayers[0].ready = true; m.prayers[0].remaining = 1;
  pad.axes = [0, 0, 1, 0];
  inp = gp.poll();
  assert.equal(inp.prayerMary, true, 'right stick right sets prayerMary');
  step(m, inp, dt);
  gp.clearActions();
  assert.equal(m.prayers[0].active, 'mary');

  // Right stick up fires St George end-to-end when ready.
  m.prayers[0].active = null; m.prayers[0].timeLeft = 0; m.prayers[0].remaining = 1; m.prayers[0].ready = true;
  pad.axes = [0, 0, 0, -1];
  inp = gp.poll();
  assert.equal(inp.prayerGeorge, true, 'right stick up sets prayerGeorge');
  assert.equal(inp.prayerHeld, true);
  step(m, inp, dt);
  gp.clearActions();
  assert.equal(m.prayers[0].active, 'george', 'right stick up activates St George');
  assert.ok(m.prayers[0].riderSlot >= 0, 'St George assigns riderSlot');
  // Right stick down fires St Phanourios end-to-end when ready.
  pad.axes = [0, 0, 0, 0]; gp.poll(); gp.clearActions();
  m.prayers[0].active = null; m.prayers[0].timeLeft = 0; m.prayers[0].riderSlot = -1; m.prayers[0].remaining = 1; m.prayers[0].ready = true;
  pad.axes = [0, 0, 0, 1];
  inp = gp.poll();
  assert.equal(inp.prayerPhanourios, true, 'right stick down sets prayerPhanourios');
  assert.equal(inp.prayerHeld, true);
  assert.equal(inp.prayerJesus || inp.prayerMary || inp.prayerGeorge, false);
  step(m, inp, dt);
  gp.clearActions();
  assert.equal(m.prayers[0].active, 'phanourios', 'right stick down activates St Phanourios');
  assert.equal(m.prayers[0].remaining, 0);
}

console.log('Prayer keyboard and gamepad controls tests passed.');
