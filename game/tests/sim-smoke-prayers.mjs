// Prayers-on smoke bands (v4): equal Normal AI bands, home share, Easy vs Normal,
// and 48-seed Casual vs Very easy targets (with Very easy praying <= 1/match and <= 0.1 Jesus goals/match).
import assert from 'node:assert/strict';
import { createMatch, kickoff, step } from '../src/sim.js';
import { AI_LEVELS } from '../src/config.js';

const dt = 1 / 60;

function casualInput(m, tick) {
  const h = m.human, b = m.ball;
  if (b.owner !== h) {
    return {
      move: { x: b.pos.x - h.pos.x, z: b.pos.z - h.pos.z }, sprint: true,
      switchPressed: tick % 90 === 0, passPressed: tick % 40 === 0,
    };
  }
  const input = { move: { x: 1, z: -h.pos.z * 0.1 }, sprint: true };
  if (m.charging) {
    input.shootHeld = m.charge < 0.5;
    input.shootReleased = !input.shootHeld;
  } else if (h.pos.x > m.pitch.length / 2 - 16) {
    input.shootHeld = true;
  } else {
    input.passPressed = tick % 70 === 0 || tick % 50 === 0;
  }
  return input;
}

function playMatch(seed, firstTeam, controller, opts = {}) {
  const m = createMatch(seed, { prayers: true, ...opts });
  if (firstTeam === 1) kickoff(m, 1);
  const prayers = [0, 0];
  const jesusGoals = [0, 0];
  const maryBlocks = [0, 0];
  let clashes = 0;
  for (let tick = 0; m.phase !== 'over' && tick < 60 * 300; tick++) {
    step(m, controller ? controller(m, tick) : null, dt);
    for (const e of m.events) {
      if (e.type === 'prayer') prayers[e.team]++;
      else if (e.type === 'goal' && e.jesus) jesusGoals[e.team]++;
      else if (e.type === 'maryBlock') maryBlocks[e.team]++;
      else if (e.type === 'clash') clashes++;
    }
  }
  assert.equal(m.phase, 'over');
  return { score: m.score, prayers, jesusGoals, maryBlocks, clashes };
}

const record = (scores) => ['W', 'D', 'L'].map((_, i) => scores.filter(([a, b]) => Math.sign(b - a) === i - 1).length);

for (const [size, band, casualMinW48] of [[5, [3.5, 5.3], 42], [3, [5.6, 7.4], 34]]) {
  const equalRuns = [];
  const easyRuns = [];
  for (let seed = 1; seed <= 24; seed++) {
    equalRuns.push(playMatch(seed, 0, null, { size }), playMatch(seed, 1, null, { size }));
    if (size === 5) easyRuns.push(playMatch(seed, 0, null, { size, ai: [AI_LEVELS.easy, AI_LEVELS.normal] }));
  }
  const totals = equalRuns.map((r) => r.score[0] + r.score[1]);
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  const homeShare = equalRuns.reduce((s, r) => s + r.score[0], 0) / totals.reduce((a, b) => a + b, 0);
  assert.ok(avg >= band[0] && avg <= band[1], `${size}v${size} prayers-on equal Normal avg ${avg.toFixed(2)} outside ${band[0]}–${band[1]}`);
  assert.ok(homeShare >= 0.4 && homeShare <= 0.6, `${size}v${size} prayers-on home share ${(homeShare * 100).toFixed(1)}% outside 40–60%`);

  if (size === 5) {
    const [ew, ed, el] = record(easyRuns.map((r) => r.score));
    assert.ok(ew >= 3 && el > 0, `5v5 prayers-on Easy vs Normal: ${ew}W ${ed}D ${el}L (need >= 3W)`);
    console.log(`5v5 prayers-on Easy vs Normal (24m): ${ew}W ${ed}D ${el}L`);
  }

  // 48-match Casual vs Very easy verification.
  const cveRuns = [];
  for (let seed = 1; seed <= 48; seed++) {
    const r = playMatch(seed, 0, casualInput, { size, level: 'veryEasy' });
    assert.ok(r.prayers[1] <= 1, `${size}v${size} seed ${seed}: Very easy prayed ${r.prayers[1]} times (> 1)`);
    assert.equal(r.prayers[0], 0, `${size}v${size} seed ${seed}: AI prayed for human side`);
    cveRuns.push(r);
  }
  const [cw, cd, cl] = record(cveRuns.map((r) => r.score));
  const vePrayers = cveRuns.reduce((s, r) => s + r.prayers[1], 0);
  const veJesusGoals = cveRuns.reduce((s, r) => s + r.jesusGoals[1], 0);
  const veMaryBlocks = cveRuns.reduce((s, r) => s + r.maryBlocks[1], 0);
  const veJGPerMatch = veJesusGoals / cveRuns.length;
  assert.ok(cw >= casualMinW48, `${size}v${size} prayers-on casual vs VE: ${cw}W ${cd}D ${cl}L / 48 (need >= ${casualMinW48}W)`);
  assert.ok(veJGPerMatch <= 0.1, `${size}v${size} VE Jesus goals/match = ${veJGPerMatch.toFixed(3)} (> 0.1)`);

  console.log(`${size}v${size} prayers-on Equal Normal AI (48m): ${avg.toFixed(2)} g/m, home ${(homeShare * 100).toFixed(1)}%`);
  console.log(`${size}v${size} prayers-on Casual vs Very easy (48m): ${cw}W ${cd}D ${cl}L (${(cw / 2).toFixed(1)}/24-eq), VE prayers ${vePrayers}/48, VE Jesus goals ${veJesusGoals}/48 (${veJGPerMatch.toFixed(3)}/m), VE Mary blocks ${veMaryBlocks}`);

  // 48-match Very hard vs Hard (alternating kickoff) & 24-match Casual vs Very hard.
  const vhVsHard = [];
  for (let seed = 1; seed <= 24; seed++) {
    vhVsHard.push(playMatch(seed, 0, null, { size, humans: [false, false], ai: [AI_LEVELS.veryHard, AI_LEVELS.hard] }));
    vhVsHard.push(playMatch(seed, 1, null, { size, humans: [false, false], ai: [AI_LEVELS.veryHard, AI_LEVELS.hard] }));
  }
  const [vhW, vhD, vhL] = record(vhVsHard.map((r) => r.score));
  const vhShare = vhW / (vhW + vhL);
  assert.ok(vhShare >= 0.60, `${size}v${size} prayers-on Very hard vs Hard: ${vhW}W ${vhD}D ${vhL}L (${(vhShare * 100).toFixed(1)}% < 60%)`);
  const cvhRuns = [];
  for (let seed = 1; seed <= 24; seed++) cvhRuns.push(playMatch(seed, 0, casualInput, { size, level: 'veryHard' }));
  const [cvhW, cvhD, cvhL] = record(cvhRuns.map((r) => r.score));
  assert.ok(cvhW <= 2, `${size}v${size} prayers-on Casual vs Very hard should rarely win (${cvhW}W ${cvhD}D ${cvhL}L)`);
  console.log(`${size}v${size} prayers-on Very hard vs Hard (48m): ${vhW}W ${vhD}D ${vhL}L (${(vhShare * 100).toFixed(1)}% of decided) | Casual vs Very hard (24m): ${cvhW}W ${cvhD}D ${cvhL}L`);
}
