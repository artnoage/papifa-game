// Positions and velocities travel in centimetres, times in milliseconds and stick axes in signed bytes.
import { teamStats } from './stats.js';

export const ACTIONS = ['passPressed', 'shootPressed', 'shootReleased', 'switchPressed', 'switchToAim',
  'throughPressed', 'oneTwoPressed', 'chipReleased', 'knockOnPressed', 'pressPressed', 'pausePressed',
  'prayerJesus', 'prayerMary', 'prayerGeorge', 'prayerPhanourios'];
const HELD = ['sprint', 'shootHeld', 'prayerHeld', 'autoRun'];
const flags = [...HELD, ...ACTIONS];
const anims = ['idle', 'run', 'sprint', 'pass', 'kick', 'tackle', 'stunned', 'dive', 'celebrate', 'catch', 'parry', 'slide', 'header', 'chest'];
const kinds = [null, 'pass', 'shot', 'through', 'lofted', 'clear', 'onetwo', 'knock', 'chip', 'head', 'chest', 'catch', 'parry', 'dive', 'slide'];
const prayerKinds = [null, 'jesus', 'mary', 'george', 'phanourios'];
const statKeys = Object.keys(teamStats());
const ms = seconds => Math.round(seconds * 1000);
const cm = metres => Math.round(metres * 100);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const tuple = (a, size) => Array.isArray(a) && a.length === size;
const numbers = (a, size) => tuple(a, size) && a.every(n => int(n, -10000000, 10000000));
const mix = (a, b, u) => a + (b - a) * u;

export function packInput(input) {
  const axis = x => Math.round(clamp(x, -1, 1) * 127);
  const aim = input.aim ? [cm(clamp(input.aim.x, -60, 60)), cm(clamp(input.aim.z, -40, 40))] : null;
  return [axis(input.move.x), axis(input.move.z), aim,
    flags.reduce((mask, name, i) => input[name] ? mask | 1 << i : mask, 0)];
}

export function unpackInput(data) {
  if (!tuple(data, 4)) return null;
  const [x, z, aim, mask] = data;
  if (!int(x, -127, 127) || !int(z, -127, 127) || !int(mask, 0, 2 ** flags.length - 1)) return null;
  if (aim !== null && !(tuple(aim, 2) && int(aim[0], -6000, 6000) && int(aim[1], -4000, 4000))) return null;
  const input = { move: { x: x / 127, z: z / 127 }, aim: aim && { x: aim[0] / 100, z: aim[1] / 100 } };
  flags.forEach((name, i) => { input[name] = Boolean(mask & 1 << i); });
  return input;
}

export function packState(m, presentation) {
  const b = m.ball, slot = p => m.players.indexOf(p);
  const actor = p => [
    cm(p.pos.x), cm(p.pos.z), cm(p.vel.x), cm(p.vel.z), Math.round(1000 * Math.atan2(Math.sin(p.facing), Math.cos(p.facing))),
    Math.max(0, anims.indexOf(p.anim)), Math.max(0, kinds.indexOf(p.moveKind)),
    cm(p.speed ?? 0), Math.round((p.stamina ?? 1) * 255), ms(p.actionT ?? 0),
    ms(p.knockT ?? -9), ms(p.recvT ?? -9),
  ];
  return {
    t: ms(m.t), clock: ms(m.clock), phase: m.phase, phaseT: ms(m.phaseT), view: presentation,
    score: [...m.score], humans: m.humans.map(slot),
    charge: m.charges.map((c, i) => m.chargings[i] ? Math.round(255 * c) : -1),
    prayers: (m.prayers ?? []).map(pr => [
      pr.remaining,
      Math.round(clamp(pr.charge ?? 0, 0, 1) * 255),
      pr.ready ? 1 : 0,
      Math.max(0, prayerKinds.indexOf(pr.active ?? null)),
      ms(Math.max(0, pr.timeLeft ?? 0)),
      pr.active === 'george' ? (pr.riderSlot ?? -1) : -1,
    ]),
    ball: [cm(b.pos.x), cm(b.pos.y), cm(b.pos.z), cm(b.vel.x), cm(b.vel.y), cm(b.vel.z), slot(b.owner), (b.shot?.jesus ? 1 : 0) | (b.inNet ? 2 : 0) | (b.foundBy === 0 ? 4 : b.foundBy === 1 ? 8 : 0)],
    actors: [...m.players, m.referee].map(actor),
    stats: m.stats.map(team => statKeys.map(k => k === 'possession' ? ms(team[k]) : team[k])),
  };
}

export function validState(s) {
  if (!s || !Array.isArray(s.actors) || ![7, 11].includes(s.actors.length)) return false;
  const players = s.actors.length - 1;
  return int(s.t, 0, 10000000) && int(s.clock, 0, 10000000) && int(s.phaseT, -1000, 10000)
    && ['play', 'goal', 'over'].includes(s.phase) && ['live', 'opening', 'pause', 'replay', 'replayPaused'].includes(s.view)
    && numbers(s.score, 2) && s.score.every(n => n >= 0)
    && tuple(s.humans, 2) && s.humans.every((n, t) => n === -1 || int(n, t * players / 2, (t + 1) * players / 2 - 1))
    && tuple(s.charge, 2) && s.charge.every(n => int(n, -1, 255))
    && tuple(s.prayers, 2) && s.prayers.every(p => tuple(p, 6) && int(p[0], 0, 2) && int(p[1], 0, 255) && int(p[2], 0, 1) && int(p[3], 0, prayerKinds.length - 1) && int(p[4], 0, 15000) && int(p[5], -1, players - 1))
    && numbers(s.ball, 8) && int(s.ball[6], -1, players - 1) && int(s.ball[7], 0, 15) && (s.ball[7] & 12) !== 12
    && s.actors.every(a => numbers(a, 12) && int(a[5], 0, anims.length - 1) && int(a[6], 0, kinds.length - 1) && int(a[8], 0, 255))
    && tuple(s.stats, 2) && s.stats.every(a => numbers(a, statKeys.length));
}

// Keep references to each priest stable for the renderer, ball ownership and both indicators.
export function applyState(m, left, right, alpha) {
  if (left.actors.length !== m.players.length + 1) return;
  // A kickoff teleports the players. Hold the last old pose until the new snapshot is due.
  const u = left.phase === right.phase && left.view === right.view ? alpha : 0;
  m.t = mix(left.t, right.t, u) / 1000;
  m.clock = mix(left.clock, right.clock, u) / 1000;
  m.phaseT = mix(left.phaseT, right.phaseT, u) / 1000;
  m.phase = left.phase;
  for (let i = 0; i < left.actors.length; i++) {
    const p = m.players[i] ?? m.referee, a = left.actors[i], b = right.actors[i];
    p.pos.x = mix(a[0], b[0], u) / 100;
    p.pos.z = mix(a[1], b[1], u) / 100;
    p.vel.x = mix(a[2], b[2], u) / 100;
    p.vel.z = mix(a[3], b[3], u) / 100;
    const turn = (b[4] - a[4]) / 1000;
    p.facing = a[4] / 1000 + u * Math.atan2(Math.sin(turn), Math.cos(turn));
    const anim = anims[a[5]];
    if (anim === 'slide' && p.anim !== anim) p.slideDir = { x: Math.cos(p.facing), z: Math.sin(p.facing) };
    p.anim = anim;
    p.moveKind = kinds[a[6]];
    p.speed = mix(a[7], b[7], u) / 100;
    p.stamina = mix(a[8], b[8], u) / 255;
    p.actionT = mix(a[9], b[9], a[5] === b[5] ? u : 0) / 1000;
    p.knockT = a[10] / 1000;
    p.recvT = a[11] / 1000;
  }
  for (const [i, axis] of ['x', 'y', 'z'].entries()) {
    m.ball.pos[axis] = mix(left.ball[i], right.ball[i], u) / 100;
    m.ball.vel[axis] = mix(left.ball[i+3], right.ball[i+3], u) / 100;
  }
  m.ball.owner = m.players[left.ball[6]] ?? null;
  const ballFlags = left.ball[7] ?? 0;
  m.ball.inNet = Boolean(ballFlags & 2);
  m.ball.foundBy = ballFlags & 4 ? 0 : ballFlags & 8 ? 1 : null;
  if (ballFlags & 1) {
    if (!m.ball.shot?.jesus) m.ball.shot = { jesus: true, team: 0 };
  } else {
    m.ball.shot = null;
  }
  for (const t of [0, 1]) {
    m.score[t] = left.score[t];
    m.humans[t] = m.players[left.humans[t]] ?? null;
    m.humanTeams[t] = !!m.humans[t];
    m.chargings[t] = left.charge[t] >= 0;
    m.charges[t] = Math.max(0, left.charge[t]) / 255;
    if (m.prayers?.[t] && left.prayers?.[t]) {
      const a = left.prayers[t], b = right.prayers?.[t] ?? a;
      const pr = m.prayers[t];
      pr.remaining = a[0];
      pr.ready = Boolean(a[2]);
      pr.active = prayerKinds[a[3]] ?? null;
      pr.riderSlot = pr.active === 'george' ? (a[5] ?? -1) : -1;
      pr.charge = (a[2] === b[2] && a[3] === b[3] ? mix(a[1], b[1], u) : a[1]) / 255;
      pr.charging = !pr.ready && pr.active === null && pr.charge > 0.005;
      pr.timeLeft = (a[3] === b[3] ? mix(a[4], b[4], u) : a[4]) / 1000;
    }
    statKeys.forEach((k, i) => { m.stats[t][k] = left.stats[t][i] / (k === 'possession' ? 1000 : 1); });
  }
}
