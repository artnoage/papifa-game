import assert from 'node:assert/strict';
import { createMatch, step } from '../src/sim.js';
import { packState, validState, applyState, packInput, unpackInput } from '../src/net-state.js';
import { createOnlineSession } from '../src/online-session.js';

let elapsed = 0;
const pending = [], traffic = [];
class Link extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  send(text) {
    const packet = JSON.parse(text);
    traffic.push({ packet, bytes: Buffer.byteLength(text) });
    // An ordered link with 30 ms one-way delay and periodic jitter.
    const due = elapsed + 30 + (packet.seq % 3) * 4;
    this.deliverAt = Math.max(due, this.deliverAt ?? 0);
    pending.push({ to: this.peer, at: this.deliverAt, text });
  }
}
function pair() { const a = new Link(), b = new Link(); a.peer = b; b.peer = a; return [a, b]; }
function deliver() {
  for (const item of [...pending]) if (item.at <= elapsed) {
    item.to.dispatchEvent(new MessageEvent('message', { data: item.text }));
    pending.splice(pending.indexOf(item), 1);
  }
}
const [h, g] = pair();
const host = createOnlineSession(h, 'host', () => elapsed);
const guest = createOnlineSession(g, 'guest', () => elapsed + 4000);
const sim = createMatch(19, { humans: [true, true] }), screen = createMatch(7, { humans: [true, true] });
const idle = { move: { x: 0, z: 0 } };
let sawPass = 0, interpolated = false;
const seen = [];
const seenEvents = [];
for (let frame = 0; frame < 300; frame++) {
  elapsed = frame * 1000 / 60;
  deliver();
  const state = guest.present(screen);
  if (state) {
    seen.push(...state.events.map(e => e.type));
    seenEvents.push(...state.events);
  }
  if (screen.t > 0.5 && Math.abs(screen.t * 20 - Math.round(screen.t * 20)) > .1) interpolated = true;
  // Guest holds prayer during frames 40..175 (> 2.0 s) to charge, then picks Mary at frame 190.
  const praying = frame >= 40 && frame <= 175;
  guest.guestInput({
    move: { x: -0.73, z: .3 }, sprint: true,
    passPressed: frame === 27,
    prayerHeld: praying,
    prayerMary: frame === 190,
  });
  const remote = host.remoteInput();
  if (remote.passPressed) sawPass++;
  step(sim, [idle, remote], 1 / 60);
  host.clearRemoteActions();
  for (const ev of sim.events) {
    if (ev.type === 'prayer' || ev.type === 'clash' || ev.type === 'maryBlock') host.hostEvent(ev);
  }
  if (frame === 80) host.hostEvent({ type: 'goal', team: 1, jesus: true });
  if (frame === 160) host.hostEvent({ type: 'replay', from: .2, to: 2.5 });
  if (frame === 210) host.hostEvent({ type: 'clash', attacker: 0, defender: 1, x: 18.5, y: 1.1, z: 0.4 });
  if (frame === 220) host.hostEvent({ type: 'maryBlock', team: 1, x: 24.4, y: 1.0, z: -0.6 });
  // Malformed prayer / clash events must be dropped by hostEvent.
  if (frame === 225) {
    host.hostEvent({ type: 'prayer', team: 0, kind: 'other' });
    host.hostEvent({ type: 'clash', attacker: 0, defender: 0, x: 0, y: 1, z: 0 });
  }
  if (frame === 250) host.hostEvent({ type: 'replayEnd' });
  host.hostSnapshot(sim, 'live');
}
assert.equal(sawPass, 1, 'one display-frame input edge survives the send interval and fires once');
assert.deepEqual(seen, ['goal', 'replay', 'prayer', 'clash', 'maryBlock', 'replayEnd']);
assert.equal(seenEvents.find(e => e.type === 'goal')?.jesus, true);
assert.deepEqual(seenEvents.find(e => e.type === 'prayer'), { type: 'prayer', team: 1, kind: 'mary', human: true });
assert.deepEqual(seenEvents.find(e => e.type === 'clash'), { type: 'clash', attacker: 0, defender: 1, x: 18.5, y: 1.1, z: 0.4 });
assert.deepEqual(seenEvents.find(e => e.type === 'maryBlock'), { type: 'maryBlock', team: 1, x: 24.4, y: 1.0, z: -0.6 });
assert.equal(sim.prayers[1].active, 'mary', 'guest charging + Mary pick activates Mary on host');
assert.equal(screen.prayers[1].active, 'mary', 'active Mary prayer syncs into guest snapshots');
assert.equal(screen.prayers[1].remaining, 1, 'remaining prayer count decrements on guest');
assert.ok(screen.prayers[1].timeLeft > 10 && screen.prayers[1].timeLeft <= 12, 'Mary lasts 12 s');
assert.ok(interpolated && sim.t - screen.t < .25 && screen.t < sim.t);
const count = type => traffic.filter(x => x.packet.type === type).length;
assert.ok(count('input') >= 142 && count('input') <= 150);
assert.ok(count('snapshot') >= 99 && count('snapshot') <= 101);
assert.ok(traffic.every(x => x.bytes <= 2048));
assert.deepEqual(screen.humans.map(x => x.team), [0, 1]);
const snap = packState(sim, 'live');
assert.ok(validState(snap)); assert.ok(!validState({ ...snap, ball: [] }));
assert.ok(!validState({ ...snap, prayers: [[3, 0, 0, 0, 0, -1], [2, 0, 0, 0, 0, -1]] }), 'prayers remaining > 2 rejected');
assert.ok(!validState({ ...snap, prayers: [[2, 0, 0, 5, 0, -1], [2, 0, 0, 0, 0, -1]] }), 'invalid active prayer index rejected');
assert.ok(validState({ ...snap, prayers: [[1, 0, 0, 4, 14000, -1], [2, 0, 0, 0, 0, -1]] }), 'St Phanourios prayer accepted');
assert.ok(!validState({ ...snap, prayers: [[1, 0, 0, 3, 12000, 99], [2, 0, 0, 0, 0, -1]] }), 'invalid riderSlot rejected');
assert.ok(validState({ ...snap, prayers: [[1, 0, 0, 3, 12000, 4], [2, 0, 0, 0, 0, -1]] }), 'valid St George prayer + riderSlot accepted');
assert.ok(!validState({ ...snap, ball: [...snap.ball.slice(0, 7), 16] }), 'invalid ball flag bitmask rejected');
assert.ok(!validState({ ...snap, ball: [...snap.ball.slice(0, 7), 12] }), 'a ball found by both teams is rejected');
// St Phanourios: the active kind and the "found by" ball flag reach the guest.
const phanSnap = structuredClone(snap);
phanSnap.prayers[1] = [1, 0, 0, 4, 14000, -1];
phanSnap.ball[6] = -1; phanSnap.ball[7] = 8;
assert.ok(validState(phanSnap));
applyState(screen, phanSnap, phanSnap, 0.5);
assert.equal(screen.prayers[1].active, 'phanourios');
assert.equal(screen.ball.foundBy, 1);
phanSnap.ball[7] = 0;
applyState(screen, phanSnap, phanSnap, 0.5);
assert.equal(screen.ball.foundBy, null);
// Verify St George prayer + riderSlot syncs cleanly into guest snapshots.
const georgeSnap = structuredClone(snap);
georgeSnap.prayers[0] = [1, 0, 0, 3, 14100, 4];
applyState(screen, georgeSnap, georgeSnap, 0.5);
assert.equal(screen.prayers[0].active, 'george');
assert.equal(screen.prayers[0].riderSlot, 4);
assert.ok(!unpackInput([0, 0, [99999, 0], 0])); assert.ok(!unpackInput([0, 0, null, 2 ** 30]), "out-of-range flag mask rejected");
const shot = unpackInput(packInput({ move: { x: .2, z: -1 }, aim: { x: 23.12, z: -5.31 }, shootReleased: true, prayerHeld: true, prayerJesus: true }));
assert.deepEqual(shot.aim, { x: 23.12, z: -5.31 });
assert.ok(shot.shootReleased && !shot.shootHeld && shot.prayerHeld && shot.prayerJesus && !shot.prayerMary);
// Verify Jesus shot ball flag preserves shot reference stability across frames on guest.
const jesusSnap = structuredClone(snap);
jesusSnap.ball[7] = 1;
applyState(screen, jesusSnap, jesusSnap, 0.5);
const shotRef1 = screen.ball.shot;
assert.ok(shotRef1?.jesus && !screen.ball.inNet);
applyState(screen, jesusSnap, jesusSnap, 0.75);
assert.equal(screen.ball.shot, shotRef1, 'Jesus shot reference remains stable across interpolated snapshots');
const netSnap = structuredClone(snap);
netSnap.ball[7] = 3;
applyState(screen, netSnap, netSnap, 0.5);
assert.ok(screen.ball.shot?.jesus && screen.ball.inNet);
const other = structuredClone(snap);
other.actors[0][0] += 80;
applyState(screen, snap, other, .5); assert.equal(screen.players[0].pos.x, (snap.actors[0][0] + 40) / 100);
other.phase = 'goal'; applyState(screen, snap, other, .75); assert.equal(screen.players[0].pos.x, snap.actors[0][0] / 100);
const previous = traffic.filter(x => x.packet.type === 'input').at(-1).packet;
g.send(JSON.stringify({ ...previous, data: packInput({ ...idle, shootPressed: true }) }));
elapsed += 120; deliver(); assert.ok(!host.remoteInput().shootPressed, 'duplicates are ignored');
h.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ ...previous, type: 'snapshot', seq: 99999, data: snap }) }));
assert.ok(!host.remoteInput().shootPressed);
elapsed += 550; assert.deepEqual(host.remoteInput().move, { x: 0, z: 0 });
host.setPeerConnected(false); assert.equal(host.remoteInput(), null);
const [h2, g2] = pair(); host.replaceSocket(h2); guest.replaceSocket(g2);
host.newRound(); host.hostSnapshot(createMatch(2, { size: 3, humans: [true,true] }));
elapsed += 50; deliver();
assert.equal(guest.round, 2);
assert.ok(guest.present(createMatch(1, { size: 3 }))); assert.equal(guest.present(screen), null);
host.dispose(); guest.dispose();
console.log('Simulated 5 seconds,', count('input'), 'guest inputs,', count('snapshot'), 'host snapshots. Largest packet', Math.max(...traffic.map(x => x.bytes)), 'bytes.');
