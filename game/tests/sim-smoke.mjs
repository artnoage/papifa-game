import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';
import { createMatch, kickoff, pass, passTo, step } from '../src/sim.js';
import { AI_LEVELS, resolveLevel } from '../src/config.js';

assert.deepEqual(Object.keys(AI_LEVELS), ['veryEasy', 'easy', 'normal', 'hard', 'veryHard']);
assert.equal(resolveLevel('veryEasy'), 'veryEasy');
assert.equal(resolveLevel('veryeasy'), 'veryEasy');
assert.equal(resolveLevel('VERY_EASY'), 'veryEasy');
assert.equal(resolveLevel('HARD'), 'hard');
assert.equal(resolveLevel('veryHard'), 'veryHard');
assert.equal(resolveLevel('veryhard'), 'veryHard');
assert.equal(resolveLevel('VERY_HARD'), 'veryHard');
assert.equal(resolveLevel('constructor'), 'normal');

// CPU speed knob affects ONLY the CPU opponent team — never the human team's AI teammates/keeper or Local 2P.
{
  const runHumanTeammateSpeed = (level, humans = [true, false]) => {
    const m = createMatch(77, { size: 5, level, humans, prayers: false });
    const mate = m.players.find((p) => p.team === 0 && !p.isGK && p !== m.humans[0]);
    const opp = m.players.find((p) => p.team === 1 && !p.isGK && p.slot === mate.slot);
    m.ball.owner = null; m.ball.pos = { x: 25, y: 0.3, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    mate.pos = { x: -10, z: -8 }; mate.vel = { x: 0, z: 0 };
    opp.pos = { x: -10, z: 8 }; opp.vel = { x: 0, z: 0 };
    const idleInp = { move: { x: 0, z: 0 }, sprint: false };
    for (let i = 0; i < 40; i++) step(m, humans[1] ? [idleInp, idleInp] : idleInp, 1 / 60);
    return { mateSpeed: mate.speed, oppSpeed: opp.speed };
  };
  const sVe = runHumanTeammateSpeed('veryEasy');
  const sHard = runHumanTeammateSpeed('hard');
  const sVh = runHumanTeammateSpeed('veryHard');
  assert.ok(Math.abs(sVe.mateSpeed - sHard.mateSpeed) < 0.05 && Math.abs(sVh.mateSpeed - sHard.mateSpeed) < 0.05,
    `human AI teammates unaffected by difficulty (VE=${sVe.mateSpeed.toFixed(2)}, H=${sHard.mateSpeed.toFixed(2)}, VH=${sVh.mateSpeed.toFixed(2)})`);
  assert.ok(sVe.oppSpeed < sHard.oppSpeed * 0.78, `veryEasy CPU slower (${sVe.oppSpeed.toFixed(2)} vs ${sHard.oppSpeed.toFixed(2)})`);
  // Local 2P: both sides' AI teammates run at identical Hard speed regardless of level.
  const l2pVe = runHumanTeammateSpeed('veryEasy', [true, true]);
  const l2pVh = runHumanTeammateSpeed('veryHard', [true, true]);
  assert.ok(Math.abs(l2pVe.mateSpeed - l2pVh.mateSpeed) < 0.05 && Math.abs(l2pVe.oppSpeed - l2pVh.oppSpeed) < 0.05,
    `Local 2P unaffected by level (VE=${JSON.stringify(l2pVe)}, VH=${JSON.stringify(l2pVh)})`);
}

// Back-passes to your own keeper are never lofted, and steering forward never picks a team-mate behind the stick.
{
  const bp = createMatch(1, { size: 3 });
  const carrier = bp.human;
  const gk = bp.players.find(q => q.team === 0 && q.isGK);
  const mate = bp.players.find(q => q.team === 0 && !q.isGK && q !== carrier);
  carrier.pos = { x: 8, z: 0 }; carrier.vel = { x: 0, z: 0 };
  mate.pos = { x: 9.5, z: 0.2 }; mate.vel = { x: 0, z: 0 };   // < 3 m away, skipped by bestMate
  gk.pos = { x: -18, z: 0 }; gk.vel = { x: 0, z: 0 };
  bp.ball.owner = carrier; bp.ball.pos = { x: 8.6, y: 0.22, z: 0 };
  pass(bp, carrier, { x: 1, z: 0 });
  assert.equal(bp.ball.receiver, null, 'Steering forward must not pick the keeper behind the stick');
  assert.ok(bp.ball.vel.x > 10 && bp.ball.vel.y === 0, 'Fallback pass plays a ground ball along the stick');

  bp.ball.owner = carrier; bp.ball.pos = { x: 8.6, y: 0.22, z: 0 }; bp.ball.receiver = null;
  pass(bp, carrier, { x: -1, z: 0 });
  assert.equal(bp.ball.receiver, gk, 'Deliberate stick back towards the keeper still selects him');
  assert.equal(bp.ball.vel.y, 0, 'Long back-pass to your own keeper stays on the ground');
  assert.ok(Math.hypot(bp.ball.vel.x, bp.ball.vel.z) > 15, 'Long back-pass to your own keeper is played firmly');

  bp.ball.owner = carrier; bp.ball.pos = { x: 8.6, y: 0.22, z: 0 }; bp.ball.receiver = null;
  passTo(bp, carrier, gk);
  assert.equal(bp.ball.vel.y, 0, 'Direct passTo own keeper from > 20 m is never lofted');
}

const idle = { move: { x: 0, z: 0 }, sprint: false };
const dt = 1 / 60;

// Poll two display frames before a tick, then run a second tick on the same frame.
const keyboard = new EventTarget();
globalThis.addEventListener = keyboard.addEventListener.bind(keyboard);
const pad = { axes: [0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false })) };
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => [pad] }, configurable: true });
const controls = createInput();
const kickoffPass = createMatch(1);
keyboard.dispatchEvent(Object.assign(new Event('keydown'), { code: 'Space' }));
controls.poll();
keyboard.dispatchEvent(Object.assign(new Event('keyup'), { code: 'Space' }));
const input = controls.poll();
assert.equal(input.passPressed, true);
step(kickoffPass, input, dt);
assert.ok(kickoffPass.events.some(e => e.type === 'pass'));
controls.clearActions();
assert.equal(input.passPressed, false);
step(kickoffPass, input, dt);
assert.ok(kickoffPass.events.every(e => e.type !== 'pass'));

// A gamepad shot pressed and released between ticks still fires via retained edges:
// far from goal (> 24 m) it knocks the ball ahead; within 24 m it takes a minimum-power shot.
const padControls = createInput({ type: 'gamepad', index: 0 });
for (const [x, evType] of [[0, 'knock'], [20, 'kick']]) {
  const tapShot = createMatch(1);
  tapShot.human.pos.x = x;
  tapShot.ball.pos.x = x + 0.75;
  pad.buttons[1].pressed = true;
  padControls.poll();
  pad.buttons[1].pressed = false;
  const tap = padControls.poll();
  assert.equal(tap.shootHeld, false);
  step(tapShot, tap, dt);
  assert.ok(tapShot.events.some(e => e.type === evType), `gamepad quick tap at x=${x} emits ${evType}`);
  padControls.clearActions();
  assert.equal(tap.shootReleased, false);
}

// A loose ball at the referee's feet stays on the turf.
const loose = createMatch(4);
const ref = loose.referee;
assert.ok(!loose.players.includes(ref));
assert.equal(loose.players.length, 10);
assert.ok(Math.abs(Math.hypot(ref.pos.x, ref.pos.z) - 8) < 0.01);
loose.ball.owner = null;
Object.assign(loose.ball.pos, ref.pos);
const restingBall = { ...loose.ball.pos };
step(loose, idle, dt);
assert.equal(loose.ball.owner, null);
assert.deepEqual(loose.ball.pos, restingBall);

// A pass travelling straight towards him makes him step sideways out of its path.
const lane = createMatch(5);
lane.referee.pos = { x: -8, z: -0.1 };
lane.ball.owner = null;
lane.ball.receiver = lane.human;
lane.ball.pos.x = -12;
lane.ball.vel.x = 14;
step(lane, idle, dt);
assert.equal(lane.referee.pos.x, -8);
assert.ok(lane.referee.pos.z < -0.2);

// Moving the referee against the ball carrier must never displace a player or the ball.
const normal = createMatch(9), overlap = createMatch(9);
for (let tick = 0; tick < 60; tick++) {
  overlap.referee.pos = { x: overlap.human.pos.x + 0.2, z: overlap.human.pos.z };
  step(normal, idle, dt);
  step(overlap, idle, dt);
  assert.deepEqual(overlap.players.map(p => p.pos), normal.players.map(p => p.pos));
  assert.deepEqual(overlap.ball.pos, normal.ball.pos);
}

// A casual controller chases the ball, passes occasionally and holds Shoot near goal.
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
  } else if (h.pos.x > m.pitch.length / 2 - 16) {   // 16 m out, on either pitch
    input.shootHeld = true;
  } else {
    input.passPressed = tick % 70 === 0 || tick % 50 === 0;
  }
  return input;
}

function playMatch(seed, firstTeam, controller, opts = {}) {
  const m = createMatch(seed, { prayers: false, ...opts });
  if (firstTeam === 1) kickoff(m, 1);
  let goals = 0;
  const shotGoals = [0, 0];
  for (let tick = 0; m.phase !== 'over' && tick < 60 * 300; tick++) {
    step(m, controller ? controller(m, tick) : null, dt);
    assert.notEqual(m.ball.owner, m.referee);
    assert.notEqual(m.ball.receiver, m.referee);
    assert.notEqual(m.human, m.referee);
    assert.ok(Number.isFinite(m.referee.pos.x) && Number.isFinite(m.referee.pos.z));
    if (m.phase === 'goal') assert.equal(m.referee.anim, 'celebrate');
    for (const e of m.events) if (e.type === 'goal') { goals++; if (e.fromShot) shotGoals[e.team]++; }
    assert.ok([m.ball.pos.x, m.ball.pos.y, m.ball.pos.z].every(Number.isFinite));
  }
  assert.equal(m.phase, 'over');
  assert.equal(m.referee.anim, 'idle');
  assert.equal(m.referee.speed, 0);
  assert.equal(m.score[0] + m.score[1], goals);
  return { score: m.score, stats: m.stats, shotGoals };
}

// Per mode: equal Normal AI sides score a sensible number of goals, evenly; a side playing at Easy strength
// still beats the Normal CPU now and then (the CPU is beatable, not a wall); Very easy loses clearly to Easy
// while still playing football and scoring occasionally; and the scripted casual player scores freely and
// converts far better against Very easy than against Easy.
for (const [size, seeds, band] of [[5, 24, [3, 6]], [3, 24, [3, 7]]]) {
  const equalScores = [], casualScores = [], easyScores = [];
  const veVsEasy = [], casualEasy = [], casualVeryEasy = [];
  for (let seed = 1; seed <= seeds; seed++) {
    // Each side gets the opening possession with exactly the same AI and seed.
    equalScores.push(playMatch(seed, 0, null, { size }).score, playMatch(seed, 1, null, { size }).score);
    casualScores.push(playMatch(seed, 0, casualInput, { size }).score);
    easyScores.push(playMatch(seed, 0, null, { size, ai: [AI_LEVELS.easy, AI_LEVELS.normal] }).score);
    veVsEasy.push(playMatch(seed, 0, null, { size, humans: [false, false], ai: [AI_LEVELS.veryEasy, AI_LEVELS.easy] }));
    casualEasy.push(playMatch(seed, 0, casualInput, { size, level: 'easy' }));
    casualVeryEasy.push(playMatch(seed, 0, casualInput, { size, level: 'veryEasy' }));
  }
  const totals = equalScores.map(([home, away]) => home + away);
  const average = totals.reduce((sum, goals) => sum + goals, 0) / totals.length;
  const inRange = totals.filter(goals => goals >= band[0] && goals <= band[1]).length;
  assert.ok(average >= band[0] && average <= band[1], `${size}v${size}: equal AI teams averaged ${average} goals`);
  assert.ok(inRange >= totals.length / 2, `${size}v${size}: only ${inRange}/${totals.length} matches had ${band[0]}–${band[1]} goals`);
  const homeGoals = equalScores.reduce((sum, [home]) => sum + home, 0);
  const homeShare = homeGoals / (average * totals.length);
  assert.ok(homeShare >= 0.4 && homeShare <= 0.6, `${size}v${size}: the home AI scored ${homeShare * 100}% of goals`);
  const record = (scores) => ['W', 'D', 'L'].map((_, i) => scores.filter(([a, b]) => Math.sign(b - a) === i - 1).length);
  const [ew, ed, el] = record(easyScores), [cw, cd, cl] = record(casualScores);
  const easyGoals = easyScores.reduce((s, [a]) => s + a, 0);
  assert.ok(el > ew && (ew + ed) >= easyScores.length / 6 && easyGoals > 0, `${size}v${size}: an Easy-strength side went ${ew}W ${ed}D ${el}L (${easyGoals} goals) against Normal`);

  const [veW, veD, veL] = record(veVsEasy.map(r => r.score));
  const veGoalsVsEasy = veVsEasy.reduce((s, r) => s + r.score[0], 0);
  const ezGoalsVsVe = veVsEasy.reduce((s, r) => s + r.score[1], 0);
  assert.ok(veL >= seeds * 0.75 && veW <= 2, `${size}v${size}: Very easy should lose clearly to Easy (got ${veW}W ${veD}D ${veL}L)`);
  assert.ok(veGoalsVsEasy > 0, `${size}v${size}: Very easy should still score occasionally against Easy`);

  const sumCasual = (runs) => {
    const [w, d, l] = record(runs.map(r => r.score));
    const goals = runs.reduce((s, r) => s + r.score[0], 0);
    const shotGoals = runs.reduce((s, r) => s + r.shotGoals[0], 0);
    const conceded = runs.reduce((s, r) => s + r.score[1], 0);
    const shots = runs.reduce((s, r) => s + r.stats[0].shots, 0);
    const onTarget = runs.reduce((s, r) => s + r.stats[0].onTarget, 0);
    const saves = runs.reduce((s, r) => s + r.stats[1].saves, 0);
    return { w, d, l, goals, shotGoals, conceded, shots, onTarget, saves, avg: goals / runs.length, conv: onTarget ? shotGoals / onTarget : 0 };
  };
  const ce = sumCasual(casualEasy), cve = sumCasual(casualVeryEasy);
  if (size === 5) {
    assert.ok(cve.avg >= 1.0, `5v5: casual averaged ${cve.avg.toFixed(2)} goals vs Very easy (need >= 1.0)`);
    assert.ok(cve.w >= seeds / 2, `5v5: casual won ${cve.w}/${seeds} vs Very easy (need >= ${seeds / 2})`);
  } else {
    assert.ok(cve.avg >= 1.5, `3v3: casual averaged ${cve.avg.toFixed(2)} goals vs Very easy (need >= 1.5)`);
  }
  assert.ok(cve.conceded > 0, `${size}v${size}: Very easy should still score occasionally against casual`);
  assert.ok(cve.saves > 0, `${size}v${size}: Very easy keeper should still make occasional saves`);
  assert.ok(cve.conv > ce.conv + 0.2, `${size}v${size}: on-target conversion vs Very easy (${(cve.conv * 100).toFixed(1)}%) should clearly beat Easy (${(ce.conv * 100).toFixed(1)}%)`);

  console.log(`${size}v${size}: equal AI teams averaged ${average.toFixed(2)} goals per match, with ${inRange}/${totals.length} in the ${band[0]}–${band[1]} range.`);
  console.log(`${size}v${size}: an Easy-strength side won ${ew}, drew ${ed} and lost ${el} against Normal; the scripted casual player went ${cw}W ${cd}D ${cl}L.`);
  console.log(`${size}v${size}: Very easy vs Easy: ${veW}W ${veD}D ${veL}L (${veGoalsVsEasy}:${ezGoalsVsVe}).`);
  console.log(`${size}v${size}: casual vs Easy: ${ce.w}W ${ce.d}D ${ce.l}L (${ce.avg.toFixed(2)} g/m, ${(ce.shots / seeds).toFixed(2)} sh/m, ${ce.shotGoals}/${ce.onTarget} OT = ${(ce.conv * 100).toFixed(1)}%) | vs Very easy: ${cve.w}W ${cve.d}D ${cve.l}L (${cve.avg.toFixed(2)} g/m, ${(cve.shots / seeds).toFixed(2)} sh/m, ${cve.shotGoals}/${cve.onTarget} OT = ${(cve.conv * 100).toFixed(1)}%, GK saves ${cve.saves}, CPU goals ${cve.conceded}).`);
}
