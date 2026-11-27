// Direct host<->guest link for online matches (WebRTC DataChannels), with the relay as signaling and fallback.
// The relay introduces the two players: the host's offer and the guest's answer travel through it as
// chunked `signal` messages (each complete SDP carries its ICE candidates, so there is no trickle traffic).
// Once both channels are open and the peer keeps talking, match packets go direct; otherwise they keep
// going through the relay, so a blocked or broken direct path never stops a match.

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
export const SIGNAL_CHUNK = 1200;      // characters of SDP per relay message (relay packets are capped at 2048 bytes)
export const SIGNAL_MAX_CHUNKS = 8;
const GATHER_MS = 2500;                // wait this long for ICE gathering before sending what we have
const PING_MS = 400;                   // keep-alive on the fast channel, both ways
const STALE_MS = 3000;                 // no direct packet for this long: fall back to the relay until they resume
const PING = 'p';

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

// Build-time relay URL injected by scripts/build-web.mjs --relay, or null in serverless public builds.
export function configuredRelayUrl(doc = globalThis.document) {
  const raw = doc?.querySelector?.('meta[name="papifa-relay"]')?.getAttribute?.('content')?.trim();
  if (!raw || raw.toLowerCase() === 'none') return null;
  try {
    const u = new URL(raw);
    if (u.protocol === 'wss:' || (u.protocol === 'ws:' && isLoopbackHost(u.hostname))) return u.href;
  } catch { /* ignore invalid meta */ }
  return null;
}

// The relay's address when this build has a relay configured, or null in serverless invite-code builds.
// On a local loopback HTTP server (dev/test), a configured build or ?relay=local uses the local /papifa/net proxy.
export function relayUrl(loc = globalThis.location, doc = globalThis.document) {
  const configured = configuredRelayUrl(doc);
  const localHttp = loc?.protocol === 'http:' && isLoopbackHost(loc.hostname);
  if (localHttp && (configured || new URLSearchParams(loc.search || '').get('relay') === 'local')) {
    const url = new URL('/papifa/net', loc.href);
    url.protocol = 'ws:';
    return url;
  }
  if (configured) return new URL(configured);
  return null;
}

export function hasRelay(loc = globalThis.location, doc = globalThis.document) {
  return relayUrl(loc, doc) !== null;
}

// Split one SDP into relay-sized signal messages.
export function chunkSignal(kind, id, sdp) {
  const n = Math.max(1, Math.ceil(sdp.length / SIGNAL_CHUNK));
  if (n > SIGNAL_MAX_CHUNKS) return null;
  return Array.from({ length: n }, (_, i) => ({ kind, id, i, n, sdp: sdp.slice(i * SIGNAL_CHUNK, (i + 1) * SIGNAL_CHUNK) }));
}

export function validSignal(s) {
  return !!s && typeof s === 'object' && (s.kind === 'offer' || s.kind === 'answer') &&
    Number.isSafeInteger(s.id) && s.id > 0 && Number.isInteger(s.n) && s.n >= 1 && s.n <= SIGNAL_MAX_CHUNKS &&
    Number.isInteger(s.i) && s.i >= 0 && s.i < s.n && typeof s.sdp === 'string' && s.sdp.length <= SIGNAL_CHUNK;
}

// Reassemble chunks of one (kind, id) description; returns the full SDP once every chunk has arrived.
export function createSignalAssembler() {
  let key = '', parts = [];
  return function add(s) {
    if (!validSignal(s)) return null;
    const k = `${s.kind}:${s.id}:${s.n}`;
    if (k !== key) { key = k; parts = new Array(s.n).fill(null); }
    parts[s.i] = s.sdp;
    if (parts.some((p) => p === null)) return null;
    key = ''; const sdp = parts.join(''); parts = [];
    return sdp;
  };
}

// One direct link per host<->guest pairing. `sendSignal(data)` posts a signal message through the relay;
// `onMessage(text)` receives match packets that arrived directly. The host calls start(); both sides pass
// incoming relay signals to handle().
export function createPeerLink({ role, sendSignal = () => {}, onMessage, onChange = () => {}, onFailed = () => {}, now = () => performance.now(),
  RTC = globalThis.RTCPeerConnection, iceServers = ICE_SERVERS } = {}) {
  const host = role === 'host';
  let pc = null, fast = null, sure = null, id = 0, closed = false, lastRecv = -Infinity, wasAlive = false;
  const assemble = createSignalAssembler();
  const timer = setInterval(() => {
    if (fast?.readyState === 'open') { try { fast.send(PING); } catch { /* closing */ } }
    notify();
  }, PING_MS);

  function alive() {
    return !closed && fast?.readyState === 'open' && sure?.readyState === 'open' && now() - lastRecv < STALE_MS;
  }
  function notify() {
    const on = alive();
    if (on !== wasAlive) { wasAlive = on; onChange(on); }
  }
  function wire(ch) {
    if (ch.label === 'fast') fast = ch; else if (ch.label === 'sure') sure = ch; else return;
    ch.addEventListener('open', () => { lastRecv = now(); notify(); });
    ch.addEventListener('close', notify);
    ch.addEventListener('message', ({ data }) => {
      lastRecv = now();
      if (data !== PING && typeof data === 'string') onMessage(data);
      notify();
    });
  }
  function newPc() {
    pc?.close();
    fast = sure = null;
    pc = new RTC({ iceServers });
    pc.addEventListener('connectionstatechange', () => {
      if (pc && ['failed', 'closed'].includes(pc.connectionState)) {
        const failed = pc.connectionState === 'failed';
        fast = sure = null;
        notify();
        if (failed && !closed) onFailed();
      } else {
        notify();
      }
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc && pc.iceConnectionState === 'failed' && !closed) onFailed();
    });
    if (!host) pc.addEventListener('datachannel', ({ channel }) => wire(channel));
    return pc;
  }
  // The complete local description (with every candidate gathered so far), once gathering ends or times out.
  function gathered(conn) {
    return new Promise((resolve) => {
      if (conn.iceGatheringState === 'complete') { resolve(); return; }
      const done = () => { clearTimeout(t); conn.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (conn.iceGatheringState === 'complete') done(); };
      const t = setTimeout(done, GATHER_MS);
      conn.addEventListener('icegatheringstatechange', check);
    });
  }
  async function publish(conn, kind) {
    await gathered(conn);
    if (closed || conn !== pc || !conn.localDescription) return;
    const chunks = chunkSignal(kind, id, conn.localDescription.sdp);
    if (chunks) for (const c of chunks) sendSignal(c);
  }

  return {
    get alive() { return alive(); },
    // Host: open the channels and send the offer.
    async start() {
      if (!host || closed || !RTC) return;
      id = 1 + Math.floor(Math.random() * 2 ** 31);
      const conn = newPc();
      wire(conn.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      wire(conn.createDataChannel('sure', { ordered: true }));
      try {
        await conn.setLocalDescription(await conn.createOffer());
        await publish(conn, 'offer');
      } catch { /* stay on the relay */ }
    },
    // Either side: a signal chunk that came through the relay.
    async handle(signal) {
      if (closed || !RTC || !validSignal(signal)) return;
      if (host ? signal.kind !== 'answer' || signal.id !== id : signal.kind !== 'offer') return;
      const sdp = assemble(signal);
      if (!sdp) return;
      try {
        if (host) {
          if (pc && pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp });
        } else {
          id = signal.id;
          const conn = newPc();
          await conn.setRemoteDescription({ type: 'offer', sdp });
          await conn.setLocalDescription(await conn.createAnswer());
          await publish(conn, 'answer');
        }
      } catch { /* stay on the relay */ }
    },
    // Manual invite-code signalling: gather a complete non-trickle offer/answer SDP without a relay.
    async createOfferSdp() {
      if (!host || closed || !RTC) throw new Error('WebRTC is unavailable in this browser.');
      const conn = newPc();
      wire(conn.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
      wire(conn.createDataChannel('sure', { ordered: true }));
      await conn.setLocalDescription(await conn.createOffer());
      await gathered(conn);
      if (closed || conn !== pc || !conn.localDescription) throw new Error('Cancelled');
      return conn.localDescription.sdp;
    },
    async acceptOfferSdp(offerSdp) {
      if (host || closed || !RTC) throw new Error('WebRTC is unavailable in this browser.');
      const conn = newPc();
      await conn.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      await conn.setLocalDescription(await conn.createAnswer());
      await gathered(conn);
      if (closed || conn !== pc || !conn.localDescription) throw new Error('Cancelled');
      return conn.localDescription.sdp;
    },
    async acceptAnswerSdp(answerSdp) {
      if (!host || closed || !pc || pc.signalingState !== 'have-local-offer') {
        throw new Error('No pending invite — create a new invite code first.');
      }
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    },
    // Send a match packet directly; false when the direct path isn't usable right now.
    send(channel, text) {
      const ch = channel === 'sure' ? sure : fast;
      if (!alive() || ch?.readyState !== 'open') return false;
      if (channel === 'fast' && ch.bufferedAmount > 16384) return true;   // congested: drop this disposable packet
      try { ch.send(text); return true; } catch { return false; }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { pc?.close(); } catch { /* already closed */ }
      pc = fast = sure = null;
      notify();
    },
  };
}
