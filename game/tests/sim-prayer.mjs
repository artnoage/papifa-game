// Prayer mechanic unit tests (v4 Step 1):
// charge/drain timing, counts & mixes, no praying in goal/over, Jesus unstoppable & expiry,
// Mary shot/own-goal blocking & expiry, clash outcome & event, AI limits & human-side rule,
// independent local 2P praying, and prayers-disabled bit-identity.
import assert from 'node:assert/strict';
import { createMatch, step, kickoff, shoot, chip, choosePrayer, isGeorgeRider, tackle, slideTackle } from '../src/sim.js';
import { AI_LEVELS, BALL, PITCH, PLAYER, PRAYER } from '../src/config.js';

const dt = 1 / 60;
const idle = { move: { x: 0, z: 0 } };
const player = (m, team, slot) => m.players.find((p) => p.team === team && p.slot === slot);

function chargeToReady(m, team, inputBuilder = null) {
  const ticks = Math.round(PRAYER.chargeTime / dt) + 2;
  for (let i = 0; i < ticks && !m.prayers[team].ready; i++) {
    const inp = inputBuilder
      ? inputBuilder(i)
      : team === 0
        ? [{ ...idle, prayerHeld: true }, null]
        : [null, { ...idle, prayerHeld: true }];
    step(m, inp, dt);
  }
}

// 1. Charge timing, early release drain, ready persistence without timeout, and playing while charging.
{
  const m = createMatch(101);
  // Hold for 1.0 s -> half charged, not ready; pressing 1 or 2 early does nothing.
  for (let i = 0; i < 60; i++) step(m, { ...idle, move: { x: 1, z: 0 }, sprint: true, prayerHeld: true }, dt);
  assert.ok(m.prayers[0].charge > 0.45 && m.prayers[0].charge < 0.55, `1 s charge = ${m.prayers[0].charge}`);
  assert.equal(m.prayers[0].ready, false);
  assert.equal(m.prayers[0].charging, true);
  assert.ok(Math.hypot(m.human.vel.x, m.human.vel.z) > 4, 'human keeps running while charging prayer');

  step(m, { ...idle, prayerHeld: true, prayerJesus: true, prayerMary: true }, dt);
  assert.equal(m.prayers[0].active, null, 'cannot choose before crossbar is full');
  assert.equal(m.prayers[0].remaining, 2);
  assert.equal(m.events.some((e) => e.type === 'prayer'), false);

  // Release early -> drains back to 0 over ~0.5 s (from ~0.5 takes ~0.25 s).
  for (let i = 0; i < 6; i++) step(m, idle, dt);
  assert.ok(m.prayers[0].charge > 0.1 && m.prayers[0].charge < 0.4, `draining charge = ${m.prayers[0].charge}`);
  for (let i = 0; i < 30; i++) step(m, idle, dt);
  assert.equal(m.prayers[0].charge, 0, 'early release drains completely to 0');
  assert.equal(m.prayers[0].ready, false);

  // Hold full 2.0 s -> ready = true; stays ready indefinitely without spending a prayer.
  for (let i = 0; i < 120; i++) step(m, { ...idle, prayerHeld: true }, dt);
  assert.equal(m.prayers[0].ready, true, '2.0 s hold fills prayer');
  assert.equal(m.prayers[0].charge, 1);
  assert.equal(m.prayers[0].remaining, 2, 'ready does not consume a prayer');

  // Wait 20 s without holding -> still ready and unspent.
  for (let i = 0; i < 60 * 20; i++) step(m, idle, dt);
  assert.equal(m.prayers[0].ready, true, 'ready never times out');
  assert.equal(m.prayers[0].charge, 1);
  assert.equal(m.prayers[0].remaining, 2);
}

// 2. Counts: 2 slots per match; Jesus uses both, Mary and St George one each. Any legal mix, cannot charge
// while active, nothing once the slots are spent; with one slot left Jesus is refused and the prayer stays ready.
const COST = { jesus: 2, mary: 1, george: 1 };
for (const mix of [['jesus'], ['mary', 'mary'], ['george', 'mary'], ['mary', 'george'], ['mary', 'jesus', 'george']]) {
  const m = createMatch(200);
  // Keep opponents away so no goals interrupt the 15 s waits.
  for (const p of m.players) if (p.team === 1 && !p.isGK) p.pos = { x: 25, z: p.pos.z };
  let left = 2;
  for (let idx = 0; idx < mix.length; idx++) {
    const kind = mix[idx];
    if (!m.prayers[0].ready) chargeToReady(m, 0);
    assert.equal(m.prayers[0].ready, true);
    step(m, { ...idle, prayerJesus: kind === 'jesus', prayerMary: kind === 'mary', prayerGeorge: kind === 'george' }, dt);
    if (COST[kind] > left) {
      assert.equal(m.prayers[0].active, null, `mix ${mix.join('+')}[${idx}]: ${kind} refused with ${left} slot left`);
      assert.equal(m.prayers[0].ready, true, 'a refused choice keeps the prayer ready');
      assert.equal(m.prayers[0].remaining, left);
      continue;
    }
    left -= COST[kind];
    assert.equal(m.prayers[0].active, kind, `mix ${mix.join('+')}[${idx}] active`);
    assert.equal(m.prayers[0].remaining, left);
    assert.ok(m.prayers[0].timeLeft > PRAYER.duration - 0.1);
    const ev = m.events.find((e) => e.type === 'prayer' && e.team === 0);
    assert.deepEqual({ type: ev?.type, team: ev?.team, kind: ev?.kind, human: ev?.human }, { type: 'prayer', team: 0, kind, human: true });

    // Cannot start charging while prayer is active.
    for (let i = 0; i < 60; i++) step(m, { ...idle, prayerHeld: true }, dt);
    assert.equal(m.prayers[0].charge, 0, 'cannot charge while active');
    assert.equal(m.prayers[0].ready, false);
    // Expire active prayer after 15 s total.
    for (let i = 0; i < 60 * 15; i++) {
      if (m.phase === 'goal') kickoff(m, 0);
      step(m, idle, dt);
      if (m.prayers[0].active === null) break;
    }
    assert.equal(m.prayers[0].active, null, `${kind} expires after 15 s`);
    assert.equal(m.prayers[0].timeLeft, 0);
  }
  // Slots spent: holding never charges, choosing fails.
  assert.equal(m.prayers[0].remaining, 0);
  for (let i = 0; i < 150; i++) step(m, { ...idle, prayerHeld: true }, dt);
  assert.equal(m.prayers[0].charge, 0, 'no charging with 0 remaining');
  assert.equal(m.prayers[0].ready, false);
  step(m, { ...idle, prayerJesus: true }, dt);
  assert.equal(m.prayers[0].active, null, 'no 3rd prayer');
}

// 3. No praying during goal celebration or full time; ready survives kickoff while partial charge clears.
{
  const m = createMatch(301);
  // Goal phase blocks charging and choosing.
  m.phase = 'goal';
  m.phaseT = 2.0;
  for (let i = 0; i < 60; i++) step(m, { ...idle, prayerHeld: true }, dt);
  assert.equal(m.prayers[0].charge, 0, 'no charging during goal celebration');
  m.prayers[0].ready = true;
  m.prayers[0].charge = 1;
  step(m, { ...idle, prayerJesus: true }, dt);
  assert.equal(m.prayers[0].active, null, 'no choosing during goal celebration');
  assert.equal(m.prayers[0].remaining, 2);
  assert.equal(choosePrayer(m, 0, 'jesus'), false);

  // Ready survives kickoff, while partial charge clears on goal/kickoff.
  m.prayers[1].charge = 0.6;
  m.prayers[1].ready = false;
  kickoff(m, 0);
  assert.equal(m.prayers[0].ready, true, 'ready survives kickoff');
  assert.equal(m.prayers[1].charge, 0, 'partial charge clears on kickoff');

  // Full time blocks charging and choosing.
  m.clock = 0.001;
  step(m, idle, dt);
  assert.equal(m.phase, 'over');
  step(m, { ...idle, prayerJesus: true }, dt);
  assert.equal(m.prayers[0].active, null, 'no choosing at full time');
  assert.equal(choosePrayer(m, 0, 'jesus'), false);
  m.prayers[0].ready = false;
  m.prayers[0].charge = 0;
  for (let i = 0; i < 60; i++) step(m, { ...idle, prayerHeld: true }, dt);
  assert.equal(m.prayers[0].charge, 0, 'no charging at full time');
}

// 4. Jesus unstoppable: keeper on line, wall of defenders + sliding defender in lane, straight line,
// works for AI teammate, works from tight byline angle, works for chip, and expires after 15 s.
{
  const m = createMatch(401, { level: 'hard' });
  const HL = m.pitch.length / 2;
  const h = m.human;
  const gk = player(m, 1, 0);
  h.pos = { x: -4, z: 2 };
  m.ball.owner = h;
  m.ball.pos = { x: -3.25, y: BALL.radius, z: 2 };
  // Activate Jesus for team 0.
  m.prayers[0].ready = true;
  assert.equal(choosePrayer(m, 0, 'jesus'), true);
  assert.equal(m.prayers[0].active, 'jesus');

  // Put keeper and ALL 4 opposing defenders directly along the shot line toward the goal!
  gk.pos = { x: HL - 1.5, z: -2.5 };
  const defs = m.players.filter((p) => p.team === 1 && !p.isGK);
  defs.forEach((d, i) => {
    const frac = (i + 1) / 5;
    d.pos = { x: -3 + (HL + 3) * frac, z: 2 + (-2.8 - 2) * frac };
    d.vel = { x: 0, z: 0 };
  });
  m.rand = () => 0; // Even with best possible keeper save roll (0), Jesus cannot be saved.

  const startPos = { ...m.ball.pos };
  shoot(m, h, 0.5, -1); // Steer toward -z corner
  assert.equal(m.prayers[0].active, null, 'Jesus prayer consumed immediately on shot');
  assert.equal(m.prayers[0].timeLeft, 0);
  assert.equal(m.ball.shot?.jesus, true);

  const vel0 = { ...m.ball.vel };
  let scored = false, goalEv = null;
  for (let i = 0; i < 180 && !scored; i++) {
    step(m, idle, dt);
    if (m.ball.shot?.jesus && !m.ball.inNet) {
      // Verify straight-line velocity is unchanged (no gravity / drag / deflection).
      assert.ok(Math.abs(m.ball.vel.x - vel0.x) < 1e-6 && Math.abs(m.ball.vel.y - vel0.y) < 1e-6 && Math.abs(m.ball.vel.z - vel0.z) < 1e-6, 'straight line velocity');
      // Keep keeper trying to stand directly on the ball's path.
      gk.pos.z = m.ball.pos.z;
    }
    goalEv = m.events.find((e) => e.type === 'goal');
    if (goalEv) scored = true;
    assert.equal(m.events.some((e) => e.type === 'catch' || e.type === 'parry'), false, 'no keeper save on Jesus shot');
  }
  assert.ok(scored, 'Jesus shot scores through keeper and defenders');
  assert.equal(goalEv.team, 0);
  assert.equal(goalEv.jesus, true);
  assert.equal(goalEv.fromShot, true);
  assert.ok(startPos.x < 0);

  // Tight byline/corner angle Jesus shot + chip shot + AI teammate shot all score.
  for (const mode of ['byline', 'chip', 'teammate']) {
    const m2 = createMatch(410);
    const HL2 = m2.pitch.length / 2;
    const shooter = mode === 'teammate' ? player(m2, 0, 3) : m2.human;
    m2.prayers[0].ready = true;
    assert.equal(choosePrayer(m2, 0, 'jesus'), true);
    if (mode === 'byline') {
      shooter.pos = { x: HL2 - 0.5, z: 14 };
      m2.ball.owner = shooter;
      m2.ball.pos = { x: HL2 - 0.4, y: BALL.radius, z: 13.5 };
      shoot(m2, shooter, 0.8, 1);
    } else if (mode === 'chip') {
      shooter.pos = { x: 8, z: 0 };
      m2.ball.owner = shooter;
      m2.ball.pos = { x: 8.75, y: BALL.radius, z: 0 };
      chip(m2, shooter, 0.7, 1);
    } else {
      shooter.pos = { x: 6, z: -3 };
      m2.ball.owner = shooter;
      m2.ball.pos = { x: 6.75, y: BALL.radius, z: -3 };
      shoot(m2, shooter, 0.5, 0);
    }
    assert.equal(m2.prayers[0].active, null, `${mode}: Jesus consumed`);
    let g = false;
    for (let i = 0; i < 180 && !g; i++) {
      step(m2, idle, dt);
      g ||= m2.events.some((e) => e.type === 'goal' && e.team === 0 && e.jesus);
    }
    assert.ok(g, `${mode}: Jesus shot scores`);
  }

  // Jesus expires after 15 s if no shot is taken.
  const m3 = createMatch(420);
  m3.prayers[0].ready = true;
  assert.equal(choosePrayer(m3, 0, 'jesus'), true);
  // Keep ball away so no team 0 AI shoots.
  const opp = player(m3, 1, 0);
  for (let i = 0; i < 60 * 14.9; i++) {
    m3.ball.owner = opp; opp.pos = { x: 26, z: 0 }; opp.holdT = 0;
    step(m3, idle, dt);
  }
  assert.equal(m3.prayers[0].active, 'jesus', 'Jesus still active at 14.9 s');
  for (let i = 0; i < 12; i++) {
    m3.ball.owner = opp; opp.pos = { x: 26, z: 0 }; opp.holdT = 0;
    step(m3, idle, dt);
  }
  assert.equal(m3.prayers[0].active, null, 'Jesus expired at 15 s');
  // Next shot after expiry is normal (not Jesus).
  m3.ball.owner = m3.human; m3.human.pos = { x: 10, z: 0 }; m3.ball.pos = { x: 10.75, y: BALL.radius, z: 0 };
  shoot(m3, m3.human, 0.5);
  assert.ok(!m3.ball.shot?.jesus, 'shot after expiry is not a Jesus shot');
}

// 5. Mary blocks opponent shots (multiple, stays active full 15 s) and own goals at ~40% speed, then expires at 15 s.
{
  const m = createMatch(501);
  const HL = m.pitch.length / 2;
  m.prayers[1].ready = true;
  assert.equal(choosePrayer(m, 1, 'mary'), true);
  // Move team 1 keeper out of the way so the ball definitely hits the Mary barrier.
  player(m, 1, 0).pos = { x: HL - 4, z: 12 };
  for (const p of m.players) if (p !== player(m, 1, 0)) p.pos = { x: -10, z: p.pos.z };

  // Shot 1: opponent shot straight into Team 1's goal (+HL).
  m.ball.owner = null;
  m.ball.pos = { x: HL - 1.2, y: 0.9, z: 0.5 };
  m.ball.vel = { x: 25, y: 0, z: 2 };
  m.ball.shot = { team: 0, rolled: true, t: m.t };
  let blocked = false;
  for (let i = 0; i < 15 && !blocked; i++) {
    step(m, [idle, idle], dt);
    if (m.events.some((e) => e.type === 'maryBlock' && e.team === 1)) blocked = true;
  }
  assert.ok(blocked, 'Mary blocks opponent shot');
  assert.equal(m.score[0], 0, 'no goal scored against Mary');
  assert.ok(m.ball.vel.x < -7 && m.ball.vel.x > -13, `rebound vx ≈ -40% of 25 (${m.ball.vel.x.toFixed(2)})`);
  assert.equal(m.prayers[1].active, 'mary', 'blocking a shot does not end Mary');

  // Shot 2: a second shot is ALSO blocked by the same Mary prayer.
  m.ball.owner = null;
  m.ball.pos = { x: HL - 1.0, y: 0.6, z: -1.0 };
  m.ball.vel = { x: 20, y: 0, z: 0 };
  m.ball.shot = { team: 0, rolled: true, t: m.t };
  let blocked2 = false;
  for (let i = 0; i < 15 && !blocked2; i++) {
    step(m, [idle, idle], dt);
    if (m.events.some((e) => e.type === 'maryBlock' && e.team === 1)) blocked2 = true;
  }
  assert.ok(blocked2, 'Mary blocks second shot too');
  assert.equal(m.score[0], 0);
  assert.equal(m.prayers[1].active, 'mary');

  // Own goal attempt (non-shot ball kicked/passed into Team 1's own goal by Team 1): also blocked!
  m.ball.owner = null;
  m.ball.pos = { x: HL - 1.0, y: BALL.radius, z: 0 };
  m.ball.vel = { x: 15, y: 0, z: 0 };
  m.ball.shot = null;
  let blockedOwn = false;
  for (let i = 0; i < 15 && !blockedOwn; i++) {
    step(m, [idle, idle], dt);
    if (m.events.some((e) => e.type === 'maryBlock' && e.team === 1)) blockedOwn = true;
  }
  assert.ok(blockedOwn, 'Mary blocks own goals');
  assert.equal(m.score[0], 0);
  assert.equal(m.prayers[1].active, 'mary');

  // Let Mary expire after 15 s, then verify a shot scores cleanly.
  for (let i = 0; i < 60 * 15; i++) {
    m.ball.owner = null; m.ball.pos = { x: 0, y: BALL.radius, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    step(m, [idle, idle], dt);
    if (m.prayers[1].active === null) break;
  }
  assert.equal(m.prayers[1].active, null, 'Mary expires after 15 s');
  m.ball.owner = null;
  m.ball.pos = { x: HL - 0.5, y: 0.8, z: 0 };
  m.ball.vel = { x: 20, y: 0, z: 0 };
  m.ball.shot = { team: 0, rolled: true, t: m.t };
  let scoredAfter = false;
  for (let i = 0; i < 20 && !scoredAfter; i++) {
    step(m, [idle, idle], dt);
    scoredAfter ||= m.events.some((e) => e.type === 'goal' && e.team === 0);
  }
  assert.ok(scoredAfter, 'shot scores after Mary expires');
}

// 6. Clash: Jesus shot hits Mary-glowing goal (tested in both directions).
for (const atk of [0, 1]) {
  const def = 1 - atk;
  const m = createMatch(600 + atk, { humans: [true, true] });
  const HL = m.pitch.length / 2;
  const dir = atk === 0 ? 1 : -1;
  const shooter = player(m, atk, 4);
  const gk = player(m, def, 0);
  for (const p of m.players) if (p !== shooter && p !== gk) p.pos = { x: 0, z: p.pos.z };
  shooter.pos = { x: dir * 10, z: 1 };
  gk.pos = { x: dir * (HL - 2.0), z: 0 };
  m.ball.owner = shooter;
  m.ball.pos = { x: dir * 10.75, y: BALL.radius, z: 1 };

  m.prayers[atk].ready = true;
  m.prayers[def].ready = true;
  assert.equal(choosePrayer(m, atk, 'jesus'), true);
  assert.equal(choosePrayer(m, def, 'mary'), true);
  shoot(m, shooter, 0.7, 1);

  let clashEv = null;
  for (let i = 0; i < 120 && !clashEv; i++) {
    step(m, [idle, idle], dt);
    clashEv = m.events.find((e) => e.type === 'clash');
    assert.equal(m.events.some((e) => e.type === 'goal'), false, 'no goal on clash');
  }
  assert.ok(clashEv, `clash event emitted (atk=${atk})`);
  assert.equal(clashEv.attacker, atk);
  assert.equal(clashEv.defender, def);
  assert.equal(m.prayers[atk].active, null, 'attacker Jesus ended on clash');
  assert.equal(m.prayers[def].active, null, 'defender Mary ended on clash');
  assert.equal(m.prayers[def].timeLeft, 0);
  assert.deepEqual(m.score, [0, 0], 'no goal scored on clash');
  // Ball drops gently onto goal line (zero horizontal rebound into the box).
  assert.equal(m.ball.vel.x, 0, 'no rebound vx into box');
  assert.equal(m.ball.vel.z, 0, 'no rebound vz into box');
  assert.ok(Math.abs(m.ball.pos.x - dir * (HL - BALL.radius - 0.12)) < 0.05, 'ball placed on goal line');
  // Ball holds at the clash point for ~0.6 s (pickup blocked), then drops gently onto the goal line for defending keeper.
  for (let i = 0; i < 32; i++) {
    step(m, [idle, idle], dt);
    assert.equal(m.ball.owner, null, `pickup blocked during clash hold (tick ${i}, atk=${atk})`);
    assert.equal(m.events.some((e) => e.type === 'goal'), false, 'no goal during clash hold');
  }
  let gathered = false;
  for (let i = 0; i < 90 && !gathered; i++) {
    step(m, [idle, idle], dt);
    assert.equal(m.events.some((e) => e.type === 'goal'), false, 'no goal while ball drops');
    if (m.ball.owner === gk) gathered = true;
  }
  assert.ok(gathered, `defending keeper gathers dropped clash ball after hold (atk=${atk})`);
}

// 7. AI prayer limits (<= 2 per match across all levels), Very easy never unfair with Mary,
// and AI NEVER prays on behalf of a human side.
{
  const levelUsage = {};
  for (const level of ['veryEasy', 'easy', 'normal', 'hard', 'veryHard']) {
    let usedTotal = 0, veUnfairMary = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const m = createMatch(700 + seed, { level });
      const counts = [0, 0], slots = [0, 0];
      while (m.phase !== 'over') {
        step(m, null, dt);
        for (const e of m.events) {
          if (e.type === 'prayer') {
            counts[e.team]++;
            slots[e.team] += PRAYER.cost?.[e.kind] ?? 1;
            assert.equal(e.human, false);
            if (level === 'veryEasy' && e.kind === 'mary') {
              const dir = e.team === 0 ? 1 : -1;
              const oppThreat = m.ball.owner?.team === 1 - e.team && m.ball.pos.x * dir < 0;
              if (oppThreat) veUnfairMary++;
            }
          }
        }
      }
      for (const t of [0, 1]) {
        assert.ok(counts[t] <= PRAYER.maxPerMatch, `${level} team ${t} used ${counts[t]} > 2`);
        assert.equal(m.prayers[t].remaining, PRAYER.maxPerMatch - slots[t], 'remaining counts slots (Jesus uses two)');
      }
      usedTotal += counts[0] + counts[1];
    }
    levelUsage[level] = usedTotal / 16;
    if (level === 'veryEasy') assert.equal(veUnfairMary, 0, 'Very easy never triggers Mary while opponent threatens its goal');
  }
  assert.ok(levelUsage.hard > levelUsage.veryEasy, `hard (${levelUsage.hard.toFixed(2)}) prays more than veryEasy (${levelUsage.veryEasy.toFixed(2)})`);
  assert.ok(levelUsage.hard >= 1.0, `hard actually prays (${levelUsage.hard.toFixed(2)}/team)`);
  assert.ok(levelUsage.veryEasy < 1.0, `veryEasy prays rarely (${levelUsage.veryEasy.toFixed(2)}/team)`);

  // Human side: AI teammates NEVER pray for the human (test both team 0 human and team 1 human).
  for (const humanTeam of [0, 1]) {
    const aiTeam = 1 - humanTeam;
    let aiPrayers = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const m = createMatch(800 + seed, { level: 'hard', humans: [humanTeam === 0, humanTeam === 1] });
      while (m.phase !== 'over') {
        const inp = humanTeam === 0 ? [idle, null] : [null, idle];
        step(m, inp, dt);
        for (const e of m.events) {
          if (e.type === 'prayer') {
            assert.notEqual(e.team, humanTeam, `AI must never pray for human team ${humanTeam}`);
            if (e.team === aiTeam) aiPrayers++;
          }
        }
        assert.equal(m.prayers[humanTeam].charge, 0, 'human prayer charge stays 0');
        assert.equal(m.prayers[humanTeam].remaining, 2, 'human remaining stays 2');
      }
    }
    assert.ok(aiPrayers > 0, `AI team ${aiTeam} still prays against human team ${humanTeam} (${aiPrayers})`);
  }
}

// 8. Two humans praying independently (local 2P / online).
{
  const m = createMatch(901, { humans: [true, true] });
  // Team 0 holds for 1 s, Team 1 idle -> only Team 0 charges.
  for (let i = 0; i < 60; i++) step(m, [{ ...idle, prayerHeld: true }, idle], dt);
  assert.ok(m.prayers[0].charge > 0.45 && m.prayers[1].charge === 0, 'team 0 charges independently');
  // Both hold for 1.1 s -> Team 0 reaches ready, Team 1 at ~0.55.
  for (let i = 0; i < 66; i++) step(m, [{ ...idle, prayerHeld: true }, { ...idle, prayerHeld: true }], dt);
  assert.equal(m.prayers[0].ready, true);
  assert.ok(m.prayers[1].charge > 0.5 && !m.prayers[1].ready);
  // Team 0 chooses Jesus while Team 1 finishes charging -> Team 1 unaffected.
  step(m, [{ ...idle, prayerJesus: true }, { ...idle, prayerHeld: true }], dt);
  assert.equal(m.prayers[0].active, 'jesus');
  assert.equal(m.prayers[1].active, null);
  for (let i = 0; i < 60; i++) step(m, [idle, { ...idle, prayerHeld: true }], dt);
  assert.equal(m.prayers[1].ready, true, 'team 1 reaches ready while team 0 has Jesus active');
  step(m, [idle, { ...idle, prayerMary: true }], dt);
  assert.equal(m.prayers[0].active, 'jesus');
  assert.equal(m.prayers[1].active, 'mary');
  assert.equal(m.prayers[0].remaining, 0, 'Jesus used both of team 0\'s slots');
  assert.equal(m.prayers[1].remaining, 1);
}

// 9. Prayers disabled ({ prayers: false }): zero charging/praying and deterministic state.
{
  const m = createMatch(950, { prayers: false });
  assert.equal(m.prayersEnabled, false);
  for (let i = 0; i < 150; i++) step(m, { ...idle, prayerHeld: true }, dt);
  assert.equal(m.prayers[0].charge, 0);
  assert.equal(m.prayers[0].ready, false);
  assert.equal(choosePrayer(m, 0, 'jesus'), false);
  const aiM = createMatch(951, { level: 'hard', prayers: false });
  while (aiM.phase !== 'over') {
    step(aiM, null, dt);
    assert.equal(aiM.events.some((e) => e.type === 'prayer' || e.type === 'clash' || e.type === 'maryBlock'), false);
  }
  assert.equal(aiM.prayers[0].remaining, 2);
  assert.equal(aiM.prayers[1].remaining, 2);
}

// 10. St George prayer (Task H): controlled priest rides at +30% top speed, AI chooses carrier else most advanced outfielder,
// ball control/kicks work normally, standing & slide tackles knock rider off early, expires cleanly at 15 s, AI uses at ~Jesus rate.
{
  // 10a. +30% top speed check (human controlled priest) + ball control & shooting work normally.
  const mBase = createMatch(1001, { level: 'normal' });
  const mRide = createMatch(1001, { level: 'normal' });
  for (const m of [mBase, mRide]) {
    const h = m.human;
    h.pos = { x: -12, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0; h.stamina = 1;
    const oppGk = m.players.find((p) => p.team === 1 && p.isGK);
    oppGk.pos = { x: 28, z: 0 }; oppGk.vel = { x: 0, z: 0 };
    m.ball.owner = oppGk; m.ball.pos = { x: 27.2, y: BALL.radius, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of m.players) if (p !== h && p !== oppGk) { p.pos = { x: -24, z: -12 + p.team * 24 }; p.vel = { x: 0, z: 0 }; }
  }
  const rider = mRide.human;
  mRide.prayers[0].ready = true;
  step(mRide, { ...idle, prayerGeorge: true }, dt);
  assert.equal(mRide.prayers[0].active, 'george');
  assert.equal(mRide.prayers[0].riderSlot, mRide.players.indexOf(rider));
  assert.equal(isGeorgeRider(mRide, rider), true);
  assert.equal(mRide.prayers[0].remaining, 1);
  const gEv = mRide.events.find((e) => e.type === 'prayer' && e.team === 0);
  assert.deepEqual({ type: gEv?.type, team: gEv?.team, kind: gEv?.kind, human: gEv?.human }, { type: 'prayer', team: 0, kind: 'george', human: true });

  // Sprint straight ahead for 0.8 s -> mounted speed should be ~1.30x normal top speed!
  for (let i = 0; i < 48; i++) {
    step(mBase, { ...idle, move: { x: 1, z: 0 }, sprint: true }, dt);
    step(mRide, { ...idle, move: { x: 1, z: 0 }, sprint: true }, dt);
  }
  assert.equal(mRide.human, rider, 'human stays on the mounted priest while sprinting');
  const ratio = rider.speed / mBase.human.speed;
  assert.ok(ratio > 1.27 && ratio < 1.33, `St George top-speed ratio = ${ratio.toFixed(3)} (expected ~1.30)`);
  // Non-mounted teammates do NOT get the +30% speed boost.
  assert.equal(isGeorgeRider(mRide, player(mRide, 0, 1)), false);

  // Dribbling & shooting work normally while riding.
  mRide.ball.owner = rider;
  mRide.ball.pos = { x: rider.pos.x + 0.75, y: BALL.radius, z: rider.pos.z };
  assert.equal(shoot(mRide, rider, 0.6, 0), true, 'rider can shoot normally');
  assert.equal(mRide.prayers[0].active, 'george', 'shooting does NOT consume St George');

  // 10b. Standing tackle landing on rider knocks him off early.
  {
    const mt = createMatch(1002);
    const rider = mt.human;
    const def = player(mt, 1, 1);
    rider.pos = { x: 0, z: 0 }; rider.facing = 0;
    def.pos = { x: 1.1, z: 0 }; def.facing = Math.PI;
    mt.ball.owner = rider; mt.ball.pos = { x: 0.75, y: BALL.radius, z: 0 };
    mt.prayers[0].ready = true;
    assert.equal(choosePrayer(mt, 0, 'george'), true);
    assert.equal(isGeorgeRider(mt, rider), true);
    mt.rand = () => 0; // force standing tackle to land
    tackle(mt, def);
    assert.equal(mt.prayers[0].active, null, 'standing tackle knocks rider off and ends St George early');
    assert.equal(mt.prayers[0].timeLeft, 0);
    assert.equal(mt.prayers[0].riderSlot, -1);
    assert.equal(isGeorgeRider(mt, rider), false);
  }

  // 10c. Slide tackle landing on rider knocks him off early.
  {
    const ms = createMatch(1003);
    const rider = ms.human;
    const def = player(ms, 1, 1);
    for (const p of ms.players) if (p !== rider && p !== def) p.pos = { x: -20, z: p.pos.z };
    rider.pos = { x: 0, z: 0 }; rider.vel = { x: 0, z: 0 }; rider.facing = 0;
    def.pos = { x: 2.2, z: 0 }; def.vel = { x: 0, z: 0 }; def.facing = Math.PI;
    ms.ball.owner = rider; ms.ball.pos = { x: 0.75, y: BALL.radius, z: 0 };
    ms.prayers[0].ready = true;
    assert.equal(choosePrayer(ms, 0, 'george'), true);
    assert.equal(isGeorgeRider(ms, rider), true);
    ms.rand = () => 0; // force slide tackle to land
    assert.equal(slideTackle(ms, def, { x: -1, z: 0 }), true);
    for (let i = 0; i < 30 && ms.prayers[0].active === 'george'; i++) {
      step(ms, [idle, idle], dt);
    }
    assert.equal(ms.prayers[0].active, null, 'slide tackle knocks rider off and ends St George early');
    assert.equal(ms.prayers[0].riderSlot, -1);
    assert.equal(isGeorgeRider(ms, rider), false);
  }

  // 10d. AI rider selection: ball carrier (if non-GK), else most advanced outfield priest.
  {
    const ma = createMatch(1004, { humans: [false, false] });
    const df = player(ma, 1, 1);
    const fw = player(ma, 1, 4);
    const ml = player(ma, 1, 2);
    // Team 1 attacks -x, so lowest x is most advanced!
    df.pos = { x: 10, z: 0 };
    ml.pos = { x: -15, z: -4 };
    fw.pos = { x: -5, z: 2 };
    ma.ball.owner = df; // defender carries ball -> carrier wins!
    ma.prayers[1].ready = true;
    assert.equal(choosePrayer(ma, 1, 'george'), true);
    assert.equal(isGeorgeRider(ma, df), true, 'AI mounts ball carrier first');

    // Without ball (or opp has ball): most advanced outfielder (ml at x=-15) wins!
    ma.prayers[1].active = null; ma.prayers[1].timeLeft = 0; ma.prayers[1].riderSlot = -1;
    ma.prayers[1].ready = true;
    ma.ball.owner = player(ma, 0, 4);
    assert.equal(choosePrayer(ma, 1, 'george'), true);
    assert.equal(isGeorgeRider(ma, ml), true, 'AI mounts most advanced outfielder when not carrying');
  }

  // 10e. Expiry after 15 s clears active and riderSlot cleanly.
  {
    const me = createMatch(1005);
    for (const p of me.players) if (p.team === 1 && !p.isGK) p.pos = { x: 25, z: p.pos.z };
    me.prayers[0].ready = true;
    assert.equal(choosePrayer(me, 0, 'george'), true);
    for (let i = 0; i < 60 * 15 + 5; i++) {
      if (me.phase === 'goal') kickoff(me, 0);
      step(me, idle, dt);
      if (me.prayers[0].active === null) break;
    }
    assert.equal(me.prayers[0].active, null);
    assert.equal(me.prayers[0].riderSlot, -1);
    assert.equal(isGeorgeRider(me, me.human), false);
  }

  // 10f. AI uses St George across Hard/Normal matches at a rate comparable to Jesus.
  {
    let jesusCount = 0, georgeCount = 0, maryCount = 0;
    for (let seed = 1; seed <= 16; seed++) {
      const m = createMatch(1100 + seed, { level: 'hard' });
      while (m.phase !== 'over') {
        step(m, null, dt);
        for (const e of m.events) {
          if (e.type === 'prayer') {
            if (e.kind === 'jesus') jesusCount++;
            else if (e.kind === 'george') georgeCount++;
            else if (e.kind === 'mary') maryCount++;
          }
        }
      }
    }
    assert.ok(georgeCount > 0, `AI actually uses St George (jesus=${jesusCount}, george=${georgeCount}, mary=${maryCount})`);
    assert.ok(jesusCount > 0 && maryCount > 0, `AI still uses Jesus & Mary (jesus=${jesusCount}, george=${georgeCount}, mary=${maryCount})`);
  }
}

console.log('All prayer simulation unit tests passed.');
