import assert from 'node:assert/strict';
import { createMatch } from '../src/sim.js';
import { packState } from '../src/net-state.js';
import { createOnlineSession } from '../src/online-session.js';
import { SIGNAL_CHUNK, chunkSignal, configuredRelayUrl, createSignalAssembler, hasRelay, relayUrl, validSignal } from '../src/p2p.js';

// 1. Relay address: only present when configured via <meta name="papifa-relay"> (or ?relay=local on loopback).
const docWithRelay = (content) => ({
  querySelector: (sel) => (sel === 'meta[name="papifa-relay"]' ? { getAttribute: () => content } : null),
});
const emptyDoc = { querySelector: () => null };
assert.equal(configuredRelayUrl(emptyDoc), null);
assert.equal(configuredRelayUrl(docWithRelay('wss://relay.example/papifa/net')), 'wss://relay.example/papifa/net');
assert.equal(configuredRelayUrl(docWithRelay('http://relay.example/papifa/net')), null, 'non-wss remote URL rejected');
assert.equal(relayUrl(new URL('papifa://app/index.html'), emptyDoc), null, 'serverless desktop build has no relay');
assert.equal(relayUrl(new URL('https://play.example/papifa/'), emptyDoc), null, 'serverless web build has no relay');
assert.equal(hasRelay(new URL('https://play.example/papifa/'), emptyDoc), false);
assert.equal(String(relayUrl(new URL('papifa://app/index.html'), docWithRelay('wss://relay.example/papifa/net'))), 'wss://relay.example/papifa/net');
assert.equal(String(relayUrl(new URL('https://play.example/papifa/'), docWithRelay('wss://relay.example/papifa/net'))), 'wss://relay.example/papifa/net');
assert.equal(String(relayUrl(new URL('http://127.0.0.1:8080/?size=3'), docWithRelay('wss://relay.example/papifa/net'))), 'ws://127.0.0.1:8080/papifa/net', 'configured build on loopback routes to local /papifa/net proxy');
assert.equal(String(relayUrl(new URL('http://127.0.0.1:8080/?relay=local'), emptyDoc)), 'ws://127.0.0.1:8080/papifa/net');
assert.equal(relayUrl(new URL('http://127.0.0.1:8080/?size=3'), emptyDoc), null, 'no-relay build stays serverless on loopback too');

// 2. Signal chunking: an SDP splits into relay-sized chunks and reassembles in order; junk is rejected.
{
  const sdp = 'v=0\r\n' + 'a=candidate:1 1 udp 2113937151 192.0.2.5 50000 typ host\r\n'.repeat(40);
  const chunks = chunkSignal('offer', 9, sdp);
  assert.ok(chunks.length > 1 && chunks.every(c => c.sdp.length <= SIGNAL_CHUNK && validSignal(c)));
  const add = createSignalAssembler();
  for (const c of chunks.slice(0, -1)) assert.equal(add(c), null);
  assert.equal(add(chunks.at(-1)), sdp);
  assert.equal(chunkSignal('offer', 9, 'x'.repeat(SIGNAL_CHUNK * 9)), null, 'too big for 8 chunks');
  for (const bad of [null, { kind: 'bye', id: 1, i: 0, n: 1, sdp: '' }, { kind: 'offer', id: 0, i: 0, n: 1, sdp: '' },
    { kind: 'offer', id: 1, i: 1, n: 1, sdp: '' }, { kind: 'offer', id: 1, i: 0, n: 9, sdp: '' },
    { kind: 'offer', id: 1, i: 0, n: 1, sdp: 'x'.repeat(SIGNAL_CHUNK + 1) }]) assert.equal(validSignal(bad), false);
}

// Fake relay socket and direct link that record what was sent through them.
function fakeSocket() {
  const s = new EventTarget();
  s.readyState = 1; s.bufferedAmount = 0; s.sent = [];
  s.send = text => s.sent.push(text);
  return s;
}
function fakeLink(alive = true) {
  return { alive, sent: [], send(channel, text) { if (!this.alive) return false; this.sent.push({ channel, text }); return true; }, close() { this.alive = false; } };
}
let clock = 1000;
const now = () => clock;
const idle = () => ({ move: { x: 0, z: 0 }, aim: null, sprint: false, shootHeld: false, prayerHeld: false, autoRun: false });

// 3. Guest input: over the direct link each packet repeats the last two; over the relay it never does.
{
  const sock = fakeSocket(), link = fakeLink(true);
  const g = createOnlineSession(sock, 'guest', now);
  g.receiveDirect(JSON.stringify({ type: 'event', seq: 1, round: 1, at: 1, data: { type: 'kickoff', team: 0 } }));   // round 1
  g.setLink(link);
  assert.equal(g.transport, 'direct');
  g.guestInput({ ...idle(), passPressed: true }); clock += 40;
  g.guestInput({ ...idle(), move: { x: 1, z: 0 } }); clock += 40;
  g.guestInput(idle()); clock += 40;
  assert.equal(link.sent.length, 3);
  assert.ok(link.sent.every(p => p.channel === 'fast'), 'inputs use the fast (unreliable) channel');
  const pk = link.sent.map(p => JSON.parse(p.text));
  assert.equal(pk[0].redo, undefined);
  assert.deepEqual(pk[2].redo.map(r => r[0]), [pk[0].seq, pk[1].seq], 'third packet repeats the first two');
  link.alive = false;
  assert.equal(g.transport, 'relay');
  g.guestInput(idle());
  assert.equal(sock.sent.length, 1, 'falls back to the relay when the link is not alive');
  assert.equal(JSON.parse(sock.sent[0]).redo, undefined, 'relay packets carry no redo copies');

  // 4. Host: the pass in packet 1 survives packet 1 being lost; a late or duplicate copy never applies it twice;
  // an older packet never overwrites the newer stick position.
  const h = createOnlineSession(fakeSocket(), 'host', now);
  h.receiveDirect(link.sent[2].text);                         // packet 3 only (1 and 2 lost) carries 1 and 2
  assert.equal(h.remoteInput().passPressed, true, 'pass recovered from the repeat');
  assert.equal(h.remoteInput().move.x, 0, 'held state comes from the newest packet');
  h.clearRemoteActions();
  h.receiveDirect(link.sent[0].text);                         // the lost packet 1 shows up late
  h.receiveDirect(link.sent[1].text);
  assert.equal(h.remoteInput().passPressed, false, 'no double pass');
  assert.equal(h.remoteInput().move.x, 0, 'older packet does not overwrite the newer stick');
  const relayCopy = sock.sent[0];
  h.receiveDirect(relayCopy); h.receiveDirect(relayCopy);    // same packet twice
  assert.equal(h.stats.direct.received, 2, 'duplicates are not counted as new');
}

// 5. Guest receives events from both paths in mixed order: each applies once, in time order.
{
  const m = createMatch(5, { size: 3, humans: [true, true] });
  const g = createOnlineSession(fakeSocket(), 'guest', now);
  const snap = (seq, at) => JSON.stringify({ type: 'snapshot', seq, round: 1, at, data: packState(m, 'live') });
  const ev = (seq, at, team) => JSON.stringify({ type: 'event', seq, round: 1, at, data: { type: 'kick', team } });
  clock = 5000;
  g.receiveDirect(snap(1, 4000));
  g.receiveDirect(ev(4, 4030, 1));          // arrived first over the direct channel
  g.receiveDirect(snap(5, 4050));
  const relayEv = ev(3, 4020, 0);           // the earlier event came the slow way, through the relay
  g.receiveDirect(relayEv); g.receiveDirect(relayEv);
  g.receiveDirect(snap(2, 3990));           // an older snapshot is ignored
  clock = 5400;
  const out = g.present(m);
  assert.deepEqual(out.events.map(e => e.team), [0, 1], 'events in time order, each once');
  assert.equal(g.stats.direct.received, 4);
}

// 6. Host packets: snapshots go on the fast channel, events on the reliable one; dispose closes the link.
{
  const link = fakeLink(true);
  const h = createOnlineSession(fakeSocket(), 'host', now);
  h.setLink(link);
  const m = createMatch(6, { size: 3, humans: [true, true] });
  h.hostSnapshot(m, 'live', true);
  h.hostEvent({ type: 'goal', team: 1 });
  assert.deepEqual(link.sent.map(p => [JSON.parse(p.text).type, p.channel]), [['snapshot', 'fast'], ['event', 'sure']]);
  h.dispose();
  assert.equal(link.alive, false);
}

console.log('p2p transport tests passed (signal chunks, input repeats, dedupe, event order, channel choice).');
