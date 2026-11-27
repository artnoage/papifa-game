// Compact binary packer/unpacker for invite & reply codes (manual WebRTC signalling + silent relay pairing).
// Strips a DataChannel-only SDP to the minimum fields needed for ICE + DTLS + SCTP,
// carries a 96-bit random sessionId and 96-bit random token (confirmed by the reply),
// packs match setup into 1 byte, protects the payload with a version prefix and IEEE CRC-32,
// and reconstructs a valid WebRTC SDP on the receiving side (~150-240 URL-safe characters).

const VERSION = 1;
const PREFIX_INVITE = 'P1I-';
const PREFIX_REPLY = 'P1R-';
const SESSION_BYTES = 12; // 96 bits
const TOKEN_BYTES = 12;   // 96 bits
const MAX_CANDIDATES = 6;

const FIELDS = ['courtyard', 'meteora', 'winter'];
const LEVELS = ['veryEasy', 'easy', 'normal', 'hard', 'veryHard'];
const SETUP_ROLES = ['actpass', 'active', 'passive'];
const CAND_TYPES = ['host', 'srflx', 'prflx'];
const CAND_PRIORITIES = {
  host: 2122260223,
  srflx: 1686052607,
  prflx: 1853824767,
};

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function randomHex(byteCount = 12) {
  const buf = new Uint8Array(byteCount);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(buf);
  } else {
    for (let i = 0; i < byteCount; i++) buf[i] = Math.floor(Math.random() * 256);
  }
  return bytesToHex(buf);
}

function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex, expectedBytes) {
  if (typeof hex !== 'string' || hex.length !== expectedBytes * 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(expectedBytes);
  for (let i = 0; i < expectedBytes; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  if (!/^[A-Za-z0-9_-]+$/.test(str)) return null;
  const pad = (4 - (str.length % 4)) % 4;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function parseIpv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null;
    const n = Number(parts[i]);
    if (n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function formatIpv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function parseIpv6(ip) {
  if (!ip.includes(':') || ip.includes('%')) return null;
  const pieces = ip.split('::');
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(':') : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if ((pieces.length === 1 && missing !== 0) || (pieces.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const val = parseInt(groups[i], 16);
    out[i * 2] = (val >>> 8) & 0xff;
    out[i * 2 + 1] = val & 0xff;
  }
  return out;
}

function formatIpv6(bytes) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  }
  return parts.join(':');
}

function parseFingerprint(hexColon) {
  const parts = hexColon.trim().split(':');
  if (parts.length !== 32) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    if (!/^[0-9a-fA-F]{2}$/.test(parts[i])) return null;
    out[i] = parseInt(parts[i], 16);
  }
  return out;
}

function formatFingerprint(bytes) {
  return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
}

export function extractSdpFields(sdp) {
  if (typeof sdp !== 'string' || !sdp.trim()) throw new Error('Empty SDP');
  let ufrag = '';
  let pwd = '';
  let fingerprint = null;
  let setup = '';
  let mid = '0';
  const rawCands = [];
  const seen = new Set();

  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('a=ice-ufrag:')) {
      ufrag = line.slice('a=ice-ufrag:'.length).trim();
    } else if (line.startsWith('a=ice-pwd:')) {
      pwd = line.slice('a=ice-pwd:'.length).trim();
    } else if (line.startsWith('a=fingerprint:sha-256 ')) {
      fingerprint = parseFingerprint(line.slice('a=fingerprint:sha-256 '.length));
    } else if (line.startsWith('a=setup:')) {
      setup = line.slice('a=setup:'.length).trim();
    } else if (line.startsWith('a=mid:')) {
      mid = line.slice('a=mid:'.length).trim() || '0';
    } else if (line.startsWith('a=candidate:')) {
      const tokens = line.slice('a=candidate:'.length).trim().split(/\s+/);
      if (tokens.length < 8) continue;
      const proto = tokens[2].toLowerCase();
      const ip = tokens[4];
      const port = Number(tokens[5]);
      const typKeyword = tokens[6].toLowerCase();
      const candType = tokens[7].toLowerCase();
      if (proto !== 'udp' || typKeyword !== 'typ') continue;
      if (!CAND_TYPES.includes(candType)) continue;
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      const key = `${ip}:${port}:${candType}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const v4 = parseIpv4(ip);
      const v6 = v4 ? null : parseIpv6(ip);
      const addrType = v4 ? 0 : v6 ? 1 : 2;
      const bytes = v4 || v6 || enc.encode(ip);
      if (addrType === 2 && bytes.length > 255) continue;
      rawCands.push({ ip, port, candType, addrType, bytes });
    }
  }

  if (!ufrag || !pwd || !fingerprint) {
    throw new Error('SDP is missing required ICE or DTLS fingerprint fields.');
  }
  const setupIndex = SETUP_ROLES.indexOf(setup || 'actpass');
  if (setupIndex === -1) throw new Error(`Unsupported SDP setup role: ${setup}`);

  // Prefer srflx IPv4 -> host IPv4 -> srflx IPv6 -> host IPv6 -> mDNS/hostname, capped at MAX_CANDIDATES.
  const score = (c) => (c.candType === 'srflx' ? 0 : c.candType === 'host' ? 1 : 2) * 4 + c.addrType;
  rawCands.sort((a, b) => score(a) - score(b));
  const candidates = rawCands.slice(0, MAX_CANDIDATES);

  return { ufrag, pwd, fingerprint, setup: SETUP_ROLES[setupIndex], setupIndex, mid, candidates };
}

function packSetupByte(setup) {
  const sizeBit = setup?.size === 5 ? 1 : 0;
  const fieldIdx = FIELDS.indexOf(setup?.field);
  const kitBit = setup?.kit === 'blue' ? 1 : 0;
  const levelIdx = LEVELS.indexOf(setup?.level);
  if (fieldIdx === -1 || levelIdx === -1) {
    throw new Error('Invalid match setup for invite code.');
  }
  return (sizeBit & 1) | ((fieldIdx & 3) << 1) | ((kitBit & 1) << 3) | ((levelIdx & 7) << 4);
}

function unpackSetupByte(byte) {
  const size = (byte & 1) ? 5 : 3;
  const fieldIdx = (byte >>> 1) & 3;
  const kit = ((byte >>> 3) & 1) ? 'blue' : 'gold';
  const levelIdx = (byte >>> 4) & 7;
  if (fieldIdx >= FIELDS.length || levelIdx >= LEVELS.length) return null;
  return { size, field: FIELDS[fieldIdx], kit, level: LEVELS[levelIdx] };
}

function packInternal(kind, { sdp, sessionId, token, setup }) {
  const isInvite = kind === 'invite';
  const sessionBytes = hexToBytes(sessionId, SESSION_BYTES);
  const tokenBytes = hexToBytes(token, TOKEN_BYTES);
  if (!sessionBytes || !tokenBytes) {
    throw new Error('Session ID and token must each be 96-bit (24-char) hex strings.');
  }
  const fields = extractSdpFields(sdp);
  const midBytes = enc.encode(fields.mid);
  const ufragBytes = enc.encode(fields.ufrag);
  const pwdBytes = enc.encode(fields.pwd);
  if (midBytes.length > 32 || ufragBytes.length > 64 || pwdBytes.length > 128) {
    throw new Error('SDP field too long to pack.');
  }

  const chunks = [];
  const push = (...arr) => chunks.push(new Uint8Array(arr));
  const pushU16 = (n) => push((n >>> 8) & 0xff, n & 0xff);

  const flags = ((VERSION & 0x0f) << 4) | ((isInvite ? 0 : 1) << 3) | (fields.setupIndex & 0x07);
  push(flags);
  chunks.push(sessionBytes);
  chunks.push(tokenBytes);
  if (isInvite) push(packSetupByte(setup));

  push(midBytes.length); chunks.push(midBytes);
  push(ufragBytes.length); chunks.push(ufragBytes);
  push(pwdBytes.length); chunks.push(pwdBytes);
  chunks.push(fields.fingerprint);

  push(fields.candidates.length);
  for (const c of fields.candidates) {
    const typeIdx = CAND_TYPES.indexOf(c.candType);
    push(((c.addrType & 3) << 2) | (typeIdx & 3));
    if (c.addrType === 2) {
      push(c.bytes.length);
    }
    chunks.push(c.bytes);
    pushU16(c.port);
  }

  let bodyLen = 0;
  for (const ch of chunks) bodyLen += ch.length;
  const out = new Uint8Array(bodyLen + 4);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.length; }

  const sum = crc32(out.subarray(0, bodyLen));
  out[bodyLen] = (sum >>> 24) & 0xff;
  out[bodyLen + 1] = (sum >>> 16) & 0xff;
  out[bodyLen + 2] = (sum >>> 8) & 0xff;
  out[bodyLen + 3] = sum & 0xff;

  return (isInvite ? PREFIX_INVITE : PREFIX_REPLY) + toBase64Url(out);
}

export function packInvite({ sdp, setup, sessionId = randomHex(SESSION_BYTES), token = randomHex(TOKEN_BYTES) }) {
  const sid = sessionId.toLowerCase();
  const tok = token.toLowerCase();
  return { code: packInternal('invite', { sdp, setup, sessionId: sid, token: tok }), sessionId: sid, token: tok };
}

export function packReply({ sdp, sessionId, token }) {
  return packInternal('reply', { sdp, sessionId: String(sessionId).toLowerCase(), token: String(token).toLowerCase() });
}

export function unpackCode(raw, { expectedKind = null, expectedSessionId = null, expectedToken = null } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: 'Paste the code first.' };
  const compact = raw.replace(/\s+/g, '');
  if (!compact) return { ok: false, error: 'Paste the code first.' };

  const prefixMatch = compact.match(/^P(\d+)([IR])-(.+)$/);
  if (!prefixMatch) {
    return { ok: false, error: 'This does not look like a Papifa invite or reply code.' };
  }
  const prefixVer = Number(prefixMatch[1]);
  const kind = prefixMatch[2] === 'I' ? 'invite' : 'reply';
  if (prefixVer !== VERSION) {
    return { ok: false, error: `Unsupported code version (v${prefixVer}) — both players need the same version of Papifa.` };
  }
  if (expectedKind && kind !== expectedKind) {
    return {
      ok: false,
      error: expectedKind === 'reply'
        ? 'That is an invite code — paste your opponent’s reply code here.'
        : 'That is a reply code — paste your host’s invite code here.',
    };
  }

  const damaged = { ok: false, error: 'This code is damaged or incomplete — ask your opponent to copy it again.' };
  const bytes = fromBase64Url(prefixMatch[3]);
  if (!bytes || bytes.length < 64) return damaged;

  const bodyLen = bytes.length - 4;
  const expectedSum =
    ((bytes[bodyLen] << 24) | (bytes[bodyLen + 1] << 16) | (bytes[bodyLen + 2] << 8) | bytes[bodyLen + 3]) >>> 0;
  if (crc32(bytes.subarray(0, bodyLen)) !== expectedSum) return damaged;

  let off = 0;
  const readU8 = () => (off < bodyLen ? bytes[off++] : null);
  const readU16 = () => (off + 2 <= bodyLen ? ((bytes[off++] << 8) | bytes[off++]) : null);
  const readSlice = (n) => {
    if (n === null || off + n > bodyLen) return null;
    const s = bytes.subarray(off, off + n);
    off += n;
    return s;
  };
  const readStr = () => {
    const n = readU8();
    const s = readSlice(n);
    if (!s) return null;
    try { return dec.decode(s); } catch { return null; }
  };

  const flags = readU8();
  if (flags === null) return damaged;
  const ver = (flags >>> 4) & 0x0f;
  const bodyKind = ((flags >>> 3) & 1) ? 'reply' : 'invite';
  const setupIdx = flags & 0x07;
  if (ver !== VERSION || bodyKind !== kind || setupIdx >= SETUP_ROLES.length) return damaged;

  const sessionBytes = readSlice(SESSION_BYTES);
  const tokenBytes = readSlice(TOKEN_BYTES);
  if (!sessionBytes || !tokenBytes) return damaged;
  const sessionId = bytesToHex(sessionBytes);
  const token = bytesToHex(tokenBytes);

  let setup = null;
  if (kind === 'invite') {
    const setupByte = readU8();
    if (setupByte === null) return damaged;
    setup = unpackSetupByte(setupByte);
    if (!setup) return damaged;
  }

  const mid = readStr();
  const ufrag = readStr();
  const pwd = readStr();
  const fpBytes = readSlice(32);
  if (!mid || !ufrag || !pwd || !fpBytes) return damaged;

  const candCount = readU8();
  if (candCount === null || candCount > MAX_CANDIDATES) return damaged;
  const candidates = [];
  for (let i = 0; i < candCount; i++) {
    const cFlags = readU8();
    if (cFlags === null) return damaged;
    const addrType = (cFlags >>> 2) & 3;
    const typeIdx = cFlags & 3;
    if (addrType > 2 || typeIdx >= CAND_TYPES.length) return damaged;
    let ip;
    if (addrType === 0) {
      const b = readSlice(4);
      if (!b) return damaged;
      ip = formatIpv4(b);
    } else if (addrType === 1) {
      const b = readSlice(16);
      if (!b) return damaged;
      ip = formatIpv6(b);
    } else {
      ip = readStr();
      if (!ip) return damaged;
    }
    const port = readU16();
    if (!port) return damaged;
    candidates.push({ ip, port, candType: CAND_TYPES[typeIdx] });
  }

  if (off !== bodyLen) return damaged;

  if (
    (expectedSessionId !== null && sessionId !== String(expectedSessionId).toLowerCase()) ||
    (expectedToken !== null && token !== String(expectedToken).toLowerCase())
  ) {
    return {
      ok: false,
      error: 'This reply does not match your current invite (it may be expired or from another match).',
    };
  }

  const data = {
    version: ver,
    kind,
    sessionId,
    token,
    setup,
    setupRole: SETUP_ROLES[setupIdx],
    mid,
    ufrag,
    pwd,
    fingerprint: formatFingerprint(fpBytes),
    candidates,
  };
  return { ok: true, ...data, sdp: reconstructSdp(data) };
}

export function reconstructSdp({ setupRole, mid = '0', ufrag, pwd, fingerprint, candidates = [] }) {
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=extmap-allow-mixed',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setupRole}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const prio = (CAND_PRIORITIES[c.candType] ?? 1686052607) - i;
    const extra = c.candType === 'host' ? '' : ' raddr 0.0.0.0 rport 0';
    lines.push(`a=candidate:${i + 1} 1 udp ${prio} ${c.ip} ${c.port} typ ${c.candType}${extra}`);
  }
  lines.push('a=end-of-candidates');
  return lines.join('\r\n') + '\r\n';
}
