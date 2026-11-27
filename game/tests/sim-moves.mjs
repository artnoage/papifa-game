// The five advanced moves, driven through the same input flags the controls send (see input.js / touch.js).
import assert from 'node:assert/strict';
import { createMatch, step, kickoff } from '../src/sim.js';
const dt = 1 / 60, idle = { move: { x: 0, z: 0 } };
const kinds = (m) => m.events.map(e => `${e.type}:${e.kind ?? ''}`);
// Through ball: the striker is ahead, the ball goes into space ahead of him and control follows.
{ const m = createMatch(1); const h = m.human, fw = m.players.find(p => p.team === 0 && p.slot === 3);
  for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x: -20, z: p.pos.z };   // clear the way
  h.pos = { x: 0, z: 0 }; fw.pos = { x: 8, z: 5 }; m.ball.owner = h;
  step(m, { ...idle, move: { x: 1, z: 0 }, passPressed: true, throughPressed: true }, dt);
  const e = m.events.find(e => e.type === 'pass'); assert.equal(e?.kind, 'through'); assert.equal(e.human, true);
  assert.equal(m.human, fw); assert.ok(m.ball.vel.x > 5);
  let got = false; for (let i = 0; i < 180 && !got; i++) { step(m, idle, dt); got = m.ball.owner === fw; }   // hands off: auto-run onto it
  assert.ok(got, 'runner collects the through ball'); console.log('through ok, collected at x', fw.pos.x.toFixed(1)); }
// Chip: high arc, tagged.
{ const m = createMatch(2); const h = m.human; h.pos = { x: 14, z: 0 }; m.ball.owner = h; m.ball.pos.x = 14.7;
  for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x: -5, z: p.pos.z };
  const gk = m.players.find(p => p.team === 1 && p.isGK); gk.pos = { x: 23, z: 0 };
  step(m, { ...idle, shootPressed: true, shootHeld: true }, dt);
  step(m, { ...idle, shootReleased: true, chipReleased: true }, dt);
  const e = m.events.find(e => e.type === 'kick'); assert.equal(e?.kind, 'chip'); assert.ok(m.ball.vel.y > 8);
  let maxY = 0, goal = false; for (let i = 0; i < 150; i++) { step(m, idle, dt); maxY = Math.max(maxY, m.ball.pos.y); goal ||= m.events.some(e => e.type === 'goal'); }
  console.log(`chip ok, apex ${maxY.toFixed(1)} m, scored over an advanced keeper: ${goal}`); }
// Knock-on: ball pushed ahead, burst, player collects it again.
{ const m = createMatch(3); const h = m.human; h.pos = { x: -10, z: 0 }; h.vel = { x: 7, z: 0 }; m.ball.owner = h; m.ball.pos = { x: -9.25, y: 0.3, z: 0 };
  for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x: 20, z: p.pos.z };
  step(m, { move: { x: 1, z: 0 }, sprint: true, knockOnPressed: true }, dt);
  assert.ok(m.events.some(e => e.type === 'knock')); assert.equal(m.ball.owner, null); assert.ok(h.burstT > 0);
  let t = 0; for (; t < 180 && m.ball.owner !== h; t++) step(m, { move: { x: 1, z: 0 }, sprint: true }, dt);
  assert.equal(m.ball.owner?.info.name, h.info.name, `owner ${m.ball.owner?.info.name} team ${m.ball.owner?.team}`); console.log(`knock-on ok, re-collected after ${(t / 60).toFixed(2)} s`); }
// One-two: pass tagged onetwo, passer flagged, next pass towards him is a through ball.
{ const m = createMatch(4); const h = m.human, mate = m.players.find(p => p.team === 0 && p.slot === 3);
  h.pos = { x: 0, z: -3 }; mate.pos = { x: 6, z: 4 }; m.ball.owner = h; m.ball.pos = { x: 0.75, y: 0.3, z: -3 };
  for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x: -20, z: p.pos.z };
  step(m, { ...idle, move: { x: 1, z: 1 }, passPressed: true, oneTwoPressed: true }, dt);
  assert.ok(kinds(m).includes('pass:onetwo')); assert.ok(h.oneTwoT > m.t);
  for (let i = 0; i < 120 && m.ball.owner !== mate; i++) step(m, idle, dt);
  assert.equal(m.ball.owner, mate); for (let i = 0; i < 25; i++) step(m, idle, dt);
  step(m, { ...idle, move: { x: h.pos.x - mate.pos.x, z: h.pos.z - mate.pos.z }, passPressed: true }, dt);
  assert.ok(kinds(m).includes('pass:through'), kinds(m).join()); console.log('one-two ok, return ball is a through ball to', h.info.name); }
// Call press: a second defender closes down the carrier.
{ const m = createMatch(5); const c = m.players.find(p => p.team === 1 && p.slot === 3); c.pos = { x: -12, z: 0 }; m.ball.owner = c; m.lastTeam = 1;
  m.human = m.players.find(p => p.team === 0 && p.slot === 4); m.human.pos = { x: 10, z: 10 };
  const dist = () => m.players.filter(p => p.team === 0 && !p.isGK && p !== m.human).map(p => Math.hypot(p.pos.x - c.pos.x, p.pos.z - c.pos.z)).sort((a, b) => a - b);
  for (let i = 0; i < 40; i++) { step(m, { ...idle, pressPressed: i === 0 }, dt); c.pos = { x: -12, z: 0 }; m.ball.owner = c; }
  console.log('call-press: two nearest defenders', dist().slice(0, 2).map(d => d.toFixed(1)).join(' m, '), 'm from the carrier'); }
// Keeper: holds the ball (untackleable) while opponents swarm him, they drop out of his area,
// and he plays it short only once a team-mate is free; the receiver isn't in front of his own goal.
{ const m = createMatch(6, { ai: [{ gkCare: 1 }, {}] }); const gk = m.players.find(p => p.team === 0 && p.isGK), HL = m.pitch.length / 2;
  gk.pos = { x: -HL + 2, z: 0 }; m.ball.owner = gk; m.lastTeam = 0;
  const opp = m.players.filter(p => p.team === 1 && !p.isGK);
  opp.forEach((p, i) => { p.pos = { x: -HL + 3.5, z: -1.5 + i }; });                 // right on top of him
  for (let i = 0; i < 20; i++) step(m, null, dt);
  assert.equal(m.ball.owner, gk, 'keeper keeps the ball while swarmed');
  let t = 20; for (; t < 60 * 6 && m.ball.owner === gk; t++) step(m, null, dt);
  const minDepth = Math.min(...opp.map(p => p.pos.x + HL));
  assert.ok(t / 60 >= 1.3, `keeper held ${(t / 60).toFixed(2)} s`);
  assert.ok(minDepth > 9, `an opponent is still ${minDepth.toFixed(1)} m from the goal line`);
  const r = m.ball.receiver; assert.ok(r && r.team === 0, 'played to a team-mate');
  assert.ok(r.pos.x + HL >= 8, `receiver ${(r.pos.x + HL).toFixed(1)} m from his goal line`);
  let got = false; for (let i = 0; i < 180 && !got; i++) { step(m, null, dt); got = m.ball.owner?.team === 0 && m.ball.owner !== gk; if (m.ball.owner?.team === 1) break; }
  assert.ok(got, 'the team-mate receives it'); console.log(`keeper ok: held ${(t / 60).toFixed(1)} s, opponents dropped to ${minDepth.toFixed(1)} m, ${r.info.name} received it`); }
// Slide tackle: from 3 m the tackle button launches a slide (unsteerable, ~3 m), the leading boot
// strips the carrier, and the slider then has to get up; up close it's still a standing tackle.
{ const m = createMatch(7); const h = m.human, c = m.players.find(p => p.team === 1 && p.slot === 4);
  m.ball.owner = c; m.lastTeam = 1; c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; m.ball.pos = { x: -0.75, y: 0.3, z: 0 };
  h.pos = { x: 0, z: -3 }; h.vel = { x: 0, z: 0 }; m.rand = () => 0.01;               // the slide wins it
  for (const p of m.players) if (p !== h && p !== c && !p.isGK) p.pos = { x: p.team ? 20 : -20, z: p.pos.z };
  const start = { ...h.pos };
  step(m, { move: { x: 0, z: 0 }, passPressed: true }, dt);
  assert.equal(h.anim, 'slide'); assert.ok(m.events.some(e => e.type === 'tackle' && e.kind === 'slide'));
  let won = false, t = 0;
  for (; t < 120 && !h.slideDone; t++) { step(m, { move: { x: 1, z: 0 } }, dt); won ||= m.ball.owner === null && c.stun > 0; }
  const dist = Math.hypot(h.pos.x - start.x, h.pos.z - start.z);
  assert.ok(won, 'the slide strips the carrier'); assert.ok(dist > 2 && dist < 4.5, `slid ${dist.toFixed(2)} m`);
  assert.ok(h.stun > 0, 'the slider has to get up');
  const close = createMatch(8); const h2 = close.human, c2 = close.players.find(p => p.team === 1 && p.slot === 4);
  close.ball.owner = c2; c2.pos = { x: 0, z: 0 }; h2.pos = { x: 0, z: -1.2 };
  step(close, { move: { x: 0, z: 0 }, passPressed: true }, dt);
  assert.equal(h2.anim, 'tackle', 'up close it is a standing tackle');
  console.log(`slide ok: ${dist.toFixed(2)} m in ${(t / 60).toFixed(2)} s, carrier stripped, standing tackle up close`); }
// A priest can slide again once he's back up, and a restart ends a slide in progress.
{ const m = createMatch(9); const h = m.human, c = m.players.find(p => p.team === 1 && p.slot === 4);
  const setup = () => { m.human = h; m.ball.owner = c; c.pos = { x: 0, z: 0 }; c.vel = { x: 0, z: 0 }; h.pos = { x: 0, z: -3 }; h.vel = { x: 0, z: 0 }; };
  setup(); step(m, { move: { x: 0, z: 0 }, passPressed: true }, dt); assert.equal(h.anim, 'slide');
  for (let i = 0; i < 180; i++) step(m, { move: { x: 0, z: 0 } }, dt);
  assert.ok(h.slideDone && h.stun <= 0 && h.tackleCd <= 0, 'back up after the first slide');
  setup(); step(m, { move: { x: 0, z: 0 }, passPressed: true }, dt);
  assert.ok(m.events.some(e => e.type === 'tackle' && e.kind === 'slide'), 'a second slide');
  kickoff(m, 0); assert.ok(h.slideDone, 'kickoff ends the slide');
  console.log('repeat slide ok: second slide launches, kickoff ends a slide'); }
