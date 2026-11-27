// Mouse aim (input.aim, a point on the pitch): it overrides the movement direction for passes, shots,
// chips, through balls and switching. Without it, everything aims with the movement keys as before.
import assert from 'node:assert/strict';
import { choosePrayer, createMatch, step, tackle } from '../src/sim.js';
const dt = 1 / 60, still = { move: { x: 0, z: 0 } };
const clearOpponents = (m, x = -20) => { for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x, z: p.pos.z }; };
const mate = (m, slot) => m.players.find(p => p.team === 0 && p.slot === slot);

// Pass goes to the team-mate nearest the cursor, even while running the other way.
{ const m = createMatch(11); const h = m.human; clearOpponents(m, 20);
  h.pos = { x: 0, z: 0 }; m.ball.owner = h; m.ball.pos = { x: 0.75, y: 0.3, z: 0 };
  const left = mate(m, 2), right = mate(m, 3); left.pos = { x: 5, z: -10 }; right.pos = { x: 5, z: 10 };
  const target = m.human === left ? right : left;
  step(m, { move: { x: 0, z: -target.pos.z }, aim: { x: target.pos.x, z: target.pos.z }, passPressed: true }, dt);
  assert.equal(m.ball.receiver, target, 'receiver is the priest under the cursor');
  assert.ok(Math.sign(m.ball.vel.z) === Math.sign(target.pos.z), 'ball travels towards the cursor, not the movement');
  console.log('aim pass ok'); }

// Shot placed where the cursor line meets the goal: aim at each post, the ball crosses on that side.
for (const side of [-1, 1]) {
  const m = createMatch(12 + side); const h = m.human; clearOpponents(m);
  const gk = m.players.find(p => p.team === 1 && p.isGK); gk.pos = { x: 27.5, z: 0 };
  h.pos = { x: 14, z: 0 }; m.ball.owner = h; m.ball.pos = { x: 14.75, y: 0.3, z: 0 };
  const aim = { x: 28, z: side * 2.6 };
  step(m, { ...still, aim, shootPressed: true, shootHeld: true }, dt);
  for (let i = 0; i < 20; i++) step(m, { ...still, aim, shootHeld: true }, dt);
  step(m, { ...still, aim, shootReleased: true }, dt);
  let z = null; for (let i = 0; i < 90 && z === null; i++) { gk.pos = { x: 27.8, z: -side * 3.6 }; /* keeper held at the far post: this is about placement */ step(m, still, dt); if (m.ball.pos.x > 25.5) z = m.ball.pos.z; }
  assert.ok(z !== null && Math.sign(z) === side && Math.abs(z) > 1.2, `aimed ${side * 2.6}, crossed at ${z?.toFixed(2)}`);
  console.log(`aim shot ok: aimed ${(side * 2.6).toFixed(1)}, crossed at ${z.toFixed(2)}`);
}

// Quick chip (Space: press and release in one tick) still gets a proper lob.
{ const m = createMatch(14); const h = m.human; clearOpponents(m, -5);
  h.pos = { x: 12, z: 0 }; m.ball.owner = h; m.ball.pos = { x: 12.75, y: 0.3, z: 0 };
  step(m, { ...still, aim: { x: 28, z: 1 }, shootPressed: true, chipReleased: true }, dt);
  let apex = 0; for (let i = 0; i < 90; i++) { step(m, still, dt); apex = Math.max(apex, m.ball.pos.y); }
  assert.ok(apex > 3, `quick chip apex ${apex.toFixed(1)} m`); console.log(`quick chip ok, apex ${apex.toFixed(1)} m`); }

// Through ball (Shift + right click) rolls into the space at the cursor for the quickest runner.
{ const m = createMatch(15); const h = m.human; clearOpponents(m, -20);
  h.pos = { x: -5, z: 0 }; m.ball.owner = h; m.ball.pos = { x: -4.25, y: 0.3, z: 0 };
  const runner = mate(m, 3) === h ? mate(m, 2) : mate(m, 3); runner.pos = { x: 4, z: 8 };
  const aim = { x: 14, z: 10 };
  step(m, { ...still, aim, passPressed: true, throughPressed: true }, dt);
  assert.equal(m.ball.receiver, runner);
  const off = Math.abs(Math.atan2(m.ball.vel.z, m.ball.vel.x) - Math.atan2(aim.z - m.ball.pos.z, aim.x - m.ball.pos.x)) * 180 / Math.PI;
  assert.ok(off < 3, `ball leaves ${off.toFixed(1)}° off the cursor line`);
  for (let i = 0; i < 240 && m.ball.owner === null; i++) step(m, still, dt);
  assert.equal(m.ball.owner, runner, 'the runner collects it'); console.log(`aim through ball ok, ${off.toFixed(1)}° off the cursor line, collected`); }

// Right click without the ball switches to the priest nearest the cursor.
{ const m = createMatch(16); const far = mate(m, 2) === m.human ? mate(m, 3) : mate(m, 2);
  m.ball.owner = m.players.find(p => p.team === 1 && p.slot === 4);
  far.pos = { x: -3, z: 14 };
  step(m, { ...still, aim: { x: -2, z: 13 }, switchPressed: true, switchToAim: true }, dt);
  assert.equal(m.human, far); console.log('aim switch ok'); }

// The keeper is playable: control comes to him with the ball, right-click picks him, left click punts
// towards the cursor, he lets it go himself after 6 s, and outside his box he can be tackled.
{ const m = createMatch(21); const gk = m.players.find(p => p.team === 0 && p.isGK), HL = m.pitch.length / 2;
  clearOpponents(m, 10);
  gk.pos = { x: -HL + 2, z: 0 }; m.ball.owner = null; m.ball.pos = { x: -HL + 2.4, y: 0.3, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
  step(m, still, dt);
  assert.equal(m.ball.owner, gk); assert.equal(m.human, gk, 'control comes to the keeper with the ball');
  const aim = { x: -HL + 30, z: 12 };
  step(m, { ...still, aim, shootPressed: true, shootHeld: true }, dt);
  for (let i = 0; i < 30; i++) step(m, { ...still, aim, shootHeld: true }, dt);
  step(m, { ...still, aim, shootReleased: true }, dt);
  assert.equal(m.ball.owner, null); assert.ok(m.ball.vel.y > 4, 'a lofted punt');
  const dirOk = m.ball.vel.x > 0 && m.ball.vel.z > 0;
  let land = { ...m.ball.pos }; for (let i = 0; i < 240 && !m.ball.owner; i++) { step(m, still, dt); if (!m.ball.owner) land = { ...m.ball.pos }; }
  const dist = Math.hypot(land.x - gk.pos.x, land.z - gk.pos.z);   // where it came down (or was taken)
  assert.ok(dirOk && dist > 20, `punt towards the cursor, landed ${dist.toFixed(1)} m out`);
  console.log(`keeper ok: control comes with the ball, punt landed ${dist.toFixed(1)} m towards the cursor`); }
{ const m = createMatch(22); const gk = m.players.find(p => p.team === 0 && p.isGK), HL = m.pitch.length / 2;
  m.ball.owner = m.players.find(p => p.team === 1 && p.slot === 4);
  const df = m.players.find(p => p.team === 0 && p.slot === 1); m.human = df; df.pos = { x: -HL + 14, z: 0 };
  for (const q of m.players) if (q.team === 0 && !q.isGK && q !== df) q.pos = { x: -HL + 30, z: q.pos.z };
  step(m, { ...still, aim: { x: -HL - 5, z: 1 }, switchPressed: true, switchToAim: true }, dt);   // right click aimed back at goal
  assert.equal(m.human, gk, 'switching towards our goal reaches the keeper');
  m.ball.owner = gk; gk.pos = { x: -HL + 2, z: 0 }; gk.holdT = 0; clearOpponents(m, 0);
  let t = 0; for (; t < 60 * 8 && m.ball.owner === gk; t++) step(m, still, dt);
  assert.ok(t / 60 > 5.9 && t / 60 < 7.5, `a human keeper who holds on lets it go himself after ~6 s (${(t / 60).toFixed(2)} s)`);
  m.human = gk; m.ball.owner = gk; gk.pos = { x: -HL + 20, z: 0 }; gk.stun = 0;
  const opp = m.players.find(p => p.team === 1 && p.slot === 4); opp.pos = { x: -HL + 21, z: 0 }; opp.tackleCd = 0; opp.stun = 0;
  m.rand = () => 0.01;
  const before = m.ball.owner; tackle(m, opp);
  assert.ok(before === gk && m.ball.owner !== gk, 'outside his box the keeper can be tackled');
  console.log(`keeper ok: right-click picks him, released after ${(t / 60).toFixed(1)} s, tackleable out of his box`); }

// A quick Shoot tap far from goal (> 24 m) knocks the ball on on EVERY device (mouse, keyboard, pad, touch);
// within 24 m it takes a quick snap shot; holding shoots from anywhere.
for (const [x, kind] of [[-10, 'knock'], [20, 'shot']]) {
  const m = createMatch(23); const h = m.human; clearOpponents(m, x < 0 ? 25 : -25);
  h.pos = { x, z: 0 }; h.vel = { x: 6, z: 0 }; h.knockCd = 0; m.ball.owner = h; m.ball.pos = { x: x + 0.75, y: 0.3, z: 0 };
  const aim = { x: x + 12, z: 2 };
  step(m, { ...still, aim, shootPressed: true, shootHeld: true }, dt);
  step(m, { ...still, aim, shootReleased: true }, dt);
  const got = m.events.some(e => e.type === 'knock') ? 'knock' : m.events.some(e => e.type === 'kick') ? 'shot' : 'none';
  assert.equal(got, kind, `mouse tap at x=${x}`);
  console.log(`left-click tap at ${Math.round(m.pitch.length / 2 - x)} m from goal: ${got}`);
}

// All-device Shoot tap->knock-on rules (no mouse aim: keyboard F, gamepad B, touch Shoot, Local 2P):
{
  const setup = (seed, x, { team = 0, facing = 0, knockCd = 0, isGK = false } = {}) => {
    const m = createMatch(seed, { humans: [true, team === 1] });
    const h = isGK ? m.players.find((p) => p.team === team && p.isGK) : m.players.find((p) => p.team === team && !p.isGK);
    m.humans[team] = h;
    if (team === 0) m.human = h;
    for (const p of m.players) if (p !== h) p.pos = { x: isGK ? 20 : (team === 0 ? -30 : 30), z: p.pos.z };
    h.pos = { x, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = facing; h.knockCd = knockCd;
    m.ball.owner = h; m.ball.pos = { x: x + (team === 0 ? 0.75 : -0.75), y: 0.3, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    return { m, h };
  };
  const stepFor = (m, team, inp) => step(m, team === 0 ? [inp, still] : [still, inp], dt);

  // 1. Far tap (no aim) -> knock-on (ball ahead, knock event, no shot).
  {
    const { m, h } = setup(31, -5); // 41.5 m from goal
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'knock'), true, 'far tap triggers knock');
    assert.equal(m.events.some((e) => e.type === 'kick'), false, 'far tap does not shoot');
    assert.equal(m.stats[0].shots, 0);
    assert.equal(m.ball.owner, null);
    assert.equal(m.ball.receiver, h);
    assert.ok(m.ball.vel.x > 4, `ball pushed ahead: vx=${m.ball.vel.x}`);
  }

  // 2. Near tap (within 24 m, no aim) -> quick shot.
  {
    const { m } = setup(32, 20); // 16.5 m from goal
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'kick'), true, 'near tap shoots');
    assert.equal(m.events.some((e) => e.type === 'knock'), false, 'near tap does not knock-on');
    assert.equal(m.stats[0].shots, 1);
  }

  // 3. Far hold (charge >= 0.2, no aim) -> shot.
  {
    const { m } = setup(33, -5);
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    for (let i = 0; i < 16; i++) stepFor(m, 0, { move: { x: 1, z: 0 }, shootHeld: true }); // ~0.30 charge
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'kick'), true, 'far hold shoots');
    assert.equal(m.events.some((e) => e.type === 'knock'), false);
    assert.equal(m.stats[0].shots, 1);
  }

  // 4. Far tap on cooldown -> does nothing (no accidental weak shot).
  {
    const { m, h } = setup(34, -5, { knockCd: 1.2 });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'knock'), false, 'cooldown suppresses knock');
    assert.equal(m.events.some((e) => e.type === 'kick'), false, 'cooldown suppresses accidental shot');
    assert.equal(m.ball.owner, h, 'priest keeps ball on cooldown tap');
    assert.equal(m.stats[0].shots, 0);
  }

  // 5. Stick direction respected, never backwards (both teams + facing backwards fallback).
  {
    // Forward diagonal stick respected.
    const { m } = setup(35, -5);
    stepFor(m, 0, { move: { x: 0.7, z: 0.7 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 0.7, z: 0.7 }, shootReleased: true });
    assert.ok(m.ball.vel.x > 3 && m.ball.vel.z > 3, `diagonal stick respected: ${JSON.stringify(m.ball.vel)}`);

    // Straight backward stick clamped forward (team 0 attacks +x).
    const { m: mBack } = setup(36, -5, { facing: Math.PI });
    stepFor(mBack, 0, { move: { x: -1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(mBack, 0, { move: { x: -1, z: 0 }, shootReleased: true });
    assert.ok(mBack.ball.vel.x > 4, `backward stick turned forward: ${JSON.stringify(mBack.ball.vel)}`);

    // Backward-diagonal stick on team 1 (attacks -x) clamped into team 1's forward half-plane (vx <= 0) while preserving z.
    const { m: mT1 } = setup(37, 5, { team: 1, facing: 0 });
    stepFor(mT1, 1, { move: { x: 0.8, z: -0.6 }, shootPressed: true, shootHeld: true });
    stepFor(mT1, 1, { move: { x: 0.8, z: -0.6 }, shootReleased: true });
    assert.ok(mT1.ball.vel.x <= 0 && mT1.ball.vel.z < -2, `team 1 clamped to forward half-plane: ${JSON.stringify(mT1.ball.vel)}`);

    // Neutral stick & no aim while facing backwards -> turned forward.
    const { m: mFace } = setup(38, -5, { facing: Math.PI });
    stepFor(mFace, 0, { move: { x: 0, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(mFace, 0, { move: { x: 0, z: 0 }, shootReleased: true });
    assert.ok(mFace.ball.vel.x > 4, `backward facing fallback turned forward: ${JSON.stringify(mFace.ball.vel)}`);
  }

  // 6. Keeper tap (no aim) -> punt (unchanged).
  {
    const { m } = setup(39, -32, { isGK: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'pass' && e.kind === 'lofted'), true, 'keeper tap punts');
    assert.equal(m.events.some((e) => e.type === 'knock'), false);
    assert.ok(m.ball.vel.y > 4, `keeper punt lofted: vy=${m.ball.vel.y}`);
  }

  // 7. Far tap with Jesus prayer active -> knock-on, and Jesus prayer stays active & unconsumed!
  {
    const { m } = setup(40, -5);
    m.prayers[0].ready = true;
    assert.equal(choosePrayer(m, 0, 'jesus'), true);
    assert.equal(m.prayers[0].active, 'jesus');
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootPressed: true, shootHeld: true });
    stepFor(m, 0, { move: { x: 1, z: 0 }, shootReleased: true });
    assert.equal(m.events.some((e) => e.type === 'knock'), true, 'far tap with Jesus active knocks on');
    assert.equal(m.events.some((e) => e.type === 'kick'), false);
    assert.equal(m.prayers[0].active, 'jesus', 'Jesus prayer remains active after knock-on');
    assert.equal(m.ball.shot, null);
  }
  console.log('all-device shoot-tap knock-on ok (far knock, near shot, far hold, cooldown, forward clamp, keeper punt, Jesus preserved)');
}

// Switching goes by direction from the current priest: the cursor (mouse) or the stick/keys (pad, Q).
{ const m = createMatch(24); const h = m.human; m.ball.owner = m.players.find(p => p.team === 1 && p.slot === 4);
  const L = m.players.find(p => p.team === 0 && p.slot === 2), R = m.players.find(p => p.team === 0 && p.slot === 3), D = m.players.find(p => p.team === 0 && p.slot === 1);
  h.pos = { x: 0, z: 0 }; L.pos = { x: 2, z: -12 }; R.pos = { x: 4, z: 14 }; D.pos = { x: -8, z: 1 };
  step(m, { ...still, aim: { x: 1, z: 6 }, switchPressed: true, switchToAim: true }, dt);
  assert.equal(m.human, R, 'mouse: the priest the cursor points towards, not the nearest');
  m.human = h; step(m, { move: { x: 0, z: -1 }, switchPressed: true }, dt);
  assert.equal(m.human, L, 'pad or keys: the priest the stick points towards');
  m.human = h; step(m, { move: { x: -1, z: 0 }, switchPressed: true }, dt);
  assert.equal(m.human, D);
  console.log('direction switch ok: cursor, stick and keys'); }

// Stamina: about 9 s of sprinting empties it and the sprint fades to running pace; rest refills it.
{ const m = createMatch(25); const h = m.human; clearOpponents(m, 30); m.ball.owner = null; m.ball.pos = { x: 30, y: 0.3, z: 15 };
  for (const q of m.players) if (q !== h) q.stun = 20;
  h.pos = { x: -30, z: 0 }; h.vel = { x: 0, z: 0 };
  let top = 0; for (let i = 0; i < 60; i++) { m.human = h; step(m, { move: { x: 0, z: (i % 120 < 60 ? 1 : -1) }, sprint: true }, dt); h.pos.z = clamp0(h.pos.z); top = Math.max(top, Math.hypot(h.vel.x, h.vel.z)); }
  for (let i = 0; i < 60 * 8.5; i++) { m.human = h; step(m, { move: { x: 1, z: 0 }, sprint: true }, dt); if (h.pos.x > 25) h.pos.x = -30; }   // keep control on him
  const tired = Math.hypot(h.vel.x, h.vel.z);
  assert.ok(h.stamina < 0.1, `stamina after 9.5 s of sprinting: ${h.stamina.toFixed(2)}`);
  assert.ok(tired < top * 0.8, `tired sprint ${tired.toFixed(1)} m/s against fresh ${top.toFixed(1)} m/s`);
  for (let i = 0; i < 60 * 5; i++) { m.human = h; step(m, still, dt); }
  assert.ok(h.stamina > 0.9, `rested: ${h.stamina.toFixed(2)}`);
  console.log(`stamina ok: fresh sprint ${top.toFixed(1)} m/s, after 9.5 s ${tired.toFixed(1)} m/s, refilled to ${h.stamina.toFixed(2)} after 5 s rest`); }
function clamp0(z) { return Math.max(-10, Math.min(10, z)); }

// A tired priest can still spend the last of his stamina, including while dribbling.
for (const holding of [false, true]) {
  for (let slot = 0; slot < 5; slot++) {
    const m = createMatch(26), p = mate(m, slot);
    m.human = p;
    for (const q of m.players) if (q !== p) { q.pos.z = -12; q.stun = 4; }
    p.pos = { x: -14, z: 10 }; p.stamina = .12;
    m.ball.owner = holding ? p : null;
    m.ball.pos = { x: -14, z: holding ? 10 : 0, y: .3 };
    for (let i = 0; i < 180; i++) step(m, { move: { x: 1, z: 0 }, sprint: true }, dt);
    assert.equal(m.human, p);
    assert.equal(p.stamina, 0, p.info.name + (holding ? ' with' : ' without') + ' the ball');
  }
}
