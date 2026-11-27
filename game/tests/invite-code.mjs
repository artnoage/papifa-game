import assert from 'node:assert/strict';
import {
  crc32,
  extractSdpFields,
  packInvite,
  packReply,
  reconstructSdp,
  unpackCode,
} from '../src/invite-code.js';
import { decideDirectTimeout } from '../src/online-room.js';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const SAMPLE_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=ice-ufrag:uF12',
  'a=ice-pwd:abcdefghijklmnopqrstuvwx',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=candidate:1 1 udp 2122260223 192.0.2.10 51234 typ host',
  'a=candidate:2 1 udp 1686052607 198.51.100.42 43210 typ srflx raddr 192.0.2.10 rport 51234',
  'a=candidate:3 1 udp 2122194687 2001:db8:1:2::9 55555 typ host',
  'a=candidate:4 1 tcp 1518280447 192.0.2.10 9 typ host tcptype active', // TCP ignored
  'a=candidate:5 1 udp 2122260223 192.0.2.10 51234 typ host', // duplicate ignored
  'a=end-of-candidates',
].join('\r\n') + '\r\n';

const SAMPLE_ANSWER = [
  'v=0',
  'o=- 12345 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=ice-ufrag:aN99',
  'a=ice-pwd:zyxwvutsrqponmlkjihgfedc',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:active',
  'a=mid:0',
  'a=candidate:1 1 udp 2122260223 203.0.113.7 60123 typ host',
  'a=candidate:2 1 udp 2122200000 example-mdns.local 60124 typ host',
].join('\r\n') + '\r\n';

// 1. Invite & reply round-trip, candidate ordering (srflx IPv4 first), and compact length (< 300 chars).
{
  const setup = { size: 5, field: 'meteora', kit: 'blue', level: 'veryHard' };
  const packed = packInvite({ sdp: SAMPLE_OFFER, setup });
  assert.ok(packed.code.startsWith('P1I-'), 'invite starts with P1I-');
  assert.ok(packed.code.length < 300, `invite stays compact (${packed.code.length} chars)`);
  assert.equal(packed.sessionId.length, 24, '96-bit sessionId');
  assert.equal(packed.token.length, 24, '96-bit token');

  // Whitespace / line-wrap resilience (pasting from chat apps).
  const wrapped = `  ${packed.code.slice(0, 40)}\n  ${packed.code.slice(40, 90)}\r\n${packed.code.slice(90)}  `;
  const inv = unpackCode(wrapped, { expectedKind: 'invite' });
  assert.equal(inv.ok, true);
  assert.equal(inv.kind, 'invite');
  assert.equal(inv.sessionId, packed.sessionId);
  assert.equal(inv.token, packed.token);
  assert.deepEqual(inv.setup, setup);
  assert.equal(inv.setupRole, 'actpass');
  assert.equal(inv.ufrag, 'uF12');
  assert.equal(inv.pwd, 'abcdefghijklmnopqrstuvwx');
  assert.equal(inv.fingerprint, FP);
  assert.equal(inv.candidates.length, 3, 'deduplicates and skips TCP');
  assert.deepEqual(inv.candidates[0], { ip: '198.51.100.42', port: 43210, candType: 'srflx' });
  assert.deepEqual(inv.candidates[1], { ip: '192.0.2.10', port: 51234, candType: 'host' });
  assert.equal(inv.candidates[2].ip, '2001:db8:1:2:0:0:0:9');
  assert.ok(inv.sdp.includes('a=ice-ufrag:uF12\r\n'));
  assert.ok(inv.sdp.includes(`a=fingerprint:sha-256 ${FP}\r\n`));
  assert.ok(inv.sdp.includes('a=end-of-candidates\r\n'));

  const replyCode = packReply({ sdp: SAMPLE_ANSWER, sessionId: inv.sessionId, token: inv.token });
  assert.ok(replyCode.startsWith('P1R-'), 'reply starts with P1R-');
  assert.ok(replyCode.length < 300, `reply stays compact (${replyCode.length} chars)`);

  const rep = unpackCode(replyCode, {
    expectedKind: 'reply',
    expectedSessionId: packed.sessionId,
    expectedToken: packed.token,
  });
  assert.equal(rep.ok, true);
  assert.equal(rep.kind, 'reply');
  assert.equal(rep.setup, null);
  assert.equal(rep.setupRole, 'active');
  assert.equal(rep.candidates.length, 2);
  assert.equal(rep.candidates[1].ip, 'example-mdns.local');

  // Reconstructed SDP re-parses identically.
  const reparsed = extractSdpFields(reconstructSdp(rep));
  assert.equal(reparsed.ufrag, 'aN99');
  assert.equal(reparsed.candidates.length, 2);
}

// 2. All match setup combinations pack & unpack faithfully.
for (const size of [3, 5]) {
  for (const field of ['courtyard', 'meteora', 'winter']) {
    for (const kit of ['gold', 'blue']) {
      for (const level of ['veryEasy', 'easy', 'normal', 'hard', 'veryHard']) {
        const setup = { size, field, kit, level };
        const { code } = packInvite({ sdp: SAMPLE_OFFER, setup });
        const res = unpackCode(code, { expectedKind: 'invite' });
        assert.equal(res.ok, true);
        assert.deepEqual(res.setup, setup);
      }
    }
  }
}

// 3. Corruption, truncation, version mismatch, kind mismatch, and session/token mismatch detection.
{
  const packed = packInvite({ sdp: SAMPLE_OFFER, setup: { size: 3, field: 'courtyard', kit: 'gold', level: 'normal' } });
  const reply = packReply({ sdp: SAMPLE_ANSWER, sessionId: packed.sessionId, token: packed.token });

  assert.equal(unpackCode('').ok, false);
  assert.equal(unpackCode('not-a-code').ok, false);

  // Version mismatch
  const badVer = unpackCode('P2I-' + packed.code.slice(4));
  assert.equal(badVer.ok, false);
  assert.match(badVer.error, /version/i);

  // Kind mismatch (invite pasted where reply expected and vice versa)
  const wrongKind1 = unpackCode(packed.code, { expectedKind: 'reply' });
  assert.equal(wrongKind1.ok, false);
  assert.match(wrongKind1.error, /reply code/i);
  const wrongKind2 = unpackCode(reply, { expectedKind: 'invite' });
  assert.equal(wrongKind2.ok, false);
  assert.match(wrongKind2.error, /invite code/i);

  // Single character corruption caught by CRC-32
  const idx = 20;
  const flipped = packed.code[idx] === 'A' ? 'B' : 'A';
  const corrupted = packed.code.slice(0, idx) + flipped + packed.code.slice(idx + 1);
  assert.equal(unpackCode(corrupted).ok, false);
  assert.match(unpackCode(corrupted).error, /damaged/i);

  // Truncation caught
  assert.equal(unpackCode(packed.code.slice(0, -5)).ok, false);

  // Mismatched sessionId or token rejected cleanly
  const mismatchSid = unpackCode(reply, {
    expectedKind: 'reply',
    expectedSessionId: '000000000000000000000000',
    expectedToken: packed.token,
  });
  assert.equal(mismatchSid.ok, false);
  assert.match(mismatchSid.error, /does not match/i);

  const mismatchTok = unpackCode(reply, {
    expectedKind: 'reply',
    expectedSessionId: packed.sessionId,
    expectedToken: 'ffffffffffffffffffffffff',
  });
  assert.equal(mismatchTok.ok, false);
  assert.match(mismatchTok.error, /does not match/i);

  // IEEE CRC-32 standard check vector ("123456789" -> 0xcbf43926).
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
}

// 4. Silent fallback & no-relay timeout trigger decisions.
{
  assert.equal(decideDirectTimeout({ hasRelayFallback: true, elapsedMs: 3000, directAlive: true, fallbackStarted: false }), 'direct');
  assert.equal(decideDirectTimeout({ hasRelayFallback: true, elapsedMs: 3000, directAlive: false, fallbackStarted: false }), 'wait');
  assert.equal(decideDirectTimeout({ hasRelayFallback: true, elapsedMs: 6500, directAlive: false, fallbackStarted: false }), 'fallback');
  assert.equal(decideDirectTimeout({ hasRelayFallback: true, elapsedMs: 1000, directAlive: false, fallbackStarted: false, iceFailed: true }), 'fallback');
  assert.equal(decideDirectTimeout({ hasRelayFallback: true, elapsedMs: 9000, directAlive: false, fallbackStarted: true }), 'wait');

  assert.equal(decideDirectTimeout({ hasRelayFallback: false, elapsedMs: 10000, directAlive: false, fallbackStarted: false }), 'wait');
  assert.equal(decideDirectTimeout({ hasRelayFallback: false, elapsedMs: 15000, directAlive: false, fallbackStarted: false }), 'fail');
  assert.equal(decideDirectTimeout({ hasRelayFallback: false, elapsedMs: 2000, directAlive: false, fallbackStarted: false, iceFailed: true }), 'fail');
}

console.log('invite-code tests passed (round-trip, <300 chars, setups, CRC-32 corruption, mismatch, fallback timing).');
