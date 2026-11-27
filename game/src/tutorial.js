// Gamepad tutorial: one step per control. Each step places the priests, plays a scripted demonstration
// through the real input shape (so the demo is the real mechanic), then hands the pad to the player and
// waits for the move to happen in the match. Pure logic, no DOM: tutorial-ui.js draws it.
import { BALL, PLAYER } from './config.js';

const WATCH_GAP = 0.7;     // s between the end of the demo and "Your turn"
const DONE_BEAT = 1.3;     // s the tick stays up before the next step
const STUCK_RESET = 3.0;   // s without the ball (on steps that need it) before the drill resets

const ACTION_FLAGS = ['passPressed', 'shootPressed', 'shootReleased', 'switchPressed', 'switchToAim', 'throughPressed',
  'oneTwoPressed', 'chipReleased', 'knockOnPressed', 'pressPressed', 'pausePressed', 'prayerJesus', 'prayerMary', 'prayerGeorge', 'prayerPhanourios'];

export function blankInput() {
  const input = { move: { x: 0, z: 0 }, aim: null, sprint: false, shootHeld: false, prayerHeld: false, autoRun: false };
  for (const f of ACTION_FLAGS) input[f] = false;
  return input;
}

const byslot = (m, team, slot) => m.players.find(p => p.team === team && p.slot === slot);
const me = m => byslot(m, 0, 4);

// Place the drill: everyone not listed in `active` stands still (p.hold) on the far touchline.
function place(m, { mePos, ball = 'me', mates = [], opps = [], active = [] }) {
  const far = -19.5;
  for (const p of m.players) {
    p.hold = true;
    p.vel = { x: 0, z: 0 }; p.speed = 0; p.anim = 'idle'; p.actionT = 0; p.stun = 0; p.stamina = 1;
    p.slideDone = true; p.slideT = -1; p.tackleCd = 0; p.knockCd = 0; p.burstT = 0; p.oneTwoT = -1;
    p.spot = null; p.drib = null; p.trapT = 0; p.backpedal = false; p.holdT = 0;
    if (p.isGK) { p.pos = { x: p.team === 0 ? -35.5 : 35.5, z: 0 }; p.facing = p.team === 0 ? 0 : Math.PI; continue; }
    p.pos = { x: (p.team === 0 ? -14 : 14) + p.slot * 3.2 * (p.team === 0 ? -1 : 1), z: far };
    p.facing = p.team === 0 ? 0 : Math.PI;
  }
  const h = me(m);
  h.pos = { ...mePos }; h.facing = 0; h.hold = false;
  for (const [slot, x, z] of mates) { const q = byslot(m, 0, slot); q.pos = { x, z }; q.facing = 0; }
  for (const [slot, x, z] of opps) { const q = byslot(m, 1, slot); q.pos = { x, z }; q.facing = Math.PI; }
  for (const [team, slot] of active) byslot(m, team, slot).hold = false;
  byslot(m, 1, 0).hold = false;                         // the opposing keeper always plays
  const b = m.ball;
  b.vel = { x: 0, y: 0, z: 0 }; b.receiver = null; b.passer = null; b.shot = null; b.inNet = false; b.clashDrop = false;
  b.noPickup.clear(); b.gkPass = null;
  const owner = ball === 'me' ? h : ball?.owner ? byslot(m, ball.owner[0], ball.owner[1]) : null;
  if (owner) {
    const f = owner.team === 0 ? 1 : -1;
    b.owner = owner; b.lastTouch = owner;
    b.pos = { x: owner.pos.x + f * PLAYER.dribbleOffset, y: BALL.radius, z: owner.pos.z };
  } else {
    b.owner = null; b.lastTouch = null;
    b.pos = { x: ball?.x ?? 0, y: BALL.radius, z: ball?.z ?? 0 };
  }
  m.humans[0] = h;
  m.phase = 'play'; m.phaseT = 0;
  m.charges.fill(0); m.chargings.fill(false);
  m.pressT = [-1, -1];
  for (const [t, pr] of m.prayers.entries()) {
    Object.assign(pr, { remaining: t === 0 ? 2 : 0, charge: 0, ready: false, charging: false, active: null, timeLeft: 0 });
    pr.ai.intent = null; pr.ai.cd = 99;
  }
}

const humanEvent = (events, type, kind) => events.some(e => e.type === type && e.team === 0 && e.human && (!kind || e.kind === kind));

// A demo is a list of segments { from, to, ...held input, pad: { press: [...], ls, rs } } plus one-shot edges
// { at, edge } that fire once when demo time passes `at`. The pad display mirrors exactly what is sent.
export const TUTORIAL_STEPS = [
  {
    id: 'move', title: 'Move', keys: ['LS'],
    caption: 'Push the left stick to run. The priest carries the ball at his feet.',
    setup: m => place(m, { mePos: { x: -10, z: 4 } }),
    demo: { length: 2.6, segs: [{ from: 0.2, to: 1.3, move: [1, 0] }, { from: 1.3, to: 2.4, move: [0.6, -0.8] }] },
    track(st, m) { const h = me(m); if (st.last) st.dist = (st.dist ?? 0) + Math.hypot(h.pos.x - st.last.x, h.pos.z - st.last.z); st.last = { ...h.pos }; },
    success: (m, ev, st) => (st.dist ?? 0) >= 7,
  },
  {
    id: 'sprint', title: 'Sprint', keys: ['RT', 'LS'],
    caption: 'Hold RT while you run to sprint. Sprinting drains the stamina bar; ease off to refill it.',
    setup: m => place(m, { mePos: { x: -14, z: 4 } }),
    demo: { length: 2.6, segs: [{ from: 0.2, to: 2.4, move: [1, 0], sprint: true, pad: { press: ['RT'] } }] },
    track(st, m) { if (me(m).anim === 'sprint') st.sprintT = (st.sprintT ?? 0) + 1 / 60; },
    success: (m, ev, st) => (st.sprintT ?? 0) >= 0.6,
  },
  {
    id: 'pass', title: 'Pass', keys: ['A', 'LS'],
    caption: 'Point the left stick at a teammate and press A to pass to him.',
    setup: m => place(m, { mePos: { x: -6, z: 2 }, mates: [[3, 6, 9], [2, 6, -8]] }),
    demo: { length: 2.4, segs: [{ from: 0.2, to: 1.6, move: [0.8, 0.6] }, { from: 0.8, to: 1.0, pad: { press: ['A'] } }], edges: [{ at: 0.85, edge: 'passPressed' }] },
    success: (m, ev) => humanEvent(ev, 'pass', 'pass'),
    needsBall: true,
  },
  {
    id: 'through', title: 'Through ball', keys: ['Y', 'LS'],
    caption: 'Press Y to play the ball into space ahead of a running teammate.',
    setup: m => place(m, { mePos: { x: -6, z: 2 }, mates: [[3, -2, 11]], active: [[0, 3]] }),
    demo: { length: 2.6, segs: [{ from: 0.2, to: 1.4, move: [0.9, 0.4] }, { from: 0.7, to: 0.9, pad: { press: ['Y'] } }], edges: [{ at: 0.75, edge: 'throughPressed' }] },
    success: (m, ev) => humanEvent(ev, 'pass', 'through'),
    needsBall: true,
  },
  {
    id: 'shoot', title: 'Shoot', keys: ['B'],
    caption: 'Hold B to power up and release to shoot. Steer with the left stick. A quick tap is a quick shot.',
    setup: m => place(m, { mePos: { x: 20, z: 3 } }),
    demo: { length: 2.6, segs: [{ from: 0.1, to: 1.5, move: [1, -0.15] }, { from: 0.5, to: 1.2, shootHeld: true, pad: { press: ['B'] } }],
      edges: [{ at: 0.5, edge: 'shootPressed' }, { at: 1.2, edge: 'shootReleased' }] },
    success: (m, ev) => humanEvent(ev, 'kick', 'shot'),
    needsBall: true,
  },
  {
    id: 'chip', title: 'Chip shot', keys: ['LB', 'B'],
    caption: 'Hold LB and B together, then release B to lob the ball over the keeper.',
    setup: m => place(m, { mePos: { x: 18, z: 2 } }),
    demo: { length: 2.6, segs: [{ from: 0.1, to: 1.4, move: [1, 0] }, { from: 0.5, to: 1.1, shootHeld: true, pad: { press: ['LB', 'B'] } }],
      edges: [{ at: 0.5, edge: 'shootPressed' }, { at: 1.1, edge: 'chipReleased' }] },
    success: (m, ev) => humanEvent(ev, 'kick', 'chip'),
    needsBall: true,
  },
  {
    id: 'onetwo', title: 'One-two', keys: ['LB', 'A'],
    caption: 'Hold LB and press A: pass, then sprint on. The teammate plays it straight back into your run.',
    setup: m => place(m, { mePos: { x: -4, z: 3 }, mates: [[3, 5, 8]], active: [[0, 3]] }),
    demo: { length: 3.0, segs: [{ from: 0.2, to: 2.8, move: [1, 0.15] }, { from: 0.6, to: 0.8, pad: { press: ['LB', 'A'] } }, { from: 0.9, to: 2.8, sprint: true, pad: { press: ['RT'] } }],
      edges: [{ at: 0.65, edge: 'oneTwoPressed' }] },
    success: (m, ev) => humanEvent(ev, 'pass', 'onetwo'),
    needsBall: true,
  },
  {
    id: 'knock', title: 'Knock-on', keys: ['RT', 'B'],
    caption: 'Double-tap RT (or tap B far from goal) to knock the ball ahead and chase it.',
    setup: m => place(m, { mePos: { x: -16, z: 4 } }),
    demo: { length: 2.6, segs: [{ from: 0.1, to: 2.4, move: [1, 0] }, { from: 0.5, to: 0.58, pad: { press: ['RT'] } }, { from: 0.66, to: 2.4, sprint: true, pad: { press: ['RT'] } }],
      edges: [{ at: 0.7, edge: 'knockOnPressed' }] },
    success: (m, ev) => humanEvent(ev, 'knock'),
    needsBall: true,
  },
  {
    id: 'tackle', title: 'Tackle', keys: ['A', 'X'],
    caption: 'Without the ball, press A for a standing tackle, or X to slide in.',
    setup: m => place(m, { mePos: { x: 0, z: 4 }, ball: { owner: [1, 4] }, opps: [[4, 3.4, 4]] }),
    demo: { length: 2.4, segs: [{ from: 0.1, to: 0.9, move: [1, 0] }, { from: 0.9, to: 1.1, pad: { press: ['A'] } }], edges: [{ at: 0.95, edge: 'passPressed' }] },
    track(st, m) { const h = me(m); if (h.anim === 'tackle' || h.anim === 'slide') st.tackled = true; },
    success: (m, ev, st) => !!st.tackled || ev.some(e => e.type === 'steal' && e.team === 0),
  },
  {
    id: 'switch', title: 'Switch priest', keys: ['LB', 'LS'],
    caption: 'Without the ball, tap LB to take over the teammate nearest the ball. Steer with the left stick to pick one.',
    setup: m => place(m, { mePos: { x: -16, z: 12 }, ball: { owner: [1, 4] }, opps: [[4, 10, -2]], mates: [[2, 2, -3]] }),
    start(st, m) { st.from = me(m); },
    demo: { length: 2.0, segs: [{ from: 0.5, to: 0.65, pad: { press: ['LB'] } }], edges: [{ at: 0.65, edge: 'switchPressed' }] },
    success: (m, ev, st) => m.humans[0] && m.humans[0] !== st.from,
  },
  {
    id: 'press', title: 'Call a press', keys: ['RB'],
    caption: 'Hold RB and the nearest teammate runs at the ball carrier.',
    setup: m => place(m, { mePos: { x: -16, z: 12 }, ball: { owner: [1, 4] }, opps: [[4, 10, -2]], mates: [[2, 0, -4]], active: [[0, 2]] }),
    demo: { length: 2.4, segs: [{ from: 0.4, to: 2.0, pad: { press: ['RB'] } }], edges: [{ at: 0.45, edge: 'pressPressed' }, { at: 1.2, edge: 'pressPressed' }] },
    success: m => m.pressT[0] > m.t,
  },
  {
    id: 'autopilot', title: 'Autopilot and aim', keys: ['LT', 'LS', 'A'],
    caption: 'Hold LT: your priest runs by himself for up to 2 s and the left stick only turns the arrow. Aim, then press A.',
    setup: m => place(m, { mePos: { x: -8, z: 2 }, mates: [[3, 4, 12], [2, 4, -8]] }),
    demo: { length: 2.6, segs: [{ from: 0.1, to: 1.9, autoRun: true, pad: { press: ['LT'] } }, { from: 0.4, to: 1.9, move: [0.35, 0.94] }, { from: 1.3, to: 1.5, pad: { press: ['A'] } }],
      edges: [{ at: 1.35, edge: 'passPressed' }] },
    track(st, m, input) { if (input?.autoRun) st.autoT = (st.autoT ?? 0) + 1 / 60; },
    success: (m, ev, st, input) => !!input?.autoRun && (st.autoT ?? 0) >= 0.3 && humanEvent(ev, 'pass'),
    needsBall: true,
  },
  {
    id: 'pray', title: 'Pray', keys: ['RS'],
    caption: 'Push and hold the right stick: ◀ Jesus (unstoppable next shot, uses both prayers), ▲ St George (your priest rides a horse, 30% faster), ▶ Mother Mary (shields your goal) or ▼ St Phanourios (loose balls find your team). The cross fills in 2 s.',
    setup: m => place(m, { mePos: { x: -6, z: 4 } }),
    demo: { length: 2.9, segs: [{ from: 0.2, to: 2.6, prayerHeld: true, prayerJesus: true, pad: { rs: [-1, 0] } }] },
    success: m => !!m.prayers[0].active,
  },
  {
    id: 'pause', title: 'Pause', keys: ['START'],
    caption: 'Press Start to pause. In the pause menu, A resumes; here View quits the tutorial.',
    setup: m => place(m, { mePos: { x: -6, z: 4 } }),
    demo: { length: 1.8, segs: [{ from: 0.5, to: 0.75, pad: { press: ['START'] } }] },
    success: (m, ev, st) => !!st.paused,
  },
];

// The input a step's demonstration sends at demo time t (edges fire once; `fired` remembers them).
export function demoInput(step, t, fired) {
  const inp = blankInput();
  for (const s of step.demo.segs) {
    if (t < s.from || t >= s.to) continue;
    if (s.move) { inp.move.x = s.move[0]; inp.move.z = s.move[1]; }
    for (const k of ['sprint', 'shootHeld', 'autoRun', 'prayerHeld', 'prayerJesus', 'prayerMary', 'prayerGeorge', 'prayerPhanourios']) if (s[k]) inp[k] = true;
  }
  for (const [i, e] of (step.demo.edges ?? []).entries()) {
    if (!fired.has(i) && t >= e.at) { fired.add(i); inp[e.edge] = true; }
  }
  return inp;
}

// One run of the tutorial. Call input() before each sim step and after() with that step's events.
export function createTutorialRunner(steps = TUTORIAL_STEPS, { onChange } = {}) {
  let index = 0, phase = 'watch', t = 0, st = {}, stuckT = 0, fired = new Set();
  const changed = () => onChange?.({ index, phase, step: steps[index], total: steps.length });

  function begin(m, i = index) {
    index = i; t = 0; st = {}; stuckT = 0; fired = new Set();
    if (index >= steps.length) { phase = 'complete'; changed(); return; }
    phase = 'watch';
    steps[index].setup(m);
    steps[index].start?.(st, m);
    changed();
  }
  function startTry(m) {
    phase = 'try'; t = 0; st = {}; stuckT = 0;
    steps[index].setup(m);
    steps[index].start?.(st, m);
    changed();
  }

  // The input to feed team 0 this tick: the scripted demo while watching, the player's pad otherwise.
  function input(m, real) {
    const step = steps[index];
    if (phase !== 'watch' || !step) {
      if (phase === 'complete' || phase === 'done') { const b = blankInput(); b.pausePressed = !!real?.pausePressed; return b; }
      return real;
    }
    const inp = demoInput(step, t, fired);
    inp.pausePressed = !!real?.pausePressed;
    return inp;
  }

  // What the pad diagram shows during the demo (null outside it, so the UI mirrors the real pad).
  function padState() {
    const step = steps[index];
    if (phase !== 'watch' || !step) return null;
    const press = new Set(); let ls = [0, 0], rs = [0, 0];
    for (const s of step.demo.segs) {
      if (t < s.from || t >= s.to) continue;
      if (s.move) ls = s.move;
      for (const k of s.pad?.press ?? []) press.add(k);
      if (s.pad?.rs) rs = s.pad.rs;
    }
    return { press, ls, rs };
  }

  function after(m, events, used, dt) {
    const step = steps[index];
    if (!step || phase === 'complete') return;
    t += dt;
    if (m.humans[0]) m.humans[0].hold = false;         // a priest you switch to always moves
    if (m.phase !== 'play') {                          // a goal or restart: put the drill back
      if (phase === 'try') startTry(m);
      else step.setup(m);
    }
    if (phase === 'watch') {
      if (t >= step.demo.length + WATCH_GAP) startTry(m);
      return;
    }
    if (phase === 'done') {
      if (t >= DONE_BEAT) begin(m, index + 1);
      return;
    }
    step.track?.(st, m, used);
    if (step.success(m, events, st, used)) { phase = 'done'; t = 0; changed(); return; }
    if (step.needsBall) {
      const ours = m.ball.owner?.team === 0 || (m.ball.lastTouch?.team === 0 && Math.hypot(m.ball.vel.x, m.ball.vel.z) > 1);
      stuckT = ours ? 0 : stuckT + dt;
      if (stuckT > STUCK_RESET) startTry(m);
    }
  }

  return {
    begin, input, after, padState,
    skip(m) { if (phase !== 'complete') begin(m, index + 1); },
    notePaused() { if (phase === 'try') st.paused = true; },
    state: () => ({ index, phase, t, step: steps[index], total: steps.length }),
  };
}
