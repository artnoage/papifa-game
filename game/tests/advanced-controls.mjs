import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';
import { packInput, unpackInput } from '../src/net-state.js';
import { createMatch, step } from '../src/sim.js';

const dt = 1 / 60;

function makeRig(device, { matchRef = null, team = 0 } = {}) {
  const events = new EventTarget();
  const pad = { connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) };
  let now = 1000;
  globalThis.addEventListener = events.addEventListener.bind(events);
  Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => device === 'pad' ? [pad] : [] }, configurable: true,
  });
  const ctrl = createInput(
    device === 'pad' ? { type: 'gamepad', index: 0 } : { type: 'keyboard' },
    matchRef ? { liveMatch: () => matchRef.current, team } : {},
  );
  const key = (code, down) => events.dispatchEvent(Object.assign(new Event(down ? 'keydown' : 'keyup'), { code }));
  const btn = (i, down) => { pad.buttons[i].pressed = down; pad.buttons[i].value = down ? 1 : 0; };
  return {
    pad,
    key,
    btn,
    clear: ctrl.clearActions,
    blur: () => events.dispatchEvent(new Event('blur')),
    poll(ms = 0) { now += ms; return ctrl.poll(); },
  };
}

function act(input) {
  const m = createMatch(1), passer = m.human;
  m.players.find(p => p.team === 0 && p.slot === 2).pos = { x: 7, z: -3 };
  step(m, input, dt);
  return { m, passer, events: m.events.filter(e => e.human) };
}

for (const device of ['keyboard', 'pad']) {
  const matchRef = { current: null };
  const c = makeRig(device, { matchRef });
  const setAttacking = () => {
    const m = createMatch(1);
    m.ball.owner = m.human;
    matchRef.current = m;
    return m;
  };
  const setDefending = (seed = 8) => {
    const m = createMatch(seed);
    m.ball.owner = m.players.find(p => p.team === 1 && !p.isGK);
    matchRef.current = m;
    return m;
  };

  // 1. Through ball: E (keyboard) / Y (pad, button 3).
  setAttacking();
  if (device === 'keyboard') { c.key('KeyE', true); } else { c.btn(3, true); }
  let input = c.poll(5);
  assert.ok(input.throughPressed && !input.passPressed);
  const throughBall = act(input);
  assert.deepEqual(throughBall.events.map(e => e.kind), ['through']);
  assert.ok(throughBall.m.ball.receiver && throughBall.m.ball.vel.x > 0);
  assert.equal(throughBall.m.human, throughBall.m.ball.receiver);
  c.clear();
  if (device === 'keyboard') { c.key('KeyE', false); } else { c.btn(3, false); }
  assert.ok(!c.poll(5).throughPressed);

  // 2. Chip shot: C (keyboard) / LB + B (pad, buttons 4 + 1).
  setAttacking();
  c.poll(400);
  if (device === 'keyboard') {
    c.key('KeyC', true); c.poll(10); c.key('KeyC', false);
  } else {
    c.btn(4, true); c.btn(1, true); c.poll(10);
    c.btn(4, false); c.poll(5); // releasing LB before B still chips and never switches
    c.btn(1, false);
  }
  input = c.poll(6);
  assert.ok(input.shootPressed && input.chipReleased && !input.switchPressed);
  const lob = act(input);
  assert.deepEqual(lob.events.map(e => e.kind), ['chip']);
  for (let i = 0; i < 15; i++) step(lob.m, { move: { x: 0, z: 0 } }, dt);
  assert.ok(lob.m.ball.pos.y > 2.5, 'chip rises over head height');
  c.clear();

  // Losing possession before releasing C / LB+B must not trigger a defending slide.
  setAttacking();
  if (device === 'keyboard') { c.key('KeyC', true); c.poll(10); setDefending(); c.key('KeyC', false); }
  else { c.btn(4, true); c.btn(1, true); c.poll(10); setDefending(); c.btn(1, false); c.btn(4, false); }
  assert.equal(c.poll(6).chipReleased, false, `${device}: releasing chip after losing possession must not slide`);
  c.clear();

  // 3. Sprinting NO LONGER turns a shot into a chip (Shift+F / RT+B = normal shot!).
  setAttacking();
  c.poll(400);
  if (device === 'keyboard') {
    c.key('ShiftLeft', true); c.key('KeyF', true); c.poll(220);
    c.key('KeyF', false); c.key('ShiftLeft', false);
  } else {
    c.btn(7, true); c.btn(1, true); c.poll(220);
    c.btn(1, false); c.btn(7, false);
  }
  input = c.poll(6);
  assert.ok(input.shootPressed && input.shootReleased && !input.chipReleased, `${device}: sprint+shoot must NOT chip`);
  {
    const m = createMatch(2);
    m.human.pos = { x: 20, z: 0 }; m.ball.pos = { x: 20.75, y: 0.3, z: 0 };
    step(m, input, dt);
    assert.deepEqual(m.events.filter(e => e.human).map(e => e.kind), ['shot']);
  }
  c.clear();

  // 4. One-two: Q with the ball (keyboard) / LB + A (pad, buttons 4 + 0).
  setAttacking();
  c.poll(400);
  if (device === 'keyboard') {
    c.key('KeyQ', true); input = c.poll();
  } else {
    c.btn(4, true); c.poll(4); c.btn(0, true); input = c.poll(4);
  }
  assert.ok(input.oneTwoPressed);
  const giveAndGo = act(input);
  assert.equal(giveAndGo.events[0].kind, 'onetwo');
  assert.ok(giveAndGo.passer.oneTwoT > giveAndGo.m.t);
  const receiver = giveAndGo.m.ball.receiver, startX = giveAndGo.passer.pos.x;
  for (let i = 0; i < 90 && !giveAndGo.m.ball.owner; i++) step(giveAndGo.m, { move: { x: 0, z: 0 } }, dt);
  assert.equal(giveAndGo.m.ball.owner, receiver);
  assert.ok(giveAndGo.passer.pos.x > startX, 'passer runs forward after first touch');
  const towardsRunner = { x: giveAndGo.passer.pos.x - receiver.pos.x, z: giveAndGo.passer.pos.z - receiver.pos.z };
  step(giveAndGo.m, { passPressed: true, move: towardsRunner }, dt);
  assert.equal(giveAndGo.m.ball.receiver, giveAndGo.passer, 'return pass finds original runner');
  assert.equal(giveAndGo.m.human, giveAndGo.passer);
  c.clear();
  // Even if possession left our feet before release, releasing Q / LB must NOT switch!
  setDefending();
  if (device === 'keyboard') { c.key('KeyQ', false); } else { c.btn(0, false); c.btn(4, false); }
  assert.ok(!c.poll(5).switchPressed, `${device}: releasing one-two button must not switch`);
  c.clear();

  // 5. Knock-on: double-tap Shift (keyboard) / double-tap RT (pad, button 7).
  setAttacking();
  c.poll(400);
  const sprintBtn = (down) => device === 'keyboard' ? c.key('ShiftLeft', down) : c.btn(7, down);
  sprintBtn(true); c.poll(); sprintBtn(true); c.poll(50);
  assert.ok(!c.poll(0).knockOnPressed, 'holding Sprint is one press');
  sprintBtn(false); c.poll(30); sprintBtn(true);
  input = c.poll(40);
  assert.ok(input.knockOnPressed);
  const knock = act(input);
  assert.equal(knock.events[0].type, 'knock');
  assert.equal(knock.m.ball.owner, null);
  assert.equal(knock.m.ball.receiver, knock.passer);
  assert.ok(knock.passer.burstT > 0 && knock.m.ball.vel.x > 0);
  c.clear(); sprintBtn(false); c.poll(400);
  sprintBtn(true); assert.ok(!c.poll().knockOnPressed, 'a late tap starts a new pair');
  sprintBtn(false); c.poll(); c.clear();

  // 6. Defending: switch priest + teammate press + slide tackle.
  const defence = setDefending(8), defender = defence.human;
  if (device === 'keyboard') {
    // Keyboard: hold Q (>= 300 ms) calls press; tap Q switches priest.
    c.key('KeyQ', true); c.poll(); c.clear();
    assert.ok(!c.poll(299).switchPressed && !c.poll(0).pressPressed);
    input = c.poll(1);
    assert.ok(input.pressPressed && !input.switchPressed && !input.oneTwoPressed);
    step(defence, input, dt);
    assert.ok(defence.pressT[0] > defence.t && defence.human === defender);
    c.clear();
    assert.ok(!c.poll(300).pressPressed, 'held Q calls pressure once');
    c.key('KeyQ', false); assert.ok(!c.poll().switchPressed);
    c.key('KeyQ', true); c.poll(); c.key('KeyQ', false);
    step(defence, c.poll(10), dt);
    assert.notEqual(defence.human, defender, 'tap Q switches priest');
    c.clear();
    c.key('KeyQ', true); c.poll(); c.blur(); c.key('KeyQ', false);
    assert.ok(!c.poll(400).pressPressed && !c.poll(0).switchPressed);
    // Removed duplicates J, K, L do nothing.
    for (const dead of ['KeyJ', 'KeyK', 'KeyL']) {
      c.key(dead, true);
      const dIn = c.poll(10);
      assert.ok(!dIn.passPressed && !dIn.shootPressed && !dIn.shootHeld && !dIn.switchPressed, `${dead} removed`);
      c.key(dead, false); c.poll(10); c.clear();
    }
  } else {
    // Pad: RB (button 5) calls teammate press and NO LONGER sprints!
    c.btn(5, true);
    input = c.poll(10);
    assert.equal(input.sprint, false, 'RB must no longer sprint');
    assert.equal(input.pressPressed, true, 'RB calls teammate press');
    step(defence, input, dt);
    assert.ok(defence.pressT[0] > defence.t && defence.human === defender);
    c.btn(5, false); c.poll(10); c.clear();

    // Pad: tap LB (button 4) switches priest.
    c.btn(4, true); c.poll(10); c.btn(4, false);
    input = c.poll(10);
    assert.equal(input.switchPressed, true, 'tap LB switches priest');
    step(defence, input, dt);
    assert.notEqual(defence.human, defender);
    c.clear();

    // Pad: X (button 2) does nothing while attacking, and triggers dedicated slide tackle while defending (even without RT).
    setAttacking();
    c.btn(2, true);
    assert.equal(c.poll(10).chipReleased, false, 'pad X while attacking must not chip/slide');
    c.btn(2, false); c.poll(10); c.clear();

    const slideM = setDefending(9);
    const rival = slideM.ball.owner;
    rival.pos = { x: 4, z: 0 };
    slideM.human.pos = { x: 2.8, z: 0 }; slideM.human.vel = { x: 0, z: 0 }; slideM.human.facing = 0;
    c.btn(2, true);
    input = c.poll(10);
    assert.equal(input.sprint, false);
    step(slideM, input, dt);
    assert.equal(slideM.events.some(e => e.type === 'tackle' && e.kind === 'slide'), true, 'pad X defending slides without RT');
    c.btn(2, false); c.poll(10); c.clear();
  }
}

// 7. LT autopilot on gamepad: while LT is held (at most 2 s per press) the priest runs by himself and the
// left stick only aims; the right stick no longer aims. autoRun survives the online packInput/unpackInput.
{
  const matchRef = { current: null };
  const c = makeRig('pad', { matchRef });
  const m = createMatch(50);
  matchRef.current = m;
  const h = m.human;
  h.pos = { x: 2, z: -1 }; h.vel = { x: 0, z: 0 };
  m.ball.owner = h; m.ball.pos = { x: 2.75, y: 0.3, z: -1 };

  // Right stick pushed: no aim point any more (it is the prayer wheel now).
  c.pad.axes = [0, 0, 1, 0];
  let inp = c.poll(16);
  assert.equal(inp.aim, null, 'right stick no longer aims');
  c.pad.axes = [0, 0, 0, 0]; c.poll(16); c.clear();

  // Hold LT with the left stick pushed south (+z): autoRun, and the priest does not simply run south.
  c.btn(6, true);
  c.pad.axes = [0, 1, 0, 0];
  inp = c.poll(16);
  assert.equal(inp.autoRun, true, 'LT sets autoRun');
  const unpacked = unpackInput(packInput(inp));
  assert.equal(unpacked.autoRun, true, 'autoRun survives online packInput/unpackInput');
  for (let i = 0; i < 30; i++) { step(m, inp, dt); c.clear(); inp = c.poll(16); }
  assert.ok(h.vel.x > 1.5, `autopilot dribbles toward the attacking goal, not along the stick (vel=${h.vel.x.toFixed(2)},${h.vel.z.toFixed(2)})`);

  // Pass (A) under autopilot goes where the left stick aims (south), not north.
  const north = m.players.find(p => p.team === 0 && p.slot === 2);
  const south = m.players.find(p => p.team === 0 && p.slot === 3);
  north.pos = { x: h.pos.x + 4, z: h.pos.z - 12 }; south.pos = { x: h.pos.x + 4, z: h.pos.z + 12 };
  c.btn(0, true);
  inp = c.poll(16);
  step(m, inp, dt);
  assert.equal(m.ball.receiver, south, 'autopilot pass follows the left-stick aim');
  c.btn(0, false); c.poll(16); c.clear();

  // The autopilot ends 2 s after LT went down, even if LT stays held; releasing and pressing again restarts it.
  inp = c.poll(1000);
  assert.equal(inp.autoRun, true, 'still within 2 s');
  inp = c.poll(600);
  assert.equal(inp.autoRun, false, 'autopilot expires after 2 s');
  c.btn(6, false); inp = c.poll(16);
  assert.equal(inp.autoRun, false);
  c.btn(6, true); inp = c.poll(16);
  assert.equal(inp.autoRun, true, 'a fresh LT press restarts the autopilot');
  c.btn(6, false); c.poll(16);

  // Defending under autopilot: the priest runs ahead of the carrier's path (goal-side), not at where he is now.
  const m2 = createMatch(51);
  matchRef.current = m2;
  const d = m2.human, carrier = m2.players.find(p => p.team === 1 && !p.isGK);
  for (const p of m2.players) if (p !== d && p !== carrier) p.pos = { x: p.team ? 50 : -50, z: p.pos.z };
  d.pos = { x: -10, z: 10 }; d.vel = { x: 0, z: 0 };
  carrier.pos = { x: 0, z: 0 }; carrier.vel = { x: -6, z: 0 };
  m2.ball.owner = carrier; m2.ball.pos = { x: -0.7, y: 0.3, z: 0 };
  c.pad.axes = [0, 0, 0, 0];
  c.btn(6, true); inp = c.poll(16);
  step(m2, [inp, null], dt);
  const dir = Math.atan2(d.vel.z, d.vel.x);
  assert.ok(d.vel.z < 0 && Math.abs(dir) < Math.PI / 2 + 0.6, `defending autopilot heads to the carrier's predicted path (vel=${d.vel.x.toFixed(2)},${d.vel.z.toFixed(2)})`);
  c.btn(6, false); c.poll(16);
}

console.log('Advanced keyboard and standard gamepad controls (including LT autopilot) pass through the match simulation.');
