// Match simulation: pure logic, no rendering. Vectors are plain {x, z} (ground) plus ball.y for height.
// Team 0 attacks +x, team 1 attacks -x. Slot 0 of each team is the goalkeeper.
import { PITCH, PLAYER, BALL, MATCH, PRAYER, ROSTER, FORMATIONS, SQUADS, pitchFor, REFEREE, AI_LEVELS, resolveLevel, STAMINA } from './config.js';
import { teamStats, recordEvent } from './stats.js';

// Half length and width of the current match's pitch. createMatch, kickoff and step set them from m.pitch
// (one match is simulated at a time); goal and box sizes don't depend on the mode.
let HL = PITCH.length / 2, HW = PITCH.width / 2;
const GW = PITCH.goalWidth / 2;
function usePitch(m) { HL = m.pitch.length / 2; HW = m.pitch.width / 2; }
const ROLL_DECEL = 6;           // m/s² on the ground: linear, so pass distances are predictable
// Measured across 100 AI-vs-AI matches (easy..veryHard): held shot speeds span 22.5..31.8 m/s (median 26.5).
// Catching and holding a shot >= STRONG_CATCH_SPEED qualifies as a strong catch for the keeper cameo.
export const STRONG_CATCH_SPEED = 26.0;
const REF_TRAIL = 6, REF_LATERAL = Math.sqrt(8 ** 2 - REF_TRAIL ** 2);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hyp = Math.hypot;
const attackDir = (team) => (team === 0 ? 1 : -1);
const angleWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function setDifficulty(m, level, overrides) {
  m.level = resolveLevel(level, 'normal');
  m.ai = [0, 1].map(team => ({ ...AI_LEVELS[m.level], ...overrides?.[team] }));
}

function createPrayerState() {
  return {
    remaining: PRAYER.maxPerMatch,
    charge: 0,
    ready: false,
    charging: false,
    active: null,
    timeLeft: 0,
    riderSlot: -1,
    ai: { cd: 0, checkT: 0, intent: null, readyT: 0 },
  };
}

const isJesusActive = (m, team) => !!(m.prayersEnabled && m.prayers?.[team]?.active === 'jesus');
const isMaryActive = (m, team) => !!(m.prayersEnabled && m.prayers?.[team]?.active === 'mary');
export const isGeorgeRider = (m, p) => !!(
  p && m.prayersEnabled
  && m.prayers?.[p.team]?.active === 'george'
  && m.prayers[p.team].riderSlot >= 0
  && m.players[m.prayers[p.team].riderSlot] === p
);

function pickGeorgeRider(m, team) {
  const h = activeHuman(m, team);
  if (h) return m.players.indexOf(h);
  const owner = m.ball.owner;
  if (owner && owner.team === team && !owner.isGK) return m.players.indexOf(owner);
  const dir = attackDir(team);
  let best = null, bestX = -Infinity;
  for (const q of teamOf(m, team)) {
    if (q.isGK) continue;
    const prog = q.pos.x * dir;
    if (prog > bestX) { bestX = prog; best = q; }
  }
  return best ? m.players.indexOf(best) : -1;
}

function dismountGeorge(m, p) {
  if (!isGeorgeRider(m, p)) return false;
  const pr = m.prayers[p.team];
  pr.active = null;
  pr.timeLeft = 0;
  pr.riderSlot = -1;
  return true;
}

export function choosePrayer(m, team, kind) {
  if (!m.prayersEnabled || m.phase !== 'play') return false;
  if (kind !== 'jesus' && kind !== 'mary' && kind !== 'george') return false;
  const pr = m.prayers?.[team];
  const cost = PRAYER.cost?.[kind] ?? 1;
  if (!pr || !pr.ready || pr.remaining < cost || pr.active !== null) return false;
  let riderSlot = -1;
  if (kind === 'george') {
    riderSlot = pickGeorgeRider(m, team);
    if (riderSlot < 0) return false;
  }
  pr.remaining -= cost;
  pr.charge = 0;
  pr.ready = false;
  pr.charging = false;
  pr.active = kind;
  pr.timeLeft = PRAYER.duration;
  pr.riderSlot = riderSlot;
  pr.ai.intent = null;
  pr.ai.readyT = 0;
  m.events.push({ type: 'prayer', team, kind, human: !!activeHuman(m, team) });
  return true;
}

export function createMatch(seed = Date.now(), opts = {}) {
  const size = opts.size === 3 ? 3 : 5;
  const players = [];
  for (let team = 0; team < 2; team++) {
    SQUADS[size].forEach((slot) => {
      const info = ROSTER[slot];
      players.push({
        team, slot, info, isGK: slot === 0,
        pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, facing: 0,
        anim: 'idle', actionT: 0, stun: 0, tackleCd: 0, aiT: 0, holdT: 0,
        knockCd: 0, burstT: 0, oneTwoT: -1, recvT: -9, highRecvT: -9, jesusShotT: -9, spot: null, spotT: 0, drib: null, slideT: -1, slideDone: true, stamina: 1,
      });
    });
  }
  const m = {
    seed: seed | 0,
    players,
    referee: { info: REFEREE, team: null, pos: { x: 0, z: 0 }, vel: { x: 0, z: 0 }, speed: 0, facing: 0, anim: 'idle', attack: 1 },
    ball: { pos: { x: 0, y: BALL.radius, z: 0 }, vel: { x: 0, y: 0, z: 0 }, owner: null, receiver: null, shot: null, lastTouch: null, noPickup: new Map() },
    score: [0, 0], stats: [teamStats(), teamStats()], clock: MATCH.seconds, t: 0,
    phase: 'play', phaseT: 0, events: [], rand: mulberry32(seed),
    // One controlled priest per human side (null for an AI side). m.human, m.charge and m.charging stay
    // as aliases for team 0, so single-player callers keep working.
    humanTeams: [opts.humans?.[0] ?? true, opts.humans?.[1] ?? false], humans: [null, null],
    charges: [0, 0], chargings: [false, false],
    prayersEnabled: opts.prayers ?? true,
    prayers: [createPrayerState(), createPrayerState()],
    pressT: [-1, -1], lastTeam: null,
    size, pitch: pitchFor(size), field: opts.field ?? 'courtyard',
  };
  Object.defineProperties(m, {
    human: { get() { return this.humans[0]; }, set(v) { this.humans[0] = v; } },
    charge: { get() { return this.charges[0]; }, set(v) { this.charges[0] = v; } },
    charging: { get() { return this.chargings[0]; }, set(v) { this.chargings[0] = v; } },
  });
  usePitch(m);
  setDifficulty(m, opts.level, opts.ai);
  kickoff(m, 0);
  return m;
}

// Active controlled priest for side t during step() (respects null input in AI-vs-AI runs).
const activeHuman = (m, team) => (m._stepHumans ? m._stepHumans[team] : m.humans[team]);
export const isHuman = (m, p) => !!p && m.humans[p.team] === p;
function give(m, p) { if (p && m.humanTeams[p.team]) m.humans[p.team] = p; }
// Make a side human-controlled (or AI again) mid-match, e.g. when a second player joins.
export function setHumanTeam(m, team, on) {
  m.humanTeams[team] = !!on;
  m.humans[team] = null;
  if (on) {
    const b = m.ball;
    m.humans[team] = b.owner?.team === team ? b.owner
      : teamOf(m, team).filter((q) => !q.isGK).reduce((a, q) => (hyp(q.pos.x - b.pos.x, q.pos.z - b.pos.z) < hyp(a.pos.x - b.pos.x, a.pos.z - b.pos.z) ? q : a));
  }
}

export const teamOf = (m, team) => m.players.filter((p) => p.team === team);
const facingDir = (p) => ({ x: Math.cos(p.facing), z: Math.sin(p.facing) });

// Formation spot stretched along the pitch from the 56 x 34 base pitch (the keeper stays 2.5 m off his line).
// The spacing across stays as written: spreading the team over a wider pitch pulled attacks out to the flanks.
function basePos(p, m) {
  const f = FORMATIONS[m?.size ?? 5][p.slot], d = attackDir(p.team);
  const x = p.isGK ? -(HL - 2.5) : (f.x * HL) / (PITCH.length / 2);
  return { x: x * d, z: f.z * d };
}

export function kickoff(m, team) {
  usePitch(m);
  for (const p of m.players) {
    const b = basePos(p, m);
    p.pos = { x: clamp(b.x, -HL + 0.6, HL - 0.6), z: b.z };
    if (!p.isGK && Math.sign(p.pos.x) === attackDir(p.team)) p.pos.x = -attackDir(p.team) * 1.5; // own half
    p.vel = { x: 0, z: 0 };
    p.facing = p.team === 0 ? 0 : Math.PI;
    p.anim = 'idle'; p.actionT = 0; p.stun = 0;
    p.slideDone = true; p.slideT = -1;                 // a slide in progress ends at the restart
  }
  const taker = m.players.find((p) => p.team === team && p.slot === 4);
  const opp = m.players.find((p) => p.team !== team && p.slot === 4);
  taker.pos = { x: -attackDir(team) * 0.8, z: 0 };
  opp.pos = { x: attackDir(team) * 9, z: 0 };
  const b = m.ball;
  b.pos = { x: 0, y: BALL.radius, z: 0 }; b.vel = { x: 0, y: 0, z: 0 };
  b.owner = taker; b.receiver = null; b.passer = null; b.shot = null; b.lastTouch = taker; b.inNet = false; b.clashDrop = false; b.noPickup.clear();
  if (m.prayersEnabled && m.prayers) {
    for (const pr of m.prayers) {
      pr.charging = false;
      if (!pr.ready) { pr.charge = 0; pr.ai.intent = null; }
    }
  }
  m.referee.attack = attackDir(team);
  m.referee.pos = { x: -REF_TRAIL * m.referee.attack, z: -REF_LATERAL };
  stopReferee(m, 'idle');
  for (const t of [0, 1]) m.humans[t] = m.humanTeams[t] ? m.players.find((p) => p.team === t && p.slot === 4) : null;
  give(m, taker);
  m.phase = 'play'; m.lastTeam = team;
  for (const p of m.players) { p.spot = null; p.drib = null; p.oneTwoT = -1; p.burstT = 0; p.highRecvT = -9; }
  m.events.push({ type: 'kickoff', team });
}

function stopReferee(m, anim) {
  const ref = m.referee;
  ref.vel.x = 0;
  ref.vel.z = 0;
  ref.speed = 0;
  ref.anim = anim;
  ref.facing = Math.atan2(m.ball.pos.z - ref.pos.z, m.ball.pos.x - ref.pos.x);
}

function followPlay(m, dt) {
  const ref = m.referee, ball = m.ball;
  if (ball.owner) ref.attack = attackDir(ball.owner.team);
  let dx = ref.attack, dz = 0;
  const ballSpeed = hyp(ball.vel.x, ball.vel.z);
  if (!ball.owner && ballSpeed > 2) {
    dx = ball.vel.x / ballSpeed;
    dz = ball.vel.z / ballSpeed;
  }

  // Follow on the current side of the pass, switching sides near a boundary
  // only when the other diagonal leaves more room on the pitch.
  const baseX = ball.pos.x - REF_TRAIL * dx, baseZ = ball.pos.z - REF_TRAIL * dz;
  const relX = ref.pos.x - ball.pos.x, relZ = ref.pos.z - ball.pos.z;
  const lateral = relZ * dx - relX * dz;
  let side = lateral >= 0 ? 1 : -1;
  const offsetX = -dz * REF_LATERAL, offsetZ = dx * REF_LATERAL;
  const overflow = (s) => Math.max(0, Math.abs(baseX + s * offsetX) - (HL - 1))
                        + Math.max(0, Math.abs(baseZ + s * offsetZ) - (HW - 1));
  if (overflow(-side) + 0.5 < overflow(side)) side *= -1;
  let tx = baseX + side * offsetX, tz = baseZ + side * offsetZ;
  // A newly released pass can point straight at him. Step clear first.
  if (ball.receiver && relX * dx + relZ * dz > 0 && Math.abs(lateral) < 2) {
    tx = ref.pos.x - side * dz * 3;
    tz = ref.pos.z + side * dx * 3;
  }
  tx = clamp(tx, -HL + 1, HL - 1);
  tz = clamp(tz, -HW + 1, HW - 1);
  const vx = tx - ref.pos.x, vz = tz - ref.pos.z, distance = hyp(vx, vz);
  if (distance < 0.08) { stopReferee(m, 'idle'); return; }

  ref.speed = Math.min(PLAYER.sprint, 3 * distance, distance / dt);
  ref.vel.x = ref.speed * vx / distance;
  ref.vel.z = ref.speed * vz / distance;
  ref.pos.x += ref.vel.x * dt;
  ref.pos.z += ref.vel.z * dt;
  ref.anim = ref.speed > 5.6 ? 'sprint' : ref.speed > 0.8 ? 'run' : 'idle';
  const facing = ref.anim === 'idle' ? Math.atan2(ball.pos.z - ref.pos.z, ball.pos.x - ref.pos.x) : Math.atan2(vz, vx);
  ref.facing += clamp(angleWrap(facing - ref.facing), -PLAYER.turnRate * dt, PLAYER.turnRate * dt);
}

// ---------- actions ----------
function release(m, p, vx, vy, vz, anim, kind, jesus = false) {
  const b = m.ball;
  b.owner = null;
  b.lastTouch = p;
  b.inNet = false;
  b.vel = { x: vx, y: vy, z: vz };
  b.pos.y = Math.max(b.pos.y, BALL.radius);
  b.noPickup.set(p, m.t + 0.35);
  p.anim = anim; p.actionT = anim === 'kick' ? 0.45 : 0.38;
  p.moveKind = kind ?? (anim === 'kick' ? 'shot' : 'pass');   // which move this priest is playing (renderer/replay pick the clip from it)
  b.passer = anim === 'pass' && p.moveKind !== 'clear' ? p : null;
  const ev = { type: anim, team: p.team, kind: p.moveKind, human: isHuman(m, p) };
  if (jesus) ev.jesus = true;
  recordEvent(m, ev);
}

function laneBlocked(m, p, mate) {
  let pen = 0;
  const ax = mate.pos.x - p.pos.x, az = mate.pos.z - p.pos.z, L2 = ax * ax + az * az;
  for (const o of m.players) {
    if (o.team === p.team) continue;
    const t = clamp(((o.pos.x - p.pos.x) * ax + (o.pos.z - p.pos.z) * az) / L2, 0, 1);
    const d = hyp(p.pos.x + ax * t - o.pos.x, p.pos.z + az * t - o.pos.z);
    if (d < 1.6) pen += (1.6 - d) * 0.6;
  }
  return pen;
}

function bestMate(m, p, dir, hasDir = false) {
  let best = null, bestScore = -Infinity;
  const dl = hyp(dir.x, dir.z) || 1;
  for (const q of teamOf(m, p.team)) {
    if (q === p) continue;
    const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z, d = hyp(dx, dz);
    if (d < 3) continue;
    const dot = (dx * dir.x + dz * dir.z) / (d * dl);
    if (hasDir && dot < -0.17) continue;              // clear stick input never picks a team-mate > 100° behind it
    const progress = ((q.pos.x - p.pos.x) * attackDir(p.team)) / 50;
    const gkPen = q.isGK ? (d > 20 ? 1.8 : 0.8) : 0;
    const score = dot * 2 - d / 35 - laneBlocked(m, p, q) + progress - gkPen;
    if (score > bestScore) { bestScore = score; best = q; }
  }
  return best;
}

export function pass(m, p, dir, kind) {
  if (m.ball.owner !== p) return false;
  const rawLen = dir ? hyp(dir.x, dir.z) : 0;
  const hasDir = rawLen > 0.3;
  if (!dir || rawLen < 0.1) dir = facingDir(p);
  const dl = hyp(dir.x, dir.z);
  for (const q of teamOf(m, p.team)) {               // a give-and-go runner gets the return ball in his path
    if (q === p || !(q.oneTwoT > m.t)) continue;
    const dx = q.pos.x - p.pos.x, dz = q.pos.z - p.pos.z, d = hyp(dx, dz) || 1;
    if ((dx * dir.x + dz * dir.z) / (d * dl) > 0.2) { const tt = throughTarget(m, p, q); if (tt) return throughTo(m, p, q, tt); }
  }
  const mate = bestMate(m, p, dir, hasDir);
  if (!mate) { const f = hasDir ? unit(dir.x, dir.z) : facingDir(p); release(m, p, f.x * 14, 0, f.z * 14, 'pass', kind); return true; }
  return passTo(m, p, mate, kind);
}

export function passTo(m, p, mate, kind) {
  const lead = { x: mate.pos.x + mate.vel.x * 0.45, z: mate.pos.z + mate.vel.z * 0.45 };
  const dx = lead.x - m.ball.pos.x, dz = lead.z - m.ball.pos.z, d = hyp(dx, dz) || 1;
  if (d > 20 && !mate.isGK) {         // lofted pass: lands on the receiver (never loft back to your own keeper)
    const h = 14 + d * 0.2, T = d / h;
    release(m, p, (dx / d) * h, (BALL.gravity * T) / 2, (dz / d) * h, 'pass', kind ?? 'lofted');
  } else {
    const s = groundSpeed(d, mate.isGK && d > 20 ? 9 : 7);      // firm ground pass (~9 m/s) to a distant keeper, ~7 m/s otherwise
    release(m, p, (dx / d) * s, 0, (dz / d) * s, 'pass', kind);
  }
  m.ball.receiver = mate; m.ball.noPickup.set(p, m.t + 0.8);   // the passer can't run onto his own pass
  give(m, mate);                                      // control follows the ball (keeper included)
  return true;
}

function throughTo(m, p, q, tt) {
  const b = m.ball, dx = tt.target.x - b.pos.x, dz = tt.target.z - b.pos.z, d = hyp(dx, dz) || 1;
  release(m, p, (dx / d) * tt.speed, 0, (dz / d) * tt.speed, 'pass', 'through');
  b.receiver = q; q.oneTwoT = -1; b.noPickup.set(p, m.t + 0.8);
  give(m, q);
  return true;
}

// Through ball: into space ahead of the runner the stick points at; to feet if nobody can reach one.
export function throughPass(m, p, dir) {
  if (m.ball.owner !== p) return false;
  if (!dir || hyp(dir.x, dir.z) < 0.1) dir = { x: attackDir(p.team), z: 0 };
  const dl = hyp(dir.x, dir.z);
  let best = null;
  for (const q of teamOf(m, p.team)) {
    const tt = throughTarget(m, p, q);
    if (!tt) continue;
    const dx = tt.target.x - p.pos.x, dz = tt.target.z - p.pos.z, d = hyp(dx, dz) || 1;
    const v = tt.value + ((dx * dir.x + dz * dir.z) / (d * dl)) * 0.5;
    if (!best || v > best.v) best = { q, tt, v };
  }
  return best ? throughTo(m, p, best.q, best.tt) : pass(m, p, dir);
}

// Give-and-go: pass, then burst forward; the next pass in his direction comes back into his path.
export function oneTwo(m, p, dir) {
  if (!pass(m, p, dir, 'onetwo')) return false;
  p.oneTwoT = m.t + 2.5;
  return true;
}

// Knock-on: push the ball ahead and sprint onto it. Faster, but anyone can take it.
export function knockOn(m, p, dir) {
  const b = m.ball;
  if (b.owner !== p || p.knockCd > 0) return false;
  if (!dir || hyp(dir.x, dir.z) < 0.1) dir = facingDir(p);
  const u = unit(dir.x, dir.z), along = Math.max(5, p.vel.x * u.x + p.vel.z * u.z), s = along + 4.5;
  b.owner = null; b.lastTouch = p; b.vel = { x: u.x * s, y: 0, z: u.z * s };
  b.noPickup.set(p, m.t + 0.45); b.receiver = p;      // ~1 s of open ball before he runs onto it
  p.knockCd = 2.0; p.burstT = 1.6; p.moveKind = 'knock'; p.knockT = m.t; p.stamina = Math.max(0, p.stamina - STAMINA.knock);
  m.events.push({ type: 'knock', team: p.team, human: isHuman(m, p) });
  return true;
}

function isVolleyKick(m, p) {
  return m.ball.pos.y > BALL.radius + 0.25 || (m.t - (p.highRecvT ?? -9) <= 0.65);
}

// Unstoppable Jesus prayer shot: straight line to a point inside the opponent's goal frame.
function fireJesusShot(m, p, charge = 0.6, steerZ = 0, aimZ = null) {
  const pr = m.prayers[p.team];
  pr.active = null;
  pr.timeLeft = 0;
  pr.riderSlot = -1;
  const d0 = attackDir(p.team), gx = d0 * (HL + BALL.radius + 0.35);
  const keeper = m.players.find((q) => q.team !== p.team && q.isGK);
  const b = m.ball;
  const bx = b.pos.x, by = Math.max(b.pos.y, BALL.radius), bz = b.pos.z;
  const shotDist = hyp(d0 * HL - bx, bz);
  const volley = isVolleyKick(m, p);
  const side = Math.abs(steerZ) > 0.2 ? Math.sign(steerZ) : (keeper.pos.z > 0 ? -1 : 1);
  const tightByline = Math.abs(bz) > GW - 0.85 && (d0 * HL - d0 * bx) < 3;
  const tz = aimZ !== null
    ? clamp(aimZ, -(GW - 0.85), GW - 0.85)
    : (tightByline ? Math.sign(bz) * (GW - 0.85) : side * (GW - 0.85));
  const ty = clamp(0.9 + 0.7 * clamp(charge ?? 0.5, 0, 1), 0.75, PITCH.goalHeight - BALL.radius - 0.35);
  const dx = gx - bx, dy = ty - by, dz = tz - bz;
  const dist = Math.hypot(dx, dy, dz) || 1;
  const s = Math.max(PRAYER.jesusSpeed, (26 + 10 * clamp(charge ?? 0.5, 0, 1)) * p.info.power);
  release(m, p, (dx / dist) * s, (dy / dist) * s, (dz / dist) * s, 'kick', 'shot', true);
  p.jesusShotT = m.t;
  b.receiver = null;
  b.shot = {
    team: p.team,
    rolled: true,
    jesus: true,
    shooter: p,
    dist: shotDist,
    volley,
    target: { x: gx, y: ty, z: tz },
    t: m.t,
  };
  return true;
}

// Chip: a lob that drops under the bar. Beats a keeper who has come out; an on-line keeper can still claim it.
export function chip(m, p, charge = 0.6, steerZ = 0, aimZ = null) {
  if (m.ball.owner !== p) return false;
  if (isJesusActive(m, p.team)) return fireJesusShot(m, p, charge, steerZ, aimZ);
  const gx = attackDir(p.team) * HL;
  const keeper = m.players.find((q) => q.team !== p.team && q.isGK);
  const side = Math.abs(steerZ) > 0.2 ? Math.sign(steerZ) : (keeper.pos.z > 0 ? -1 : 1);
  const tz = aimZ !== null ? clamp(aimZ, -(GW - 1.3), GW - 1.3) : side * (GW - 1.3);
  const b = m.ball, dx = gx - b.pos.x, dz = tz - b.pos.z, d = hyp(dx, dz);
  const shotDist = hyp(gx - b.pos.x, b.pos.z);
  const volley = isVolleyKick(m, p);
  const T = 0.75 + d * 0.03 + (1 - charge) * 0.15;
  const long = Math.max(0, d - 16);                         // beyond 16 m a chip gets hard to place
  const ang = Math.atan2(dz, dx) + (m.rand() - 0.5) * (0.02 + d / 600 + long * 0.014);
  const h = (d / T) * (1 + (BALL.airDrag * T) / 2) * (0.97 + m.rand() * 0.06);
  const vy = (1.7 + (m.rand() - 0.5) * (0.8 + long * 0.12) - BALL.radius + 0.5 * BALL.gravity * T * T) / T;
  release(m, p, Math.cos(ang) * h, vy, Math.sin(ang) * h, 'kick', 'chip');
  b.shot = { team: p.team, rolled: false, chip: true, shooter: p, dist: shotDist, volley, t: m.t };
  return true;
}

// A keeper's punt (human keeper, left click): a lofted kick towards dir, 22 m on a tap up to ~47 m held.
export function punt(m, p, dir, charge = 0.5) {
  if (m.ball.owner !== p) return false;
  if (!dir || hyp(dir.x, dir.z) < 0.1) dir = { x: attackDir(p.team), z: 0 };
  const u = unit(dir.x, dir.z), d = 22 + 25 * clamp(charge, 0, 1), h = 14 + d * 0.2, T = d / h;
  release(m, p, u.x * h, (BALL.gravity * T) / 2, u.z * h, 'pass', 'lofted');
  m.ball.noPickup.set(p, m.t + 0.8);
  return true;
}

// Defending: the nearest free teammate also presses the carrier for a moment.
export function callPress(m, team = 0) { m.pressT[team] = m.t + 1.2; }

// Assisted shot: aims at the corner away from the keeper (or the side the player steers to).
export function shoot(m, p, charge, steerZ = 0, aimZ = null) {
  if (m.ball.owner !== p) return;
  if (isJesusActive(m, p.team)) return fireJesusShot(m, p, charge, steerZ, aimZ);
  const d0 = attackDir(p.team), gx = d0 * (HL + 0.5);
  const keeper = m.players.find((q) => q.team !== p.team && q.isGK);
  let side = Math.abs(steerZ) > 0.2 ? Math.sign(steerZ) : (keeper.pos.z > 0 ? -1 : 1);
  const tz = aimZ !== null ? clamp(aimZ, -(GW - 0.75), GW - 0.75) : side * (GW - 0.75);   // a mouse aim is exact, but always on frame
  const b = m.ball, dx = gx - b.pos.x, dz = tz - b.pos.z, d = hyp(dx, dz);
  const shotDist = hyp(d0 * HL - b.pos.x, b.pos.z);
  const volley = isVolleyKick(m, p);
  const err = (m.rand() - 0.5) * (0.03 + d / 700 + charge * 0.05);
  const ang = Math.atan2(dz, dx) + err;
  const s = (17 + 15 * charge) * p.info.power;
  let ty = 0.35 + 1.5 * charge * charge;
  if (charge > 0.93) ty += (charge - 0.93) * 30;          // over-hit: sails over the bar
  const T = d / s, vy = (ty - BALL.radius + 0.5 * BALL.gravity * T * T) / T;
  release(m, p, Math.cos(ang) * s, vy, Math.sin(ang) * s, 'kick');
  b.shot = { team: p.team, rolled: false, shooter: p, dist: shotDist, volley };
  return true;
}

// ---------- mouse aim ----------
// Where across the goal mouth a shot aimed through the cursor would cross the goal line (assisted: the
// caller clamps it onto the frame). Aiming backwards or sideways just picks that side of the goal.
function goalLineZ(m, p, aim) {
  const b = m.ball.pos, gx = attackDir(p.team) * HL, ax = aim.x - b.x;
  if (ax * attackDir(p.team) < 0.5) return Math.sign(aim.z - b.z) * GW;
  return b.z + ((aim.z - b.z) * (gx - b.x)) / ax;
}
// Pass to the team-mate nearest the cursor (a blocked lane counts against him).
export function passToAim(m, p, aim, kind) {
  if (m.ball.owner !== p) return false;
  let best = null, bd = Infinity;
  for (const q of teamOf(m, p.team)) {
    if (q === p) continue;
    const d = hyp(q.pos.x - aim.x, q.pos.z - aim.z) + laneBlocked(m, p, q) * 3 + (q.isGK ? 6 : 0);
    if (d < bd) { bd = d; best = q; }
  }
  if (!best) return false;
  if (best.oneTwoT > m.t) { const tt = throughTarget(m, p, best); if (tt) return throughTo(m, p, best, tt); }   // give-and-go return
  return passTo(m, p, best, kind);
}
// Through ball into the space at the cursor, for the team-mate who gets there first.
export function throughToAim(m, p, aim) {
  if (m.ball.owner !== p) return false;
  const pt = { x: clamp(aim.x, -HL + 1.5, HL - 1.5), z: clamp(aim.z, -HW + 1.5, HW - 1.5) };
  let best = null, bt = Infinity;
  for (const q of teamOf(m, p.team)) {
    if (q === p || q.isGK) continue;
    const t = hyp(q.pos.x - pt.x, q.pos.z - pt.z) / (PLAYER.sprint * q.info.speed);
    if (t < bt) { bt = t; best = q; }
  }
  if (!best) return false;
  const d = hyp(pt.x - m.ball.pos.x, pt.z - m.ball.pos.z);
  return throughTo(m, p, best, { target: pt, speed: groundSpeed(d, 3.5) });
}
// Switch in a direction (right click towards the cursor, Q or the pad's switch button with the stick or
// movement keys): the closest team-mate within 60° of that direction, best aligned first, keeper included.
// With no direction (or nobody that way) it's the priest nearest the ball.
export function switchInDirection(m, dir, team = 0) {
  const h = m.humans[team], L = dir ? hyp(dir.x, dir.z) : 0;
  if (!h) return;
  if (L < 0.1) return switchHuman(m, team);
  let best = null, bs = Infinity;
  for (const q of teamOf(m, h.team)) {
    if (q === h) continue;
    const vx = q.pos.x - h.pos.x, vz = q.pos.z - h.pos.z, d = hyp(vx, vz) || 1;
    const cos = (vx * dir.x + vz * dir.z) / (d * L);
    if (cos < 0.5) continue;
    const score = d * (1 + (1 - cos) * 3);
    if (score < bs) { bs = score; best = q; }
  }
  if (best) m.humans[team] = best; else switchHuman(m, team);
}
// (kept for callers that pass a point: the priest nearest it)
export function switchToAim(m, aim, team = 0) {
  let best = null, bd = Infinity;
  for (const q of teamOf(m, team)) {
    if (q === m.humans[team]) continue;                        // the keeper too: right-click him to take him over
    const d = hyp(q.pos.x - aim.x, q.pos.z - aim.z);
    if (d < bd) { bd = d; best = q; }
  }
  if (best) m.humans[team] = best;
}

// ---------- slide tackle ----------
// Old-arcade slide: a burst along the slide direction that the slider can't steer, slowing to a stop
// over ~3 m; his leading boot (~1 m ahead of his body) strips the carrier or pokes a loose ball away.
// Hit or miss, he then has to get up off the grass (risk and reward). The clip ('slide', 1.0 s) has the
// hip on the turf at 0.17 s and the slide from 0.2 to 0.55 s; the sim's slide spans the same window.
export const SLIDE = { minD: 1.9, maxD: 4.5, speed: 9.5, launch: 0.12, decel: 17, reach: 1.0, clip: 1.0, upHit: 0.25, upMiss: 0.45 };
export function slideTackle(m, p, dir) {
  if (p.tackleCd > 0 || p.stun > 0 || !p.slideDone || m.ball.owner === p) return false;   // not while still sliding
  const L = hyp(dir.x, dir.z) || 1;
  p.slideDir = { x: dir.x / L, z: dir.z / L };
  const v = Math.max(SLIDE.speed, hyp(p.vel.x, p.vel.z) + 2);
  p.vel = { x: p.slideDir.x * v, z: p.slideDir.z * v };
  p.facing = Math.atan2(p.slideDir.z, p.slideDir.x);
  p.slideT = 0; p.slideHit = false; p.slideDone = false;
  p.tackleCd = 1.8; p.anim = 'slide'; p.actionT = SLIDE.clip; p.stamina = Math.max(0, p.stamina - STAMINA.slide);
  m.events.push({ type: 'tackle', kind: 'slide', team: p.team, human: isHuman(m, p) });
  return true;
}
// Tackle button without the ball: a standing tackle up close; a slide at the ball from further out,
// or whenever he's sprinting.
export function tackleOrSlide(m, p, sprint) {
  const b = m.ball, c = b.owner, aim = c && c.team !== p.team ? c.pos : !c ? b.pos : null;
  const d = aim ? hyp(aim.x - p.pos.x, aim.z - p.pos.z) : Infinity;
  if (aim && d <= SLIDE.minD && !(sprint && d > 1.2)) return tackle(m, p);
  if (aim && d <= SLIDE.maxD) {                         // assisted: slide at where the ball will be
    const lead = { x: b.pos.x + b.vel.x * 0.2 - p.pos.x, z: b.pos.z + b.vel.z * 0.2 - p.pos.z };
    return slideTackle(m, p, lead);
  }
  if (sprint && hyp(p.vel.x, p.vel.z) > PLAYER.speed) return slideTackle(m, p, facingDir(p));
  return tackle(m, p);
}
// One tick of a slide: momentum, contact, then getting up.
function slideStep(m, p, dt) {
  p.slideT += dt;
  const sp = hyp(p.vel.x, p.vel.z);
  if (p.slideT > SLIDE.launch && sp > 0) {
    const ns = Math.max(0, sp - SLIDE.decel * dt);
    p.vel.x *= ns / sp; p.vel.z *= ns / sp;
  }
  p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
  const b = m.ball, foot = { x: p.pos.x + p.slideDir.x * SLIDE.reach, z: p.pos.z + p.slideDir.z * SLIDE.reach };
  if (!p.slideHit && p.slideT > 0.1 && sp > 2) {
    const c = b.owner;
    if (c && c.team !== p.team && !(c.isGK && inOwnBox(c)) && hyp(c.pos.x - foot.x, c.pos.z - foot.z) < 1.1) {
      p.slideHit = true;                                // one go at him
      const behind = (c.vel.x * p.slideDir.x + c.vel.z * p.slideDir.z) > 2 && (c.pos.x - p.pos.x) * p.slideDir.x + (c.pos.z - p.pos.z) * p.slideDir.z > 0;
      const ah = activeHuman(m, p.team);
      const tMul = ah === p ? 1 : (knobsFor(m, p.team, ah).tackle ?? 1);
      const baseChance = clamp(0.8 * p.info.tackle - (behind ? 0.3 : 0), 0.15, 0.92);
      const chance = tMul === 1 ? baseChance : clamp(baseChance * tMul, 0.1, 0.92);
      if (m.rand() < chance) {
        const side = (m.rand() - 0.5) * 4;
        b.owner = null;
        b.vel = { x: p.slideDir.x * 6 - p.slideDir.z * side, y: 0.6, z: p.slideDir.z * 6 + p.slideDir.x * side };
        b.receiver = null; b.noPickup.set(c, m.t + 0.7); b.noPickup.set(p, m.t + 0.5);
        c.stun = 0.9; c.anim = 'stunned'; c.actionT = 0.9;      // taken off his feet
        dismountGeorge(m, c);
        m.lastTeam = p.team;
        b.lastTouch = p;
        recordEvent(m, { type: 'steal', team: p.team, kind: 'slide' });
      }
    } else if (!c && !b.shot?.jesus && b.pos.y < 0.8 && hyp(b.pos.x - foot.x, b.pos.z - foot.z) < 0.8) {
      p.slideHit = true;                                // a loose ball gets poked on
      b.vel = { x: p.slideDir.x * 7, y: 0.4, z: p.slideDir.z * 7 }; b.receiver = null; b.noPickup.set(p, m.t + 0.5);
      m.lastTeam = p.team;
      b.lastTouch = p;
    }
  }
  if (sp <= 0.05 && !p.slideDone) {                     // stopped: get up (longer after a miss)
    p.slideDone = true; p.vel = { x: 0, z: 0 };
    p.stun = p.slideHit ? SLIDE.upHit : SLIDE.upMiss;
  }
}

export function tackle(m, p) {
  if (p.tackleCd > 0 || p.stun > 0) return;
  p.tackleCd = 0.9; p.anim = 'tackle'; p.actionT = 0.72;
  const c = m.ball.owner;
  if (!c || c.team === p.team || (c.isGK && inOwnBox(c))) return;   // the ball is in the keeper's hands
  const d = hyp(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
  if (d > 1.9) return;
  const ah = activeHuman(m, p.team);
  const tMul = ah === p ? 1 : (knobsFor(m, p.team, ah).tackle ?? 1);
  const baseChance = clamp(0.55 * p.info.tackle - (c.isGK ? 0.3 : 0), 0.1, 0.9);
  const chance = tMul === 1 ? baseChance : clamp(baseChance * tMul, 0.08, 0.9);
  if (m.rand() < chance) {
    const f = facingDir(p);
    m.ball.owner = null;
    m.ball.vel = { x: f.x * 4.5, y: 0, z: f.z * 4.5 };
    m.ball.noPickup.set(c, m.t + 0.6);
    c.stun = 0.7; c.anim = 'stunned'; c.actionT = 0.7;
    dismountGeorge(m, c);
    m.lastTeam = p.team;
    m.ball.lastTouch = p;
    recordEvent(m, { type: 'steal', team: p.team });
  } else {
    p.stun = 0.35;
  }
}

export function switchHuman(m, team = 0) {
  if (!m.humanTeams[team]) return;
  const b = m.ball.pos;
  let best = null, bd = Infinity;
  const ballInBox = Math.abs(b.x - ownGoal(team).x) < PITCH.boxDepth + 2 && Math.abs(b.z) < PITCH.boxWidth / 2 + 2;
  for (const q of teamOf(m, team)) {
    if (q === m.humans[team] || (q.isGK && !ballInBox)) continue;   // the keeper when the ball is in (or by) our box
    const d = hyp(q.pos.x - b.x, q.pos.z - b.z);
    if (d < bd) { bd = d; best = q; }
  }
  if (best) m.humans[team] = best;
}

// ---------- AI ----------
// Layered like most football AI, kept arcade-small:
//   team plan (who presses, covers, marks, supports) -> per-player target -> steering in step().
// On the ball every option gets a utility score (shot, chip, each pass, each through ball, dribble, knock-on)
// and the best one wins, with a little per-team noise. Off the ball, supporters pick open spots on a short timer.
function nearestTo(list, pt) {
  let best = null, bd = Infinity;
  for (const q of list) { const d = hyp(q.pos.x - pt.x, q.pos.z - pt.z); if (d < bd) { bd = d; best = q; } }
  return [best, bd];
}
const unit = (x, z) => { const L = hyp(x, z) || 1; return { x: x / L, z: z / L }; };
const inPitch = (pt, margin) => Math.abs(pt.x) < HL - margin && Math.abs(pt.z) < HW - margin;
const ownGoal = (team) => ({ x: -attackDir(team) * HL, z: 0 });
// A keeper's hands protect the ball only inside his own box (a human keeper may dribble out of it).
const inOwnBox = (p) => (p.pos.x - ownGoal(p.team).x) * attackDir(p.team) < PITCH.boxDepth && Math.abs(p.pos.z) < PITCH.boxWidth / 2;

// Angle of the goal mouth seen from pt, for the goal `team` attacks.
function goalAngle(team, pt) {
  const dx = Math.abs(attackDir(team) * HL - pt.x);
  if (dx < 0.3) return 0;
  return Math.abs(Math.atan2(GW - pt.z, dx) - Math.atan2(-GW - pt.z, dx));
}

// How good a spot is for the attacking team, 0..1: progress up the pitch plus a view of goal.
function spotValue(team, pt) {
  const prog = clamp((pt.x * attackDir(team) + HL) / (2 * HL), 0, 1);
  return 0.45 * prog + 0.55 * clamp(goalAngle(team, pt) / 0.9, 0, 1);
}

function pressureAt(m, team, pt) {
  let d = Infinity;
  for (const o of m.players) if (o.team !== team) d = Math.min(d, hyp(o.pos.x - pt.x, o.pos.z - pt.z));
  return d;
}

// Chance-like safety of a ball travelling a->b at average speed vAvg. An opponent threatens the lane
// when he can reach some point of it before the ball does. Lofted balls only risk the two ends.
function laneSafety(m, team, a, b, vAvg, lofted = false) {
  const ax = b.x - a.x, az = b.z - a.z, L = hyp(ax, az) || 1;
  let safe = 1;
  for (const o of m.players) {
    if (o.team === team || o.stun > 0) continue;
    const t = clamp(((o.pos.x - a.x) * ax + (o.pos.z - a.z) * az) / (L * L), 0, 1);
    if (lofted && t > 0.15 && t < 0.85) continue;
    const px = a.x + ax * t, pz = a.z + az * t;
    const reach = Math.max(0, hyp(px - o.pos.x, pz - o.pos.z) - (o.isGK ? 1.4 : 0.9));
    const margin = (reach / (PLAYER.sprint * o.info.speed) + 0.2) - (L * t) / vAvg;
    safe *= clamp(0.5 + margin * 1.7, 0.03, 1);
  }
  return safe;
}

// Distance from the nearest opponent to the segment a->b (opponents frozen; used where they must stand off).
function laneClearance(m, team, a, b) {
  const ax = b.x - a.x, az = b.z - a.z, L2 = ax * ax + az * az || 1;
  let d = Infinity;
  for (const o of m.players) {
    if (o.team === team) continue;
    const t = clamp(((o.pos.x - a.x) * ax + (o.pos.z - a.z) * az) / L2, 0, 1);
    d = Math.min(d, hyp(a.x + ax * t - o.pos.x, a.z + az * t - o.pos.z));
  }
  return d;
}

// Where along the ball's path can p first meet it? (ground projection; air drag approximated)
function intercept(m, p) {
  const b = m.ball, sp = hyp(b.vel.x, b.vel.z);
  if (sp < 0.3) return { x: b.pos.x, z: b.pos.z };
  const u = { x: b.vel.x / sp, z: b.vel.z / sp };
  const grounded = b.pos.y <= BALL.radius + 0.05 && Math.abs(b.vel.y) < 0.5;
  const stopAt = grounded ? (sp * sp) / (2 * ROLL_DECEL) : Infinity;
  const top = PLAYER.sprint * p.info.speed;
  let pt = null;
  for (let t = 0; t <= 3; t += 0.08) {
    const travel = grounded ? Math.min(stopAt, sp * t - 0.5 * ROLL_DECEL * t * t) : sp * t * (1 - 0.075 * t);
    pt = { x: clamp(b.pos.x + u.x * travel, -HL + 0.5, HL - 0.5), z: clamp(b.pos.z + u.z * travel, -HW + 0.5, HW - 0.5) };
    // A ball still above head height there can't be met: don't run under a lofted ball and let it sail over.
    if (!grounded && b.pos.y + b.vel.y * t - 0.5 * BALL.gravity * t * t > 2.0) continue;
    if (hyp(pt.x - p.pos.x, pt.z - p.pos.z) - 0.7 <= top * (t + 0.05)) return pt;
  }
  return pt;
}

// Chance that a driven shot from the ball's spot goes in. The distance curve is fitted to measured
// AI-vs-AI conversion in this sim (about 40% inside 10 m, 12% at 15 m, 3% from 18 m); the keeper's
// position, the shooting angle and defenders in the lane scale it from there.
function shotQuality(m, p) {
  const team = p.team, gx = attackDir(team) * HL, b = m.ball.pos;
  const d = hyp(gx - b.x, b.z);
  if (d > 24 || Math.abs(b.z) > 14) return 0;
  const keeper = m.players.find((q) => q.team !== team && q.isGK);
  const tz = (keeper.pos.z > 0 ? -1 : 1) * (GW - 0.75);
  const base = (0.45 * p.info.power) / (1 + Math.exp((d - 12.5) / 2.2));
  const gap = Math.abs(keeper.pos.z - tz);                           // how far the keeper must travel
  const keeperF = clamp(0.55 + gap * 0.15, 0.55, 1.3);
  let block = 1;
  const ax = gx - b.x, az = tz - b.z, L2 = ax * ax + az * az;
  for (const o of m.players) {
    if (o.team === team || o.isGK || o.stun > 0) continue;
    const t = ((o.pos.x - b.x) * ax + (o.pos.z - b.z) * az) / L2;
    if (t < 0.03 || t > 0.97) continue;
    const dl = hyp(b.x + ax * t - o.pos.x, b.z + az * t - o.pos.z);
    if (dl < 1.3) block *= 0.3 + 0.7 * (dl / 1.3);
  }
  return base * keeperF * block * clamp(goalAngle(team, b) / 0.3, 0, 1);
}

// A chip only pays when the keeper has come off his line.
function chipQuality(m, p) {
  const team = p.team, gx = attackDir(team) * HL, b = m.ball.pos, d = hyp(gx - b.x, b.z);
  if (d < 8 || d > 26 || Math.abs(b.z) > 12) return 0;
  const keeper = m.players.find((q) => q.team !== team && q.isGK);
  const depth = Math.abs(gx - keeper.pos.x);
  if (keeper === m.ball.owner || hyp(keeper.pos.x - b.x, keeper.pos.z - b.z) < 2.5) return 0;
  return clamp((depth - 2.2) / 3, 0, 1) * clamp(1.15 - d / 30, 0, 1) * 0.85;
}

// What losing the ball here costs: little in their half, a lot in front of our own goal.
function lossCost(team, pt) {
  const own = 1 - clamp((pt.x * attackDir(team) + HL) / (2 * HL), 0, 1);
  return 0.3 + 1.2 * own * own;
}

// Ground pass speed so it arrives at vEnd after d metres.
const groundSpeed = (d, vEnd) => Math.sqrt(vEnd * vEnd + 2 * ROLL_DECEL * d);

// Best through-ball target for runner q: space ahead of him he can reach as the ball arrives.
function throughTarget(m, p, q) {
  if (q.isGK || q === p) return null;
  const dir = attackDir(p.team), b = m.ball.pos;
  let best = null;
  for (const lead of [5, 8, 11]) {
    const run = unit(dir, -q.pos.z * 0.03 + (q.oneTwoT > m.t ? 0 : q.vel.z * 0.02));
    const T = { x: q.pos.x + run.x * lead, z: q.pos.z + run.z * lead };
    if (!inPitch(T, 2) || (T.x - b.x) * dir < 2) continue;
    const d = hyp(T.x - b.x, T.z - b.z), s = groundSpeed(d, 3.5);
    if (s > 24) continue;
    const tBall = (s - 3.5) / ROLL_DECEL;
    const tRun = lead / (PLAYER.sprint * q.info.speed * 0.95) + 0.15;
    if (tRun > tBall + 0.3) continue;
    const safety = laneSafety(m, p.team, b, T, (s + 3.5) / 2);
    const v = safety * spotValue(p.team, T) * 1.05 - (1 - safety) * lossCost(p.team, b) + (q.oneTwoT > m.t ? 0.12 : 0);
    if (!best || v > best.value) best = { target: T, speed: s, value: v, safety };
  }
  return best;
}

function passTarget(m, p, q) {
  const lead = { x: q.pos.x + q.vel.x * 0.45, z: q.pos.z + q.vel.z * 0.45 };
  const b = m.ball.pos, d = hyp(lead.x - b.x, lead.z - b.z);
  const lofted = d > 20 && !q.isGK;
  const vEnd = q.isGK && d > 20 ? 9 : 7;
  const vAvg = lofted ? 14 + d * 0.2 : (groundSpeed(d, vEnd) + vEnd) / 2;
  const safety = laneSafety(m, p.team, b, lead, vAvg, lofted) * (lofted ? 0.85 : 1);
  const press = clamp((3 - pressureAt(m, p.team, lead)) / 3, 0, 1);
  const back = Math.max(0, (p.pos.x - q.pos.x) * attackDir(p.team)) / 40;   // mild dislike of going backwards
  const value = safety * spotValue(p.team, lead) * (1 - press * 0.3) - (1 - safety) * lossCost(p.team, b) - back * 0.3
    - (q.isGK ? 0.25 : 0) + (q.oneTwoT > m.t ? 0.12 : 0);
  return { target: lead, value, safety };
}

// Best dribble direction: space along the path and the value of where it leads.
function dribbleOption(m, p) {
  const dir = attackDir(p.team);
  let best = null;
  for (let i = -4; i <= 4; i++) {
    const a = (i / 4) * 1.4, u = { x: Math.cos(a) * dir, z: Math.sin(a) };
    const end = { x: p.pos.x + u.x * 5, z: p.pos.z + u.z * 5 };
    if (!inPitch(end, 1.5)) continue;
    let space = Infinity;
    for (const o of m.players) {
      if (o.team === p.team || o.stun > 0) continue;
      const t = clamp((o.pos.x - p.pos.x) * u.x + (o.pos.z - p.pos.z) * u.z, 0, 9);
      space = Math.min(space, hyp(p.pos.x + u.x * t - o.pos.x, p.pos.z + u.z * t - o.pos.z) + t * 0.12);
    }
    const safe = clamp((space - 0.8) / 3, 0, 1);
    const v = spotValue(p.team, end) * (0.35 + 0.65 * safe) - (1 - safe) * 0.5 * lossCost(p.team, end);
    if (!best || v > best.value) best = { dir: u, value: v, space };
  }
  return best ?? { dir: { x: dir, z: 0 }, value: 0, space: 0 };
}

const SHOT_MIN = 0.18, SHOT_W = 2.2;   // default shot threshold (levels override it) and shot-vs-pass weighting
// The on-ball decision. Returns a movement target; may perform an action as a side effect.
function carrierThink(m, p, dt, knobs) {
  p.aiT -= dt;
  const [, oppD] = nearestTo(teamOf(m, 1 - p.team), p.pos);
  if (p.aiT > 0 && p.drib) return carry(p);
  p.aiT = knobs.reaction * (0.75 + m.rand() * 0.5);
  const noise = () => (m.rand() - 0.5) * 2 * knobs.noise;
  const settled = m.t - (p.recvT ?? -9) > 0.3 || oppD < 2.2;
  const opts = [];
  const drib = dribbleOption(m, p);
  opts.push({ kind: 'dribble', v: drib.value * 0.95 + noise(), drib });
  if (drib.space > 6 && oppD > 3.5 && p.knockCd <= 0) opts.push({ kind: 'knock', v: drib.value + 0.04 + noise(), drib });
  let sq = shotQuality(m, p);
  if (isJesusActive(m, p.team) && knobs.pray !== 'veryEasy' && p.pos.x * attackDir(p.team) > -2) sq = Math.max(sq, 0.85);
  // First-time finishes only for big chances; otherwise take a touch and look up first.
  if (sq > (knobs.shotMin ?? SHOT_MIN) && (settled || sq > 0.4)) opts.push({ kind: 'shoot', v: sq * SHOT_W + noise() });
  const cq = (knobs.chip ?? 1) > 0 ? chipQuality(m, p) : 0;
  if (cq > 0.05) opts.push({ kind: 'chip', v: cq + noise() });
  if (settled) {
    for (const q of teamOf(m, p.team)) {
      if (q === p) continue;
      const pt = passTarget(m, p, q);
      opts.push({ kind: 'pass', v: pt.value + noise(), q });
      const tt = (knobs.through ?? 1) > 0 ? throughTarget(m, p, q) : null;
      if (tt) opts.push({ kind: 'through', v: tt.value + noise(), q, tt });
    }
  }
  const own = 1 - clamp((p.pos.x * attackDir(p.team) + HL) / (2 * HL), 0, 1);
  if (own > 0.6 && oppD < 4) opts.push({ kind: 'clear', v: 0.12 + noise() });   // under pressure near our goal: get rid of it
  opts.sort((a, b) => b.v - a.v);
  const o = opts[0];
  p.drib = drib;
  switch (o.kind) {
    case 'shoot': {
      const sk = knobs.shotSkill ?? 1;
      if (sk < 1) {
        // Less clinical finishing: gentler shot aimed closer to goal centre (still on frame, never kicked out).
        const aimZ = (m.rand() - 0.5) * 2 * (GW - 0.8) * sk;
        shoot(m, p, 0.2 + m.rand() * 0.32, 0, aimZ);
      } else {
        shoot(m, p, 0.45 + m.rand() * 0.4, 0);
      }
      break;
    }
    case 'chip': chip(m, p, 0.6, 0); break;
    case 'pass': passTo(m, p, o.q); break;
    case 'through': throughTo(m, p, o.q, o.tt); break;
    case 'knock': knockOn(m, p, o.drib.dir); break;
    case 'clear': {
      const dir = attackDir(p.team), side = p.pos.z > 0 ? 1 : -1;      // long and towards the near flank
      const tx = p.pos.x + dir * (24 + m.rand() * 8), tz = side * (HW - 4);
      const dx = tx - m.ball.pos.x, dz = tz - m.ball.pos.z, d = hyp(dx, dz), h = 15 + d * 0.15, T = d / h;
      release(m, p, (dx / d) * h, (BALL.gravity * T) / 2 + 2, (dz / d) * h, 'pass', 'clear');
      break;
    }
  }
  return carry(p);
}
const carry = (p) => ({ x: p.pos.x + p.drib.dir.x * 5, z: p.pos.z + p.drib.dir.z * 5, sprint: p.drib.space > 3 });

// Open spot for an off-ball attacker, re-picked on a short staggered timer.
function supportSpot(m, p, dt) {
  p.spotT = (p.spotT ?? 0) - dt;
  if (p.spot && p.spotT > 0) return p.spot;
  p.spotT = 0.3 + p.slot * 0.04;
  const b = m.ball, dir = attackDir(p.team), base = basePos(p, m);
  const carrier = b.owner && b.owner.team === p.team ? b.owner : null;
  const from = carrier ? carrier.pos : b.pos;
  // (supporters push up further on a longer pitch)
  const anchor = { x: clamp(base.x + b.pos.x * 0.45 + dir * 7.5 * (HL / (PITCH.length / 2)), -HL + 2, HL - 2), z: clamp(base.z * 0.85 + b.pos.z * 0.3, -HW + 1.5, HW - 1.5) };
  const cands = [anchor];
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    for (const r of [5, 10]) cands.push({ x: anchor.x + Math.cos(a) * r, z: anchor.z + Math.sin(a) * r });
  }
  if (p.slot >= 2) {                                   // a run in behind the last defender
    let line = -Infinity;
    for (const o of teamOf(m, 1 - p.team)) if (!o.isGK) line = Math.max(line, o.pos.x * dir);
    cands.push({ x: dir * Math.min(line + 4, HL - 4), z: clamp(p.pos.z, -HW + 3, HW - 3) });
  }
  let best = anchor, bestV = -Infinity;
  for (const c of cands) {
    if (!inPitch(c, 1.5)) continue;
    if (p.isGK) continue;
    const d = hyp(c.x - from.x, c.z - from.z);
    const safety = d < 3 ? 0.3 : laneSafety(m, p.team, from, c, d > 20 ? 16 : 11, d > 20);
    const space = clamp(pressureAt(m, p.team, c) / 5, 0, 1);
    let spacing = 0;
    for (const q of teamOf(m, p.team)) {
      if (q === p || q.isGK) continue;
      const qp = q.spot && q !== carrier ? q.spot : q.pos;
      const dq = hyp(c.x - qp.x, c.z - qp.z);
      if (dq < 7) spacing -= ((7 - dq) / 7) * 0.3;
    }
    const v = 0.45 * safety + 0.25 * space + 0.6 * spotValue(p.team, c) + spacing - hyp(c.x - anchor.x, c.z - anchor.z) / 25;
    if (v > bestV) { bestV = v; best = c; }
  }
  p.spot = best;
  return best;
}

// The human's AI teammates always play at full strength; the difficulty level only shapes the CPU side.
const knobsFor = (m, team, human) => (human && human.team === team ? AI_LEVELS.hard : m.ai[team]);

// Team plan, once per tick: who chases, presses, covers and marks.
function planTeam(m, team, human) {
  const b = m.ball, owner = b.owner, plan = new Map();
  const outfield = teamOf(m, team).filter((q) => !q.isGK && q !== human && q.stun <= 0);
  if (owner?.isGK && inOwnBox(owner) && owner.team === team) {   // our keeper has it: two come short to the corners of the box
    const gx = ownGoal(team).x, out = attackDir(team), free = [...outfield];
    for (const side of [-1, 1]) {
      const spot = { x: gx + out * (PITCH.boxDepth + 1), z: side * Math.min(PITCH.boxWidth / 2 + 3, HW - 3) };   // wide, outside the box
      const [q] = nearestTo(free, spot);
      if (!q) break;
      free.splice(free.indexOf(q), 1);
      plan.set(q, { role: 'show', target: spot });
    }
    return plan;
  }
  if (owner && owner.team === team) return plan;      // attacking: carrier thinks, the rest support
  // Their keeper has it, or his pass is still on its way to the receiver (like a goal kick):
  // drop out of his area and mark from outside, so the receiver gets the ball with room.
  const gkp = b.gkPass, gkTeam = owner?.isGK && inOwnBox(owner) ? owner.team
    : !owner && gkp && b.receiver === gkp.receiver && m.t - gkp.t < 3 ? gkp.team : null;
  if (gkTeam !== null && gkTeam !== team) {
    const gx = ownGoal(gkTeam).x, out = attackDir(gkTeam), edge = PITCH.boxDepth + 7;
    const attackers = teamOf(m, gkTeam).filter((o) => !o.isGK);
    for (const q of outfield) {
      const [a] = nearestTo(attackers, q.pos);
      if (a) attackers.splice(attackers.indexOf(a), 1);
      const t = a ? { x: a.pos.x - out * 1.5, z: a.pos.z } : { x: q.pos.x, z: q.pos.z };
      if ((t.x - gx) * out < edge) t.x = gx + out * edge;
      plan.set(q, { role: 'standoff', target: t });
    }
    return plan;
  }
  // The defender (slot 1) is the last line: he sweeps behind the others unless the ball is already close to goal.
  const g0 = ownGoal(team), ballToGoal = hyp(b.pos.x - g0.x, b.pos.z);
  const sweeper = outfield.find((q) => q.slot === 1);
  const kn = knobsFor(m, team, human);
  if (sweeper && m.size > 3 && (kn.sweep ?? 1) > 0 && ballToGoal > 13 && !(owner && owner.team === team)) {   // 3 v 3: no spare man to sweep
    let deepest = null;                                    // the attacker closest to our goal
    for (const o of teamOf(m, 1 - team)) if (!o.isGK && (!deepest || hyp(o.pos.x - g0.x, o.pos.z) < hyp(deepest.pos.x - g0.x, deepest.pos.z))) deepest = o;
    const ref = deepest && hyp(deepest.pos.x - g0.x, deepest.pos.z) < ballToGoal ? deepest.pos : b.pos;
    const u = unit(ref.x - g0.x, ref.z - g0.z), r = clamp(hyp(ref.x - g0.x, ref.z - g0.z) - 2.5, 7, 22);
    plan.set(sweeper, { role: 'sweep', target: { x: g0.x + u.x * r, z: g0.z + u.z * r } });
    outfield.splice(outfield.indexOf(sweeper), 1);
  }
  const humanHere = human && human.team === team;
  const humanCanPress = humanHere && hyp(human.pos.x - b.pos.x, human.pos.z - b.pos.z) <= 2;
  const byTime = outfield
    .map((q) => { const t = intercept(m, q); return { q, t, d: hyp(t.x - q.pos.x, t.z - q.pos.z) / q.info.speed }; })
    .sort((a, c) => a.d - c.d);
  const free = new Set(outfield);
  const oursInFlight = !owner && b.receiver && b.receiver.team === team;   // our pass or knock-on: let the receiver have it
  if (byTime.length && !humanCanPress && !oursInFlight) {
    const chaser = byTime[0].q;
    let target = owner ? { x: owner.pos.x + owner.vel.x * 0.25, z: owner.pos.z + owner.vel.z * 0.25 } : byTime[0].t;
    const boxRoom = kn.boxRoom ?? 0;
    if (boxRoom > 0 && owner && owner.team !== team) {
      // Drop off goal-side at a slight angle in our half so the carrier has a clear lane toward the box.
      const ownHalf = (owner.pos.x - g0.x) * attackDir(team) < HL + 4;
      if (ownHalf) {
        const u = unit(g0.x - owner.pos.x, g0.z - owner.pos.z);
        const side = (chaser.pos.z - owner.pos.z) >= 0 ? 1 : -1;
        target = {
          x: clamp(owner.pos.x + u.x * boxRoom, -HL + 2, HL - 2),
          z: clamp(owner.pos.z + u.z * boxRoom + side * 2.4, -HW + 1.5, HW - 1.5),
        };
      }
    }
    plan.set(chaser, { role: 'chase', target }); free.delete(chaser);
  }
  if (!owner) {                                        // loose ball: the rest hold shape or support
    const ours = m.lastTeam === team;
    for (const q of free) plan.set(q, { role: ours ? 'support' : 'mark' });
    if (ours) return plan;
  }
  const carrier = owner ?? null;
  // Double up on a carrier who is near our goal, or when the human calls for pressure.
  const danger = carrier && hyp(carrier.pos.x - ownGoal(team).x, carrier.pos.z) < 22;
  const pressing = (m.pressT?.[team] ?? -1) > m.t || !!danger;
  if (carrier && free.size && (kn.cover ?? 1) > 0) {
    const [c] = nearestTo([...free], carrier.pos);
    const g = ownGoal(team), u = unit(g.x - carrier.pos.x, g.z - carrier.pos.z);
    plan.set(c, pressing ? { role: 'chase', target: carrier.pos } : { role: 'cover', target: { x: carrier.pos.x + u.x * 5.5, z: carrier.pos.z + u.z * 5.5 } });
    free.delete(c);
  }
  const attackers = teamOf(m, 1 - team).filter((o) => !o.isGK && o !== carrier);
  if ((kn.mark ?? 1) <= 0) { for (const q of free) plan.set(q, { role: 'shape' }); return plan; }
  for (const q of [...free]) {                         // greedy marking
    const [a] = nearestTo(attackers, q.pos);
    if (!a) { plan.set(q, { role: 'mark' }); continue; }
    attackers.splice(attackers.indexOf(a), 1);
    const g = ownGoal(team), ug = unit(g.x - a.pos.x, g.z - a.pos.z), ub = unit(b.pos.x - a.pos.x, b.pos.z - a.pos.z);
    const tight = hyp(a.pos.x - g.x, a.pos.z) < 26 ? 1.2 : 1.8;
    plan.set(q, { role: 'mark', target: { x: a.pos.x + (ug.x * 0.6 + ub.x * 0.4) * tight, z: a.pos.z + (ug.z * 0.6 + ub.z * 0.4) * tight } });
  }
  return plan;
}

function keeperThink(m, p, dt, knobs) {
  const b = m.ball, dir = attackDir(p.team), gx = -dir * HL;
  if (b.owner === p) {
    // Hold the ball (it can't be tackled) until a team-mate is genuinely free: a safe lane and nobody
    // within 6 m of where he'll receive it. Team-mates spread out meanwhile and opponents stand off.
    p.holdT += dt;
    const care = knobs.gkCare ?? 1;
    if (p.holdT > GK_SETTLE * care && (p.gkLook = (p.gkLook ?? 0) - dt) <= 0) {
      p.gkLook = 0.2;
      const late = p.holdT > GK_MAX_HOLD;
      let best = null, freest = null, fallback = null;
      for (const q of teamOf(m, p.team)) {
        if (q === p) continue;
        const pt = passTarget(m, p, q), room = pressureAt(m, p.team, pt.target);
        const d = hyp(pt.target.x - b.pos.x, pt.target.z - b.pos.z), flight = d > 20 ? d / (14 + d * 0.2) : d / 9;
        if ((pt.target.x - gx) * dir < PITCH.boxDepth - 1) continue;     // never to a team-mate in front of his own goal
        // Opponents stand off until his pass is received, so a short pass only needs a clear lane and room
        // at the end; a long ball also needs room for its hang time against the markers upfield.
        const v = spotValue(p.team, pt.target) + (m.rand() - 0.5) * knobs.noise * 0.5;
        const clear = laneClearance(m, p.team, b.pos, pt.target);
        if (!freest || room > freest.room) freest = { q, room };
        if (late && d <= 20 && clear > 2 * care && room > 3 * care && (!fallback || v > fallback.v)) fallback = { q, v };
        if (d <= 20 ? clear < 2.5 * care || room < 5 * care : room < (4 + flight * 5) * care) continue;
        if (!best || v > best.v) best = { q, v };
      }
      const pick = best ?? fallback ?? (late ? freest : null);           // late: any decent pass, else kick to the most space
      if (pick) { passTo(m, p, pick.q, best || fallback ? undefined : 'lofted'); p.holdT = 0; b.gkPass = { team: p.team, receiver: pick.q, t: m.t }; }
    }
    return { x: gx + dir * 2, z: 0, sprint: false };
  }
  p.holdT = 0;
  const inBox = Math.abs(b.pos.x - gx) < PITCH.boxDepth && Math.abs(b.pos.z) < PITCH.boxWidth / 2;
  if (!b.owner && inBox && hyp(b.vel.x, b.vel.z) < 9) { const t = intercept(m, p); return { x: t.x, z: t.z, sprint: true }; }
  if (b.shot?.chip && b.shot.team !== p.team && m.t - b.shot.t > 0.4) {    // a chip: get back to where it drops
    const tLine = Math.abs(b.vel.x) > 0.5 ? (gx + dir * 0.5 - b.pos.x) / b.vel.x : 0;
    const tz = clamp(b.pos.z + b.vel.z * Math.max(0, tLine), -GW + 0.3, GW - 0.3);
    return { x: gx + dir * 0.5, z: tz, sprint: true, backpedal: Math.abs(p.pos.x - gx) > 1.6 };
  }
  const gkSave = knobs.gkSave ?? 1;
  if (b.shot && b.shot.team !== p.team && Math.abs(b.vel.x) > 1) {      // read the shot
    const tHit = (p.pos.x - b.pos.x) / b.vel.x;
    const tz = tHit > 0 ? clamp(b.pos.z + b.vel.z * tHit, -GW - 0.6, GW + 0.6) : p.pos.z;
    return { x: p.pos.x, z: tz, sprint: gkSave >= 1 };
  }
  // Narrow the angle: stand on the ball-goal line; come off the line as an attacker closes in.
  const dBall = hyp(b.pos.x - gx, b.pos.z);
  const threat = b.owner && b.owner.team !== p.team ? clamp((20 - dBall) / 14, 0, 1) : 0;
  const depth = gkSave < 1 ? (1.0 + threat * 0.8) * 0.65 : 1.0 + threat * 0.8;
  // Stay near the centre of the goal (assisted shots aim at the far side of the keeper, so drifting
  // to the near post opens the far corner); step off the line as an attacker closes in.
  const u = unit(b.pos.x - gx, b.pos.z);
  const targetZ = gkSave < 1 ? clamp(u.z * depth * 0.5, -GW + 0.3, GW - 0.3) : clamp(u.z * depth, -GW + 0.3, GW - 0.3);
  return { x: gx + u.x * depth, z: targetZ, sprint: gkSave >= 1 };
}

function aiThink(m, p, dt, human, plan) {
  const b = m.ball, owner = b.owner, knobs = knobsFor(m, p.team, human);
  if (p.isGK) return keeperThink(m, p, dt, knobs);
  if (owner === p) return carrierThink(m, p, dt, knobs);
  p.drib = null;
  if (b.receiver === p && !owner) { const t = intercept(m, p); return { x: t.x, z: t.z, sprint: true }; }
  if (p.oneTwoT > m.t && owner && owner.team === p.team) {          // give-and-go: burst into space
    const dir = attackDir(p.team);
    return { x: clamp(p.pos.x + dir * 8, -HL + 3, HL - 3), z: clamp(p.pos.z * 0.8, -HW + 2, HW - 2), sprint: true };
  }
  const role = plan.get(p);
  if (role?.target) {
    const press = knobs.press ?? 1;
    const t = role.target, far = hyp(t.x - p.pos.x, t.z - p.pos.z) > 3;
    const dOwn = owner ? hyp(owner.pos.x - p.pos.x, owner.pos.z - p.pos.z) : Infinity;
    const boxRoom = knobs.boxRoom ?? 0;
    const dropOff = boxRoom > 0 && owner && owner.team !== p.team && (owner.pos.x - ownGoal(p.team).x) * attackDir(p.team) < HL + 4;
    const nearOwnBox = boxRoom > 0 && owner && hyp(owner.pos.x - ownGoal(p.team).x, owner.pos.z) < 18;
    const effPress = nearOwnBox ? press * 0.3 : press;
    const effSlide = nearOwnBox ? (knobs.slide ?? 0.8) * 0.2 : (knobs.slide ?? 0.8);
    if (role.role === 'chase' && owner && owner.team !== p.team && dOwn < 1.8 && m.rand() < 5 * effPress * dt) tackle(m, p);
    else if (role.role === 'chase' && owner && owner.team !== p.team && !owner.isGK && dOwn > 2.2 && dOwn < 3.6
      && m.rand() < effSlide * dt) slideTackle(m, p, { x: owner.pos.x + owner.vel.x * 0.25 - p.pos.x, z: owner.pos.z + owner.vel.z * 0.25 - p.pos.z });
    return { x: t.x, z: t.z, sprint: (role.role === 'chase' && !dropOff) || (far && !dropOff) };
  }
  if (!owner || owner.team === p.team || role?.role === 'support') {
    const s = supportSpot(m, p, dt);
    return { x: s.x, z: s.z, sprint: hyp(s.x - p.pos.x, s.z - p.pos.z) > 5 };
  }
  const base = basePos(p, m);                                            // fallback: shape
  return { x: clamp(base.x + b.pos.x * 0.45 - attackDir(p.team) * 3, -HL + 2, HL - 2), z: clamp(base.z * 0.85 + b.pos.z * 0.3, -HW + 1.5, HW - 1.5), sprint: false };
}

// LT autopilot for a human's priest. Never calls m.rand(), so it can't shift the match's random stream.
// With the ball: dribble into the best space ahead. Ball loose or coming to him: run to where he meets it.
// Team-mate on the ball: take the best support spot. Defending: run to where the carrier will be in
// a moment (his velocity projected forward), staying a step goal-side of him.
function autopilotTarget(m, h, dt) {
  const b = m.ball, owner = b.owner;
  if (owner === h) {
    const d = dribbleOption(m, h).dir;
    return { x: h.pos.x + d.x * 5, z: h.pos.z + d.z * 5, sprint: false };
  }
  if (!owner || b.receiver === h) { const t = intercept(m, h); return { x: t.x, z: t.z, sprint: true }; }
  if (owner.team === h.team) {
    const s = supportSpot(m, h, dt);
    return { x: s.x, z: s.z, sprint: hyp(s.x - h.pos.x, s.z - h.pos.z) > 5 };
  }
  const g = ownGoal(h.team), top = PLAYER.sprint * h.info.speed;
  let pt = { x: owner.pos.x, z: owner.pos.z };
  for (let t = 0; t <= 2; t += 0.1) {
    const px = clamp(owner.pos.x + owner.vel.x * t, -HL + 0.5, HL - 0.5), pz = clamp(owner.pos.z + owner.vel.z * t, -HW + 0.5, HW - 0.5);
    const gx = g.x - px, gz = g.z - pz, gl = hyp(gx, gz) || 1;
    pt = { x: px + (gx / gl) * 0.8, z: pz + (gz / gl) * 0.8 };
    if (hyp(pt.x - h.pos.x, pt.z - h.pos.z) <= top * (t + 0.05)) break;
  }
  return { x: pt.x, z: pt.z, sprint: true };
}

function knockTapDir(h, input, aim) {
  const atk = attackDir(h.team);
  const moveLen = input?.move ? hyp(input.move.x, input.move.z) : 0;
  let raw;
  if (moveLen > 0.3) raw = { x: input.move.x, z: input.move.z };
  else if (aim) raw = { x: aim.x - h.pos.x, z: aim.z - h.pos.z };
  else raw = facingDir(h);
  if (hyp(raw.x, raw.z) < 0.05) return { x: atk, z: 0 };
  if (raw.x * atk < 0) {
    // Never knock backwards toward own goal: clamp to the forward half-plane (forward if purely backwards).
    return Math.abs(raw.z) > 0.15 ? { x: 0.15 * atk, z: raw.z } : { x: atk, z: 0 };
  }
  return raw;
}

// One human side's actions this tick (h is that side's controlled priest, input its device).
function humanActions(m, t, h, input, dt) {
  const b = m.ball;
  // human actions
  // The mouse aims independently of movement; without it, the movement keys or stick aim as before.
  const aim = h && input.aim ? input.aim : null;
  const aimDir = aim ? { x: aim.x - h.pos.x, z: aim.z - h.pos.z } : input?.move;
  // Q and the pad follow movement even while the mouse reticle is visible.
  if (h && input.switchPressed && b.owner !== h) switchInDirection(m, aim && input.switchToAim ? aimDir : input.move, t);
  if (h && input.pressPressed) callPress(m, h.team);
  if (h && b.owner === h) {
    if (input.knockOnPressed) knockOn(m, h, aimDir);
    else if (input.throughPressed) { if (aim) throughToAim(m, h, aim); else throughPass(m, h, input.move); }
    else if (input.oneTwoPressed) { if (aim) { if (passToAim(m, h, aim, 'onetwo')) h.oneTwoT = m.t + 2.5; } else oneTwo(m, h, input.move); }
    else if (input.passPressed) { if (aim) passToAim(m, h, aim); else pass(m, h, input.move); }
    if (input.shootHeld || input.shootPressed) { m.chargings[t] = true; m.charges[t] = Math.min(1, m.charges[t] + dt / 0.9); }
    if ((input.shootReleased || input.chipReleased) && m.chargings[t] && b.owner === h) {
      const aimZ = aim ? goalLineZ(m, h, aim) : null;
      const toGoal = hyp(attackDir(h.team) * HL - h.pos.x, h.pos.z);
      if (h.isGK && !input.chipReleased) punt(m, h, aimDir ?? input.move, m.charges[t]);
      else if (input.chipReleased) chip(m, h, Math.max(m.charges[t], aim ? 0.6 : 0), input.move.z, aimZ);   // a quick chip with aim gets a normal lob
      else if (m.charges[t] < KNOCK_TAP.charge && toGoal > KNOCK_TAP.range) knockOn(m, h, knockTapDir(h, input, aim));   // a tap far out on any device: knock it on (or ignore while on cooldown)
      else shoot(m, h, m.charges[t], input.move.z, aimZ);
    }
    if (!input.shootHeld || input.shootReleased) { m.chargings[t] = false; m.charges[t] = 0; }
  } else {
    m.chargings[t] = false; m.charges[t] = 0;
    const ownKeeper = b.owner?.isGK && b.owner.team === h?.team;
    if (h && input.passPressed && ownKeeper) {           // call for it: he plays it to you if it's sensible
      const gk = b.owner, depth = (h.pos.x - ownGoal(h.team).x) * attackDir(h.team);
      if (depth >= PITCH.boxDepth - 1 && laneClearance(m, h.team, b.pos, h.pos) > 2 && pressureAt(m, h.team, h.pos) > 3) {
        passTo(m, gk, h); gk.holdT = 0; b.gkPass = { team: gk.team, receiver: h, t: m.t };
      }
    }
    else if (h && input.chipReleased) {
      // Dedicated slide tackle (controller X while defending; chipReleased is unused off the ball so online v2 needs no extra bit).
      const c = b.owner, target = c && c.team !== h.team ? c.pos : !c ? b.pos : null;
      const d = target ? hyp(target.x - h.pos.x, target.z - h.pos.z) : Infinity;
      const dir = target && d <= SLIDE.maxD
        ? { x: b.pos.x + b.vel.x * 0.2 - h.pos.x, z: b.pos.z + b.vel.z * 0.2 - h.pos.z }
        : (hyp(input.move.x, input.move.z) > 0.2 ? input.move : facingDir(h));
      slideTackle(m, h, dir);
    }
    else if (h && input.passPressed) tackleOrSlide(m, h, input.sprint);
  }

  // A human keeper holding the ball: after 6 s his own logic releases it (opponents are standing off).
  if (h?.isGK) {
    if (b.owner === h) { h.holdT += dt; if (h.holdT > GK_HUMAN_HOLD) { h.holdT = GK_MAX_HOLD + 0.1; keeperThink(m, h, dt, AI_LEVELS.hard); } }
    else h.holdT = 0;
  }
}

// ---------- step ----------
function aiPrayerInput(m, t, dt) {
  const pr = m.prayers[t];
  const prof = PRAYER.ai[m.ai[t]?.pray ?? m.level] ?? PRAYER.ai.normal;
  const used = PRAYER.maxPerMatch - pr.remaining;
  if (pr.remaining <= 0 || used >= (prof.maxUses ?? PRAYER.maxPerMatch) || pr.active !== null) {
    pr.ai.intent = null; pr.ai.readyT = 0; return null;
  }
  pr.ai.cd = Math.max(0, pr.ai.cd - dt);
  if (MATCH.seconds - m.clock < prof.startDelay) return null;

  const b = m.ball, dir = attackDir(t), ownGx = -dir * HL;
  const ballX = b.pos.x * dir;
  const weHaveBall = b.owner?.team === t || (!b.owner && b.receiver?.team === t);
  const oppHasBall = b.owner?.team === 1 - t;
  const oppJesus = isJesusActive(m, 1 - t);
  const oppNearGoal = oppHasBall && b.owner.pos.x * dir < 0 && hyp(b.owner.pos.x - ownGx, b.owner.pos.z) < (prof.maryThreat ?? 20);
  const goalThreat = oppNearGoal || (oppJesus && ballX < HL * 0.25);
  const attackThird = weHaveBall && ballX > HL * (prof.jesusX ?? 0.25);

  if (pr.ready) {
    pr.ai.readyT += dt;
    let choose = null;
    if (prof.poorTiming) {
      // Very easy: never uses Mary unfairly when the opponent is attacking its goal;
      // Jesus or St George triggers while the opponent holds the ball in Very easy's own half so it mostly runs out.
      if (pr.ai.intent === 'mary') {
        if (ballX > 12 && !oppJesus && !oppHasBall) choose = 'mary';
        else if (pr.ai.readyT > 8 && oppHasBall && ballX < -2) pr.ai.intent = 'jesus';
      } else if (oppHasBall && ballX < -2) {
        choose = pr.ai.intent === 'george' ? 'george' : 'jesus';
      }
    } else {
      const hard = prof === PRAYER.ai.hard;
      if (goalThreat && (pr.ai.intent === 'mary' || hard)) choose = 'mary';
      else if (pr.ai.intent === 'george' && weHaveBall && ballX > -HL * 0.65) choose = 'george';
      else if (attackThird && (pr.ai.intent === 'jesus' || hard)) choose = 'jesus';
      else if (m.clock < 16 && (weHaveBall || oppHasBall)) choose = weHaveBall ? (pr.ai.intent === 'george' ? 'george' : 'jesus') : 'mary';
      else if (!hard && pr.ai.readyT > 5) {
        if (pr.ai.intent === 'jesus' && weHaveBall) choose = 'jesus';
        else if (pr.ai.intent === 'george' && weHaveBall) choose = 'george';
        else if (pr.ai.intent === 'mary' && oppHasBall && ballX < 8) choose = 'mary';
      }
    }
    // Jesus takes both slots: with one left, the attacking choice becomes St George.
    if (choose === 'jesus' && pr.remaining < (PRAYER.cost?.jesus ?? 1)) choose = 'george';
    if (choose) {
      pr.ai.cd = prof.cooldown * (0.8 + m.rand() * 0.4);
      return { prayerHeld: false, prayerJesus: choose === 'jesus', prayerMary: choose === 'mary', prayerGeorge: choose === 'george' };
    }
    return { prayerHeld: false, prayerJesus: false, prayerMary: false, prayerGeorge: false };
  }

  if (pr.ai.intent) {
    // Very easy aborts a partial Jesus/George charge if the opponent loses possession in its half.
    if (prof.poorTiming && (pr.ai.intent === 'jesus' || pr.ai.intent === 'george') && !(oppHasBall && ballX < -2)) {
      pr.ai.intent = null;
      return null;
    }
    return { prayerHeld: true, prayerJesus: false, prayerMary: false, prayerGeorge: false };
  }

  if (pr.ai.cd > 0) return null;
  pr.ai.checkT -= dt;
  if (pr.ai.checkT > 0) return null;
  pr.ai.checkT = prof.checkInterval * (0.75 + m.rand() * 0.5);

  const georgeRate = prof.georgeRate ?? prof.jesusRate;
  if (prof.poorTiming) {
    if (ballX > 12 && !oppJesus && !oppHasBall && m.rand() < prof.maryRate) pr.ai.intent = 'mary';
    else if (oppHasBall && ballX < -2 && m.rand() < prof.jesusRate) {
      pr.ai.intent = m.rand() < georgeRate / (prof.jesusRate + georgeRate) ? 'george' : 'jesus';
    }
  } else {
    const oppApproaching = (oppHasBall && ballX < 6 && hyp(b.owner.pos.x - ownGx, b.owner.pos.z) < prof.maryThreat + 8) || oppJesus;
    const hardPrepMary = prof === PRAYER.ai.hard && (m.prayers[1 - t].charging || m.prayers[1 - t].ready) && ballX < 10;
    if ((oppApproaching || hardPrepMary) && m.rand() < prof.maryRate) pr.ai.intent = 'mary';
    else if (weHaveBall && ballX > HL * (prof.jesusX - 0.15) && m.rand() < prof.jesusRate * 1.15) {
      // Close to goal: favour Jesus for the lethal shot, with a smaller chance of St George to burst past defenders.
      pr.ai.intent = m.rand() < 0.25 * (georgeRate / Math.max(0.01, prof.jesusRate)) ? 'george' : 'jesus';
    } else if (weHaveBall && ballX > -HL * 0.65 && ballX <= HL * (prof.jesusX - 0.15) && m.rand() < georgeRate * 0.85) {
      // Midfield / counter-attack buildup: mount St George to gallop into the attacking third!
      pr.ai.intent = 'george';
    }
  }
  return pr.ai.intent ? { prayerHeld: true, prayerJesus: false, prayerMary: false, prayerGeorge: false } : null;
}

function stepPrayers(m, inputs, hs, dt) {
  for (const t of [0, 1]) {
    const pr = m.prayers[t];
    if (pr.active) {
      pr.timeLeft -= dt;
      if (pr.timeLeft <= 1e-6) {
        pr.active = null;
        pr.timeLeft = 0;
        pr.riderSlot = -1;
      }
    }
    // A human side's prayers belong strictly to the human; AI never prays for a human side.
    const src = hs[t] ? inputs[t] : aiPrayerInput(m, t, dt);
    const held = !!src?.prayerHeld;
    if (pr.ready) {
      pr.charging = false;
      pr.charge = 1;
      if (src?.prayerJesus) choosePrayer(m, t, 'jesus');
      else if (src?.prayerMary) choosePrayer(m, t, 'mary');
      else if (src?.prayerGeorge) choosePrayer(m, t, 'george');
    } else if (held && pr.remaining > 0 && pr.active === null) {
      pr.charging = true;
      pr.charge = Math.min(1, pr.charge + dt / PRAYER.chargeTime);
      if (pr.charge >= 1 - 1e-6) {
        pr.charge = 1;
        pr.ready = true;
        pr.charging = false;
      }
    } else {
      pr.charging = false;
      if (pr.charge > 0) {
        pr.charge = Math.max(0, pr.charge - dt / PRAYER.drainTime);
        if (pr.charge <= 1e-6) pr.charge = 0;
      }
    }
  }
}

export function step(m, input, dt) {
  usePitch(m);
  m.events.length = 0;
  m.t += dt;
  if (m.phase === 'over') { stepBall(m, dt); return; }
  if (m.phase === 'goal') {
    m.phaseT -= dt;
    // Let players coast smoothly to a stop instead of freezing mid-stride on a treadmill during goal replays.
    for (const p of m.players) {
      p.actionT = Math.max(0, p.actionT - dt);
      p.stun = Math.max(0, p.stun - dt);
      const drag = Math.exp((p.anim === 'dive' ? -3.0 : -4.8) * dt);
      p.vel.x *= drag; p.vel.z *= drag;
      p.pos.x = clamp(p.pos.x + p.vel.x * dt, -HL + (p.isGK ? 0.6 : 0.5), HL - (p.isGK ? 0.6 : 0.5));
      p.pos.z = clamp(p.pos.z + p.vel.z * dt, -HW + 0.4, HW - 0.4);
      p.speed = hyp(p.vel.x, p.vel.z);
      if (p.anim !== 'celebrate' && p.anim !== 'dive' && p.actionT <= 0 && p.stun <= 0) {
        p.anim = p.speed > PLAYER.speed * 1.05 ? 'sprint' : p.speed > 0.75 ? 'run' : 'idle';
      }
    }
    stepBall(m, dt);
    if (m.phaseT <= 0) kickoff(m, m.kickoffTeam);
    return;
  }
  if (m.ball.owner) m.stats[m.ball.owner.team].possession += Math.min(dt, m.clock);
  m.clock -= dt;
  if (m.clock <= 0) { m.clock = 0; m.phase = 'over'; stopReferee(m, 'idle'); m.events.push({ type: 'fulltime' }); return; }

  // step(m, input, dt) for one player (team 0), or step(m, [input0, input1], dt) for two. A side with
  // no input (or an AI side) is played by the AI; with no input at all, all the priests use the same AI.
  const inputs = Array.isArray(input) ? input : [input, null];
  for (const t of [0, 1]) if (inputs[t] && !m.humanTeams[t]) setHumanTeam(m, t, true);
  const hs = [0, 1].map((t) => (inputs[t] ? m.humans[t] : null));
  m._stepHumans = hs;
  if (m.prayersEnabled) stepPrayers(m, inputs, hs, dt);
  for (const t of [0, 1]) {
    if (hs[t]) humanActions(m, t, hs[t], inputs[t], dt);
    else { m.chargings[t] = false; m.charges[t] = 0; }
  }
  const b = m.ball;
  const plans = [planTeam(m, 0, hs[0]), planTeam(m, 1, hs[1])];
  for (const p of m.players) {
    p.tackleCd = Math.max(0, p.tackleCd - dt);
    p.knockCd = Math.max(0, p.knockCd - dt); p.burstT = Math.max(0, p.burstT - dt);
    p.actionT = Math.max(0, p.actionT - dt);
    if (!p.slideDone) {                                 // mid-slide: momentum only
      slideStep(m, p, dt);
      const limX = HL - 0.5;
      p.pos.x = clamp(p.pos.x, -limX, limX); p.pos.z = clamp(p.pos.z, -HW + 0.4, HW - 0.4);
      p.speed = hyp(p.vel.x, p.vel.z);
      continue;
    }
    if (p.hold) {                                      // tutorial: a held priest stands still where he was placed
      p.vel.x = 0; p.vel.z = 0; p.speed = 0;
      if (p.actionT <= 0 && p.stun <= 0) p.anim = 'idle';
      continue;
    }
    let want = { x: 0, z: 0 }, sprint = false;
    if (p.stun > 0) {
      p.stun -= dt;
    } else if (p === hs[p.team]) {
      const h = p, input = inputs[p.team];
      const L = hyp(input.move.x, input.move.z);
      const auto = input.autoRun && !h.isGK ? autopilotTarget(m, h, dt) : null;
      if (auto) {                                      // LT autopilot: the stick only aims, the priest runs himself
        const dx = auto.x - h.pos.x, dz = auto.z - h.pos.z, d = hyp(dx, dz);
        if (d > 0.4) { const k = Math.min(1, d / 2.5); want = { x: (dx / d) * k, z: (dz / d) * k }; }
        sprint = auto.sprint || !!input.sprint;
      } else if (L > 0.1) { want = { x: input.move.x / L, z: input.move.z / L }; sprint = input.sprint; }
      else if (b.receiver === h && !b.owner) {         // hands off the stick: run onto the pass
        const t = intercept(m, h), dx = t.x - h.pos.x, dz = t.z - h.pos.z, d = hyp(dx, dz);
        if (d > 0.4) want = { x: dx / d, z: dz / d };
        sprint = true;
      }
    } else {
      const tgt = aiThink(m, p, dt, hs[p.team], plans[p.team]);
      const dx = tgt.x - p.pos.x, dz = tgt.z - p.pos.z, d = hyp(dx, dz);
      if (d > 0.4) { const k = Math.min(1, d / 2.5); want = { x: (dx / d) * k, z: (dz / d) * k }; }
      sprint = !!tgt.sprint; p.backpedal = !!tgt.backpedal;
    }
    // Stamina: the AI keeps a reserve (it only sprints on fumes to chase or meet the ball); a tired priest's
    // sprint fades towards running pace.
    const attackRun = STAMINA.attackRuns && b.owner && b.owner.team === p.team && b.owner !== p && (p.pos.x - b.pos.x) * attackDir(p.team) > 0;
    if (sprint && p !== hs[p.team] && p.stamina < STAMINA.aiReserve && !(b.receiver === p || plans[p.team].get(p)?.role === 'chase' || p.isGK || attackRun)) sprint = false;
    const fresh = clamp(p.stamina / STAMINA.tired, 0, 1);
    let top = (sprint ? PLAYER.speed + (PLAYER.sprint - PLAYER.speed) * fresh : PLAYER.speed) * p.info.speed;
    if (p !== hs[p.team]) {
      const aiSpeed = knobsFor(m, p.team, hs[p.team]).speed ?? 1;
      if (aiSpeed !== 1) top *= aiSpeed;
    }
    if (b.owner === p) top *= 0.92;
    if (p.backpedal) top *= 0.6;
    if (p.trapT > m.t) top *= 0.5;                     // bringing a high ball under control                       // a keeper running backwards is slower
    if (p.burstT > 0 && sprint) top *= 1.12;
    if (isGeorgeRider(m, p)) top *= PRAYER.georgeSpeedBoost;
    const dvx = want.x * top - p.vel.x, dvz = want.z * top - p.vel.z, dv = hyp(dvx, dvz), maxDv = PLAYER.accel * dt;
    const k = dv > maxDv ? maxDv / dv : 1;
    p.vel.x += dvx * k; p.vel.z += dvz * k;
    p.pos.x += p.vel.x * dt; p.pos.z += p.vel.z * dt;
    const sp = hyp(p.vel.x, p.vel.z);
    if (sp > 0.4) {
      const turn = PLAYER.turnRate * (b.owner === p ? 1.3 : 1) * dt;
      p.facing += clamp(angleWrap(Math.atan2(p.vel.z, p.vel.x) - p.facing), -turn, turn);
    }
    const limX = HL - (p.isGK ? 0.6 : 0.5);
    p.pos.x = clamp(p.pos.x, -limX, limX); p.pos.z = clamp(p.pos.z, -HW + 0.4, HW - 0.4);
    p.speed = sp;
    const sprinting = sprint && sp > PLAYER.speed * p.info.speed * 0.9;
    p.stamina = clamp(p.stamina + dt * (sprinting ? -STAMINA.drain : sp < 1.5 ? STAMINA.regenIdle : STAMINA.regenRun), 0, 1);
    if (p.actionT <= 0 && p.stun <= 0) p.anim = sp > PLAYER.speed * 1.05 ? 'sprint' : sp > 0.8 ? 'run' : 'idle';
  }

  separate(m);
  stepBall(m, dt);
  pickups(m);
  if (m.phase === 'play') followPlay(m, dt);
}

function separate(m) {
  const ps = m.players, R = PLAYER.radius * 2;
  for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
    const a = ps[i], c = ps[j], dx = c.pos.x - a.pos.x, dz = c.pos.z - a.pos.z, d = hyp(dx, dz);
    if (d > 0 && d < R) {
      const push = (R - d) / 2;
      a.pos.x -= (dx / d) * push; a.pos.z -= (dz / d) * push;
      c.pos.x += (dx / d) * push; c.pos.z += (dz / d) * push;
    }
  }
}

function triggerPrayerClash(m, atkTeam, defTeam, sx) {
  const b = m.ball, r = BALL.radius;
  for (const t of [atkTeam, defTeam]) {
    const pr = m.prayers[t];
    pr.active = null;
    pr.timeLeft = 0;
    pr.riderSlot = -1;
  }
  b.pos.x = sx * (HL - r - 0.12);
  b.pos.z = clamp(b.pos.z, -(GW - r - 0.15), GW - r - 0.15);
  b.pos.y = clamp(b.pos.y, r, PITCH.goalHeight - r);
  b.vel = { x: 0, y: 0, z: 0 };
  b.shot = null;
  b.passer = null;
  b.inNet = false;
  b.clashDrop = true;
  b.clashDef = defTeam;
  b.clashHoldT = PRAYER.clashHold;
  const defGK = m.players.find((q) => q.team === defTeam && q.isGK);
  if (defGK) {
    b.receiver = defGK;
    b.noPickup.delete(defGK);
  }
  m.events.push({ type: 'clash', attacker: atkTeam, defender: defTeam, x: b.pos.x, y: b.pos.y, z: b.pos.z });
}

function stepBall(m, dt) {
  const b = m.ball, r = BALL.radius;
  if (b.owner) {                                              // sticky dribble
    const p = b.owner, f = facingDir(p);
    const tx = p.pos.x + f.x * PLAYER.dribbleOffset, tz = p.pos.z + f.z * PLAYER.dribbleOffset;
    const k = 1 - Math.exp(-25 * dt);
    b.pos.x += (tx - b.pos.x) * k; b.pos.z += (tz - b.pos.z) * k; b.pos.y = r;
    if (m.prayersEnabled && Math.abs(b.pos.x) > HL - r - 0.05 && Math.abs(b.pos.z) < GW - r) {
      const sx = Math.sign(b.pos.x);
      if (isMaryActive(m, sx > 0 ? 1 : 0)) b.pos.x = sx * (HL - r - 0.05);
    }
    b.vel = { x: p.vel.x, y: 0, z: p.vel.z };
    return;
  }
  const v = b.vel;
  if (b.clashDrop) {                                          // hold ~0.6 s at clash point, then drop gently onto goal line
    v.x = 0; v.z = 0;
    if (b.clashHoldT > 0) {
      b.clashHoldT = Math.max(0, b.clashHoldT - dt);
      v.y = 0;
      return;
    }
    if (b.pos.y > r + 0.005 || Math.abs(v.y) > 0.05) {
      v.y -= BALL.gravity * 0.45 * dt;
      b.pos.y += v.y * dt;
      if (b.pos.y <= r) { b.pos.y = r; v.y = 0; }
    } else {
      b.pos.y = r; v.y = 0;
    }
    return;
  }
  if (b.shot?.jesus && !b.inNet) {                            // Jesus shot: pure unstoppable straight line to goal
    b.pos.x += v.x * dt; b.pos.y += v.y * dt; b.pos.z += v.z * dt;
    const atkTeam = b.shot.team, defTeam = 1 - atkTeam, sx = attackDir(atkTeam);
    const reachedTarget = b.shot.target ? (b.pos.x - b.shot.target.x) * sx >= 0 : false;
    const inMouth = Math.abs(b.pos.z) < GW - r && b.pos.y < PITCH.goalHeight - r;
    if (m.phase === 'play' && isMaryActive(m, defTeam) && ((b.pos.x * sx >= HL - r && inMouth) || reachedTarget)) {
      if (reachedTarget && b.shot.target) { b.pos.z = b.shot.target.z; b.pos.y = b.shot.target.y; }
      triggerPrayerClash(m, atkTeam, defTeam, sx);
      return;
    }
    if ((b.pos.x * sx > HL + r && inMouth) || reachedTarget) {
      if (reachedTarget && b.shot.target) {
        b.pos.x = b.shot.target.x; b.pos.y = b.shot.target.y; b.pos.z = b.shot.target.z;
      }
      b.inNet = true;
      if (m.phase === 'play') scoreGoal(m, atkTeam);
    }
    return;
  }
  if (b.pos.y > r + 0.01 || v.y > 0.01) {                     // airborne
    v.y -= BALL.gravity * dt;
    const drag = Math.exp(-BALL.airDrag * dt);
    v.x *= drag; v.z *= drag;
  } else {                                                    // rolling
    const sp = hyp(v.x, v.z);
    if (sp > 0) { const ns = Math.max(0, sp - ROLL_DECEL * dt); v.x *= ns / sp; v.z *= ns / sp; }
  }
  b.pos.x += v.x * dt; b.pos.y += v.y * dt; b.pos.z += v.z * dt;
  if (b.pos.y < r) { b.pos.y = r; v.y = v.y < -2 ? -v.y * BALL.bounce : 0; }

  // side walls (arcade: no throw-ins)
  if (Math.abs(b.pos.z) > HW - r) { b.pos.z = Math.sign(b.pos.z) * (HW - r); v.z = -v.z * BALL.wallBounce; }

  // end lines: goal mouth or wall
  const ax = Math.abs(b.pos.x), sx = Math.sign(b.pos.x);
  if (ax > HL - r) {
    const inMouth = Math.abs(b.pos.z) < GW - r && b.pos.y < PITCH.goalHeight - r;
    if (b.inNet || inMouth) {
      const defTeam = sx > 0 ? 1 : 0;
      if (!b.inNet && m.phase === 'play' && isMaryActive(m, defTeam) && v.x * sx > 0) {
        b.pos.x = sx * (HL - r - 0.05);
        v.x = -sx * Math.max(1.5, Math.abs(v.x) * PRAYER.maryRebound);
        v.z *= PRAYER.maryRebound;
        v.y = Math.min(2.5, Math.max(0, v.y * PRAYER.maryRebound));
        b.shot = null;
        b.receiver = null;
        recordEvent(m, { type: 'maryBlock', team: defTeam, x: b.pos.x, y: b.pos.y, z: b.pos.z });
      } else {
        if (!b.inNet && ax > HL + r) { b.inNet = true; if (m.phase === 'play') scoreGoal(m, sx > 0 ? 0 : 1); }
        if (b.inNet) {                                         // keep it inside the net box
          if (ax > HL + PITCH.goalDepth - r) { b.pos.x = sx * (HL + PITCH.goalDepth - r); v.x *= -0.2; }
          if (Math.abs(b.pos.z) > GW - r) { b.pos.z = Math.sign(b.pos.z) * (GW - r); v.z *= -0.2; }
          if (b.pos.y > PITCH.goalHeight - r) { b.pos.y = PITCH.goalHeight - r; v.y = -Math.abs(v.y) * 0.2; }
          v.x *= 0.97; v.z *= 0.97;
        }
      }
    } else {                                                   // post, bar or end wall
      b.pos.x = sx * (HL - r); v.x = -v.x * BALL.wallBounce;
      b.shot = null;
    }
  }
  keeperSave(m);
}

function keeperSave(m) {
  const b = m.ball;
  if (!b.shot || b.shot.rolled || b.shot.jesus || b.owner) return;
  const gk = m.players.find((q) => q.team !== b.shot.team && q.isGK);
  const d = hyp(b.pos.x - gk.pos.x, b.pos.z - gk.pos.z);
  if (d > 2.3 || b.pos.y > 2.7) return;
  if (b.shot.chip && b.vel.y > 0) return;                   // a lob still climbing over him can't be saved
  b.shot.rolled = true;
  const speed = hyp(b.vel.x, b.vel.z);
  let chance = clamp(1.25 - speed / 34 - Math.abs(b.pos.z - gk.pos.z) * 0.22, 0.12, 0.9);
  if (b.shot.chip && gk.backpedal) chance *= 0.45;          // scrambling back, off balance
  const ah = activeHuman(m, gk.team);
  const gkSave = ah === gk ? 1 : (knobsFor(m, gk.team, ah).gkSave ?? 1);
  if (gkSave !== 1) {
    // Weak central shots straight at the keeper still get saved; well-placed or firm shots convert more often.
    const centralWeak = speed < 21 && Math.abs(b.pos.z - gk.pos.z) < 0.7;
    chance = clamp(chance * (centralWeak ? Math.sqrt(gkSave) : gkSave), 0.08, 0.9);
  }
  gk.anim = 'dive'; gk.actionT = 0.85; gk.moveKind = 'dive';   // a miss stays a plain dive
  if (m.rand() < chance) {
    if (speed < 22 && m.rand() < 0.6) {
      gk.moveKind = 'catch'; b.owner = gk; b.receiver = null; b.shot = null; b.lastTouch = gk; m.lastTeam = gk.team;
      const spd = Math.round(speed * 10) / 10;
      const ev = { type: 'catch', team: gk.team, keeper: gk.info?.id ?? null, speed: spd };
      if (spd >= STRONG_CATCH_SPEED) ev.kind = 'strong';
      recordEvent(m, ev);
      give(m, gk);                                        // your keeper caught it: he's yours
    }
    else {                                                    // parried away towards the flank
      const side = Math.sign(b.pos.z - gk.pos.z) || (m.rand() < 0.5 ? -1 : 1);
      b.vel.x = -b.vel.x * 0.3; b.vel.z = side * (6 + m.rand() * 6); b.vel.y = 3; b.shot = null; b.lastTouch = gk;
      gk.moveKind = 'parry';
      recordEvent(m, { type: 'parry', team: gk.team, keeper: gk.info?.id ?? null });
    }
  }
}

// All devices: a quick Shoot tap (charge under 0.2) further than 24 m from goal knocks the ball on instead of shooting.
const KNOCK_TAP = { charge: 0.2, range: 24 };
const GK_SETTLE = 1.4, GK_MAX_HOLD = 5, GK_HUMAN_HOLD = 6;   // keeper: seconds before he looks to release, and the latest he holds
const TRAP_S = 0.45;   // seconds to control a ball taken on the head or chest

function pickups(m) {
  const b = m.ball;
  if (b.owner || b.shot?.jesus || (b.clashDrop && b.clashHoldT > 0) || b.pos.y > 2.1 || m.phase !== 'play') return;
  let best = null, bd = Infinity;
  for (const p of m.players) {
    if (b.clashDrop && (!p.isGK || p.team !== b.clashDef)) continue;
    if (p.stun > 0 || (b.noPickup.get(p) ?? -1) > m.t) continue;
    if (b.pos.y > 1.3 && b.receiver !== p) continue;       // only the intended receiver goes up for a high ball
    const reach = BALL.pickupRadius + (b.receiver === p ? 0.35 : 0);
    const d = hyp(b.pos.x - p.pos.x, b.pos.z - p.pos.z);
    if (d < reach && d < bd) { bd = d; best = p; }
  }
  if (!best) return;
  if (b.passer?.team === best.team && b.passer !== best) recordEvent(m, { type: 'receive', team: best.team });
  if (best.isGK && b.shot && b.shot.team !== best.team) {      // gathering a loose shot is a catch too
    best.anim = 'catch'; best.actionT = 0.6; best.moveKind = 'catch';
    const spd = Math.round(hyp(b.vel.x, b.vel.z) * 10) / 10;
    const ev = { type: 'catch', team: best.team, keeper: best.info?.id ?? null, speed: spd };
    if (spd >= STRONG_CATCH_SPEED) ev.kind = 'strong';
    recordEvent(m, ev);
  }
  // A high ball is taken on the head or chest (the renderer plays the matching clip from recvT);
  // bringing it down costs a moment of control.
  const high = b.pos.y > 0.75 && !best.isGK;               // keepers use their hands: a high ball is a catch
  if (high) { best.moveKind = b.pos.y > 1.35 ? 'head' : 'chest'; best.trapT = m.t + TRAP_S; best.highRecvT = m.t; }
  b.owner = best; b.receiver = null; b.passer = null; b.shot = null; b.lastTouch = best; b.clashDrop = false; b.clashDef = null;
  b.vel = { x: 0, y: 0, z: 0 };
  best.recvT = m.t; m.lastTeam = best.team; best.drib = null; best.aiT = high ? TRAP_S : 0;
  give(m, best);
}

function scoreGoal(m, team) {
  const shot = m.ball.shot;
  const fromShot = shot?.team === team;
  const jesus = !!(fromShot && shot?.jesus);
  const spectacular = !!(fromShot && ((shot.dist ?? 0) >= 25 || shot.chip || shot.volley));
  const touch = fromShot && shot?.shooter ? shot.shooter : (m.ball.owner ?? m.ball.lastTouch);
  const ownGoal = !!(touch && touch.team !== team);
  const scorer = !ownGoal && touch?.team === team ? (touch.info?.id ?? null) : null;
  m.score[team] += 1;
  m.phase = 'goal'; m.phaseT = MATCH.celebrate; m.kickoffTeam = 1 - team;
  stopReferee(m, 'celebrate');
  m.ball.shot = null; m.ball.receiver = null; m.ball.passer = null; m.ball.lastTouch = null; m.ball.clashDrop = false;
  if (m.prayersEnabled) {
    for (const pr of m.prayers) {
      pr.charging = false;
      if (!pr.ready) { pr.charge = 0; pr.ai.intent = null; }
    }
  }
  for (const p of m.players) if (p.team === team) { p.anim = 'celebrate'; p.actionT = MATCH.celebrate; }
  const ev = { type: 'goal', team, fromShot };
  if (spectacular) ev.kind = 'spectacular';
  if (jesus) ev.jesus = true;
  if (ownGoal) ev.ownGoal = true;
  else if (scorer) ev.scorer = scorer;
  recordEvent(m, ev);
}
