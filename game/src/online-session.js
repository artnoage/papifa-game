import { ACTIONS, packInput, unpackInput, packState, validState, applyState } from './net-state.js';

const byteCount = new TextEncoder();
const MAX_BYTES = 2048, INPUT_MS = 1000 / 30, SNAPSHOT_MS = 50, BUFFER_MS = 100;
const eventTypes = new Set(['kickoff', 'kick', 'pass', 'knock', 'steal', 'tackle', 'receive', 'catch', 'parry', 'goal', 'fulltime', 'replay', 'replayEnd', 'prayer', 'clash', 'maryBlock']);
const neutral = () => ({ move: { x: 0, z: 0 }, aim: null, sprint: false, shootHeld: false, prayerHeld: false, autoRun: false });
const clear = input => { for (const key of ACTIONS) input[key] = false; };
const nextTick = (due, t, period) => due + period > t ? due + period : t + period;
const finiteIn = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function mergeInput(target, input) {
  target.move.x = input.move.x;
  target.move.z = input.move.z;
  target.sprint = !!input.sprint;
  target.shootHeld = !!input.shootHeld;
  target.prayerHeld = !!input.prayerHeld;
  target.autoRun = !!input.autoRun;
  target.aim = input.aim ? { ...input.aim } : null;
  for (const key of ACTIONS) if (input[key]) target[key] = true;
}

function validEvent(e) {
  if (!e || !eventTypes.has(e.type)) return false;
  const teamOptional = ['fulltime', 'replay', 'replayEnd', 'clash'].includes(e.type);
  if (e.team !== undefined ? (e.team !== 0 && e.team !== 1) : !teamOptional) return false;
  if (e.type === 'prayer' && e.kind !== 'jesus' && e.kind !== 'mary' && e.kind !== 'george') return false;
  if (e.kind !== undefined && (typeof e.kind !== 'string' || e.kind.length > 16)) return false;
  if (e.human !== undefined && typeof e.human !== 'boolean') return false;
  if (e.jesus !== undefined && typeof e.jesus !== 'boolean') return false;
  if (e.type === 'clash') {
    if ((e.attacker !== 0 && e.attacker !== 1) || e.defender !== 1 - e.attacker) return false;
  } else if (e.attacker !== undefined || e.defender !== undefined) {
    return false;
  }
  if ((e.x !== undefined && !finiteIn(e.x, -60, 60)) || (e.y !== undefined && !finiteIn(e.y, -5, 20)) || (e.z !== undefined && !finiteIn(e.z, -40, 40))) return false;
  return e.type !== 'replay' || (Number.isFinite(e.from) && Number.isFinite(e.to) && e.to > e.from && e.to - e.from <= 6);
}

// The lobby owns the room handshake and socket. Only the host simulates the match.
// Match packets travel over a direct WebRTC link when one is alive (see p2p.js), else over the relay socket.
// Every packet carries a unique seq, so a packet is applied once whichever path it took and in whatever
// order the two paths deliver: events are re-sorted by time, snapshots never go backwards, and the host
// applies a guest input's held state only from the newest packet but its button presses from every packet.
// Over the lossy direct channel each input also repeats the previous two packets, so a dropped packet
// doesn't lose a pass or a shot.
const SEEN_WINDOW = 512;
export function createOnlineSession(socket, role, now = () => performance.now()) {
  if (role !== 'host' && role !== 'guest') throw new Error('An online match needs a host or guest role.');
  const host = role === 'host';
  let round = host ? 1 : 0, seq = 0, lastSeq = -1, peer = true, offset = Infinity, link = null;
  let nextInput = -Infinity, nextSnapshot = -Infinity, inputAt = -Infinity, previousView = null;
  let seen = new Set(), maxSeen = 0, sentInputs = [];
  const remote = neutral(), outgoing = neutral(), snapshots = [], events = [];
  const stats = { direct: { sent: 0, received: 0 }, relay: { sent: 0, received: 0 } };

  function resetPeer() {
    lastSeq = -1;
    inputAt = nextInput = nextSnapshot = -Infinity;
    offset = Infinity;
    previousView = null;
    snapshots.length = events.length = 0;
    seen = new Set(); maxSeen = 0; sentInputs = [];
    Object.assign(remote, neutral()); clear(remote);
    Object.assign(outgoing, neutral()); clear(outgoing);
  }
  // True the first time a seq is seen this round; false for repeats and for anything older than the window.
  function fresh(s) {
    if (s <= maxSeen - SEEN_WINDOW || seen.has(s)) return false;
    seen.add(s);
    if (s > maxSeen) maxSeen = s;
    if (seen.size > SEEN_WINDOW * 1.5) for (const v of seen) if (v <= maxSeen - SEEN_WINDOW) seen.delete(v);
    return true;
  }

  function send(type, data, disposable = false) {
    if (!peer) return false;
    const direct = !!link?.alive;
    if (!direct && (!socket || socket.readyState !== 1 || (disposable && socket.bufferedAmount > 4096))) return false;
    const packet = { type, seq: ++seq, round, at: Math.round(now()), data };
    const text = JSON.stringify(packet);
    if (byteCount.encode(text).length > MAX_BYTES) throw new Error('Match packet exceeds 2048 bytes.');
    let sent = false;
    if (direct) {
      let out = text;
      if (type === 'input' && sentInputs.length) {
        const redo = JSON.stringify({ ...packet, redo: sentInputs });
        if (byteCount.encode(redo).length <= MAX_BYTES) out = redo;
      }
      sent = link.send(type === 'event' ? 'sure' : 'fast', out);
      if (sent) stats.direct.sent++;
    }
    if (!sent) {
      if (!socket || socket.readyState !== 1) return false;
      socket.send(text);          // the relay only forwards plain packets, never the redo copies
      stats.relay.sent++;
    }
    if (type === 'input') { sentInputs.push([packet.seq, data]); if (sentInputs.length > 2) sentInputs.shift(); }
    return true;
  }

  function receive(text, path) {
    if (!peer || typeof text !== 'string' || text.length > MAX_BYTES || byteCount.encode(text).length > MAX_BYTES) return;
    let p;
    try { p = JSON.parse(text); } catch { return; }
    if (!p || !Number.isSafeInteger(p.seq) || p.seq < 1 || !Number.isSafeInteger(p.at) || p.at < 0 ||
        !Number.isSafeInteger(p.round) || p.round < 1 || p.round < round) return;
    const arrival = now();
    if (host) {
      if (p.type !== 'input' || p.round !== round) return;
      const input = unpackInput(p.data);
      if (!input) return;
      // Button presses from the repeated earlier packets that never arrived on their own.
      if (path === 'direct' && Array.isArray(p.redo)) {
        for (const r of p.redo.slice(0, 2)) {
          if (!Array.isArray(r) || r.length !== 2 || !Number.isSafeInteger(r[0]) || r[0] >= p.seq) continue;
          const earlier = unpackInput(r[1]);
          if (earlier && fresh(r[0])) for (const key of ACTIONS) if (earlier[key]) remote[key] = true;
        }
      }
      if (!fresh(p.seq)) return;
      if (p.seq > lastSeq) {
        mergeInput(remote, input);
        lastSeq = p.seq;
        inputAt = arrival;
      } else {
        for (const key of ACTIONS) if (input[key]) remote[key] = true;
      }
    } else {
      if (p.type === 'snapshot' ? !validState(p.data) : p.type !== 'event' || !validEvent(p.data)) return;
      if (p.round > round) {
        resetPeer();
        round = p.round;
      }
      if (!fresh(p.seq)) return;
      offset = Math.min(offset, arrival - p.at);
      if (p.type === 'snapshot') {
        if (snapshots.length && p.at < snapshots.at(-1).at) return;
        snapshots.push(p);
        if (snapshots.length > 32) snapshots.shift();
      } else {
        let i = events.length;
        while (i > 0 && events[i - 1].at > p.at) i--;
        events.splice(i, 0, p);
        if (events.length > 128) events.shift();
      }
      lastSeq = Math.max(lastSeq, p.seq);
    }
    stats[path].received++;
  }

  const fromSocket = ({ data }) => receive(data, 'relay');
  function disconnected() {
    if (link?.alive) return;
    peer = false;
    resetPeer();
  }
  function listen(s) {
    if (!s) return;
    s.addEventListener('message', fromSocket);
    s.addEventListener('close', disconnected);
  }
  function detach() {
    if (!socket) return;
    socket.removeEventListener('message', fromSocket);
    socket.removeEventListener('close', disconnected);
  }
  listen(socket);

  return {
    role,
    get round() { return round; },
    get connected() { return peer && (!!link?.alive || socket?.readyState === 1); },
    // 'direct' while the WebRTC link carries the match, else 'relay'.
    get transport() { return link?.alive ? 'direct' : 'relay'; },
    get stats() { return stats; },
    // The lobby hands over a peer link (p2p.js) once signaling starts; its packets arrive here.
    setLink(next) { if (link && link !== next) link.close(); link = next; },
    receiveDirect(text) { receive(text, 'direct'); },
    setPeerConnected(on) { if (peer !== on) { peer = on; resetPeer(); } },
    replaceSocket(next) { detach(); socket = next; peer = true; resetPeer(); listen(socket); },
    // Silently attach a fallback relay socket mid-match without discarding in-flight snapshots.
    attachSocket(next) { detach(); socket = next; peer = true; listen(socket); },
    detachSocket() { detach(); socket = null; },
    dispose() { detach(); link?.close(); link = null; disconnected(); },
    newRound() { if (host) { round++; resetPeer(); } },
    guestInput(input) {
      if (host || !round || !peer) return;
      mergeInput(outgoing, input);
      const t = now();
      if (t + 0.001 < nextInput || !send('input', packInput(outgoing), true)) return;
      nextInput = nextTick(nextInput, t, INPUT_MS);
      clear(outgoing);
    },
    remoteInput() {
      if (!host || !peer) return null;
      if (Number.isFinite(inputAt) && now() - inputAt > 500) {
        Object.assign(remote, neutral()); clear(remote); inputAt = -Infinity;
      }
      return remote;
    },
    clearRemoteActions() { clear(remote); },
    hostSnapshot(match, view = 'live', force = false) {
      if (!host || !peer) return;
      const t = now();
      if (!force && view === previousView && t + 0.001 < nextSnapshot) return;
      if (send('snapshot', packState(match, view), !force)) {
        nextSnapshot = nextTick(nextSnapshot, t, SNAPSHOT_MS);
        previousView = view;
      }
    },
    hostEvent(event) {
      if (!host || !validEvent(event)) return;
      const out = { type: event.type };
      for (const k of ['team', 'kind', 'human', 'from', 'to', 'attacker', 'defender', 'jesus', 'x', 'y', 'z']) {
        if (event[k] !== undefined) out[k] = event[k];
      }
      send('event', out);
    },
    present(match) {
      if (host || !snapshots.length) return null;
      const cursor = now() - offset - BUFFER_MS;
      while (snapshots.length > 1 && snapshots[1].at <= cursor) snapshots.shift();
      const a = snapshots[0], b = snapshots[1] ?? a;
      if (a.data.actors.length !== match.players.length + 1) return null;
      const alpha = b.at > a.at ? Math.max(0, Math.min(1, (cursor - a.at) / (b.at - a.at))) : 0;
      applyState(match, a.data, b.data, alpha);
      const due = [];
      while (events.length && events[0].at <= cursor) due.push(events.shift().data);
      return { view: a.data.view, events: due };
    },
  };
}
