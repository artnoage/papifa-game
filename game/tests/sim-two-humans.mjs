// Two humans (local or online 2P): m.humans[team] is each side's controlled priest, and
// step(m, [input0, input1], dt) drives both. m.human stays an alias for team 0.
import assert from 'node:assert/strict';
import { createMatch, step, setHumanTeam, isHuman, teamOf } from '../src/sim.js';
const dt = 1 / 60, still = { move: { x: 0, z: 0 } };
const two = (seed, size = 5) => createMatch(seed, { size, humans: [true, true] });
const nearestOf = (m, team, pt) => teamOf(m, team).filter((q) => !q.isGK)
  .reduce((a, q) => (Math.hypot(q.pos.x - pt.x, q.pos.z - pt.z) < Math.hypot(a.pos.x - pt.x, a.pos.z - pt.z) ? q : a));

// Kickoff: each side controls its centre forward; the alias follows team 0; a one-player match has no team-1 human.
{ const m = two(1);
  assert.equal(m.humans[0].team, 0); assert.equal(m.humans[1].team, 1);
  assert.equal(m.humans[0].slot, 4); assert.equal(m.humans[1].slot, 4);
  assert.equal(m.human, m.humans[0]);
  m.human = teamOf(m, 0)[1]; assert.equal(m.humans[0], teamOf(m, 0)[1], 'm.human writes through to humans[0]');
  const one = createMatch(1);
  assert.equal(one.humans[1], null); assert.equal(one.human.team, 0);
  for (const size of [3, 5]) { const s = two(3, size); assert.ok(s.humans[0] && s.humans[1], `both humans in ${size}v${size}`); }
  console.log('kickoff humans ok'); }

// Each input moves only its own priest.
{ const m = two(2);
  const [a, b] = m.humans, a0 = { ...a.pos }, b0 = { ...b.pos };
  m.ball.owner = null; m.ball.pos = { x: 0, y: 0.3, z: 20 };          // nobody near it
  for (let i = 0; i < 30; i++) { m.humans[0] = a; m.humans[1] = b; step(m, [{ move: { x: 0, z: 1 } }, { move: { x: 0, z: -1 } }], dt); }
  assert.ok(a.pos.z - a0.z > 1.5, `team 0 moved +z (${(a.pos.z - a0.z).toFixed(2)})`);
  assert.ok(b0.z - b.pos.z > 1.5, `team 1 moved -z (${(b0.z - b.pos.z).toFixed(2)})`);
  console.log('independent movement ok'); }

// Team 1's pass hands team 1's control to the receiver and leaves team 0's alone.
{ const m = two(3);
  const h1 = m.humans[1], h0 = m.humans[0];
  for (const p of teamOf(m, 0)) if (!p.isGK) p.pos = { x: 20, z: p.pos.z };   // team 0 out of the way
  h1.pos = { x: 0, z: 0 }; m.ball.owner = h1; m.ball.pos = { x: -0.75, y: 0.3, z: 0 };
  const mate = teamOf(m, 1).find((q) => !q.isGK && q !== h1); mate.pos = { x: -2, z: -8 };
  step(m, [still, { move: { x: 0, z: 0 }, aim: { ...mate.pos }, passPressed: true }], dt);
  assert.equal(m.ball.receiver, mate); assert.equal(m.humans[1], mate, 'control follows the pass'); assert.equal(m.humans[0], h0);
  for (let i = 0; i < 120 && m.ball.owner !== mate; i++) step(m, [still, still], dt);
  assert.equal(m.ball.owner, mate); assert.ok(isHuman(m, mate));
  console.log('team-1 pass and handover ok'); }

// Switching: team 1's switch button changes only team 1's priest, in the direction held.
{ const m = two(4);
  const h0 = m.humans[0], h1 = m.humans[1];
  m.ball.owner = null; m.ball.pos = { x: 0, y: 0.3, z: 0 };
  h1.pos = { x: 5, z: 0 };
  const up = teamOf(m, 1).find((q) => !q.isGK && q !== h1); up.pos = { x: 5, z: 10 };
  for (const q of teamOf(m, 1)) if (!q.isGK && q !== h1 && q !== up) q.pos = { x: 15, z: -10 };
  step(m, [still, { move: { x: 0, z: 1 }, switchPressed: true }], dt);
  assert.equal(m.humans[1], up); assert.equal(m.humans[0], h0);
  console.log('per-team switching ok'); }

// Shot charge is per team: team 1 holding shoot charges m.charges[1]; the team-0 alias stays at 0.
{ const m = two(5);
  const h1 = m.humans[1];
  for (const p of teamOf(m, 0)) if (!p.isGK) p.pos = { x: 20, z: p.pos.z };
  h1.pos = { x: 5, z: 0 }; m.ball.owner = h1; m.ball.pos = { x: 4.25, y: 0.3, z: 0 };
  for (let i = 0; i < 20; i++) step(m, [still, { ...still, shootHeld: true, shootPressed: i === 0 }], dt);
  assert.ok(m.charges[1] > 0.3 && m.chargings[1]); assert.equal(m.charge, 0); assert.equal(m.charging, false);
  step(m, [still, { ...still, shootReleased: true }], dt);
  assert.ok(m.ball.shot?.team === 1, 'team 1 shot'); assert.equal(m.charges[1], 0);
  console.log('per-team charge ok'); }

// Team 1's keeper catching a shot becomes team 1's priest.
{ let caught = 0;
  for (let seed = 1; seed <= 20 && !caught; seed++) {
    const m = two(100 + seed);
    const s = m.humans[0], gk = teamOf(m, 1).find((q) => q.isGK);
    for (const p of teamOf(m, 1)) if (!p.isGK) p.pos = { x: -20, z: p.pos.z };
    s.pos = { x: 16, z: 0 }; m.ball.owner = s; m.ball.pos = { x: 16.75, y: 0.3, z: 0 };
    step(m, [{ ...still, shootHeld: true, shootPressed: true }, still], dt);
    step(m, [{ ...still, shootReleased: true }, still], dt);
    for (let i = 0; i < 90 && m.phase === 'play'; i++) { step(m, [still, still], dt); if (m.ball.owner === gk) break; }
    if (m.ball.owner === gk) { assert.equal(m.humans[1], gk, 'the catch gives team 1 its keeper'); caught++; }
  }
  assert.ok(caught, 'some soft shot was caught');
  console.log('team-1 keeper handover ok'); }

// A second player joining mid-match (or step given a team-1 input) makes that side human.
{ const m = createMatch(6);
  for (let i = 0; i < 60; i++) step(m, still, dt);
  assert.equal(m.humans[1], null);
  step(m, [still, still], dt);
  assert.ok(m.humanTeams[1] && m.humans[1]?.team === 1, 'team 1 joined');
  setHumanTeam(m, 1, false); assert.equal(m.humans[1], null);
  step(m, still, dt); assert.equal(m.humans[1], null, 'AI again');
  const near = nearestOf(m, 1, m.ball.pos); setHumanTeam(m, 1, true);
  assert.ok(m.humans[1] === near || m.ball.owner === m.humans[1]);
  console.log('join and leave ok'); }

// Two scripted humans play a whole match in both modes: chase, pass, shoot. Goals, no NaN, both switch.
for (const size of [3, 5]) {
  let goals = [0, 0], switched = [0, 0];
  for (let seed = 1; seed <= 4; seed++) {
    const m = two(200 + seed, size);
    const last = [m.humans[0], m.humans[1]];
    let i = 0;
    while (m.phase !== 'over' && i < 60 * 600) {
      i++;
      const inputs = [0, 1].map((t) => {
        const h = m.humans[t], b = m.ball, own = b.owner === h, dir = t === 0 ? 1 : -1;
        const tx = own ? dir * 40 : b.pos.x, tz = own ? 0 : b.pos.z;
        const L = Math.hypot(tx - h.pos.x, tz - h.pos.z) || 1;
        const near = own && Math.abs(dir * (m.pitch.length / 2) - h.pos.x) < 14;
        return { move: { x: (tx - h.pos.x) / L, z: (tz - h.pos.z) / L }, sprint: h.stamina > 0.4,
          passPressed: (!own && i % 45 === t * 20) || (own && !near && i % 150 === t * 70),
          shootPressed: near && !m.chargings[t], shootHeld: near && m.charges[t] < 0.6, shootReleased: near && m.charges[t] >= 0.6 };
      });
      step(m, inputs, dt);
      for (const t of [0, 1]) if (m.humans[t] !== last[t]) { switched[t]++; last[t] = m.humans[t]; }
      for (const p of m.players) assert.ok(Number.isFinite(p.pos.x) && Number.isFinite(p.pos.z));
      assert.ok(m.humans[0]?.team === 0 && m.humans[1]?.team === 1);
    }
    assert.equal(m.phase, 'over');
    goals[0] += m.score[0]; goals[1] += m.score[1];
  }
  assert.ok(goals[0] + goals[1] > 0, 'someone scores');
  assert.ok(switched[0] > 4 && switched[1] > 4, `control moved on both sides ${switched}`);
  console.log(`${size}v${size} two-human matches ok: goals ${goals}, switches ${switched}`);
}
