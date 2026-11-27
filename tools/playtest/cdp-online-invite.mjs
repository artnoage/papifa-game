// Two-browser online verification for NO-RELAY builds (public open-source default):
//   Scenario (c): Stages/serves a --no-relay build (no relay server running, CSP has zero `wss:`),
//     Host & Guest exchange P1I-/P1R- invite/reply codes, connect directly via WebRTC, play & sync a prayer,
//     and verify dropping direct mid-match shows "Connection lost — make a new invite".
//   Scenario (d): On the same no-relay build, Host pastes a reply with unreachable ICE candidates;
//     verifies direct connection fails cleanly with:
//     "Couldn't connect directly — some networks (mobile data, strict office/school Wi-Fi) block it. Try another network."
// Usage: node tools/playtest/cdp-online-invite.mjs [stageDir]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packReply, unpackCode } from '../../game/src/invite-code.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const explicitStage = process.argv[2] || process.env.PAPIFA_STAGE_DIR || null;
const tempStage = explicitStage ? null : mkdtempSync(join(tmpdir(), 'papifa-norelay-stage-'));
const stageRoot = resolve(explicitStage || tempStage);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.json': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStaticServer(root) {
  const server = http.createServer((req, res) => {
    const reqPath = new URL(req.url, 'http://127.0.0.1').pathname;
    const rel = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
    const full = resolve(root, rel);
    if (!full.startsWith(root)) { res.writeHead(403); res.end(); return; }
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error('not file');
      res.writeHead(200, { 'Content-Type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(readFileSync(full));
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => res({ server, port: server.address().port }));
  });
}

async function waitUntil(fn, timeoutMs = 20000, stepMs = 80, desc = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(stepMs);
  }
  throw new Error(`Timed out waiting for ${desc}`);
}

async function connectCdpTarget(wsUrl, label) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, rej) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push(`${label}: ${msg.params.exceptionDetails.text} ${msg.params.exceptionDetails.exception?.description || ''}`);
    }
  });
  ws.addEventListener('close', () => {
    for (const cb of pending.values()) cb({ error: { message: 'CDP socket closed' } });
    pending.clear();
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => msg.error ? reject(new Error(`${label} ${method}: ${msg.error.message}`)) : resolve(msg));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`${label} eval: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    return result.result.value;
  };
  const key = (type, code, k, vk) => send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, mobile: false, deviceScaleFactor: 1, screenWidth: 1280, screenHeight: 800,
  });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__cspViolations = [];
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__cspViolations.push(e.violatedDirective + ' ' + e.blockedURI);
      });
    `,
  });
  return { ws, send, evaluate, key, exceptions, label };
}

async function launchBrowser(label) {
  const profile = mkdtempSync(join(tmpdir(), `papifa-invite-${label}-`));
  const chrome = spawn('chromium', [
    '--headless=new', '--mute-audio', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,800',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection', 'about:blank',
  ], { stdio: 'ignore' });
  const stopped = new Promise((r) => chrome.once('close', r));
  const cdpPort = await waitUntil(() => {
    try { return readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { return null; }
  }, 10000, 120, `${label} DevToolsActivePort`);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  assert.ok(page, `Found Chromium page for ${label}`);
  const client = await connectCdpTarget(page.webSocketDebuggerUrl, label);
  return {
    ...client,
    async close() {
      await Promise.race([client.send('Browser.close').catch(() => {}), sleep(1500)]);
      client.ws?.close();
      await Promise.race([stopped, sleep(3000)]);
      if (chrome.exitCode === null) chrome.kill('SIGTERM');
      await stopped;
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    },
  };
}

async function navigateToInviteHost(browser, url) {
  await browser.send('Page.navigate', { url });
  await waitUntil(() => browser.evaluate('document.querySelector("#front")?.dataset.ready === "true" && document.querySelector("#title-page")?.hidden === false'), 10000, 80, 'host title');
  await browser.evaluate('document.querySelector("#new-game").click()');
  await browser.evaluate('document.querySelector(\'#play-mode input[value="host"]\').click()');
  await browser.key('keyDown', 'Space', ' ', 32); await browser.key('keyUp', 'Space', ' ', 32);
  await waitUntil(() => browser.evaluate('document.querySelector("#claim-continue")?.disabled === false'), 5000, 60, 'host claim');
  await browser.evaluate('document.querySelector("#claim-continue").click()');
  await browser.evaluate('document.querySelector("#kick-off").click()');
  await waitUntil(() => browser.evaluate('document.querySelector("#room-page")?.hidden === false'), 5000, 60, 'host invite page');
  return waitUntil(
    () => browser.evaluate('(() => { const v = document.querySelector("#invite-code-out")?.value?.trim(); return v && v.startsWith("P1I-") ? v : null; })()'),
    10000, 80, 'host invite code',
  );
}

let webServer;
let host;
let guest;
try {
  if (tempStage) {
    const build = spawnSync(process.execPath, [
      join(REPO_ROOT, 'scripts', 'build-web.mjs'), '--worktree', '--no-relay', '--stage', tempStage,
    ], { encoding: 'utf8' });
    assert.equal(build.status, 0, `build-web --no-relay failed: ${build.stderr}`);
  }

  // Verify the staged no-relay build contains zero wss: and no papifa-relay meta tag.
  const stagedIndex = readFileSync(join(stageRoot, 'index.html'), 'utf8');
  assert.ok(stagedIndex.includes("connect-src 'self' data: blob:;"), 'no-relay CSP has no wss:');
  assert.ok(!stagedIndex.includes('wss:'), 'staged no-relay index.html has zero wss: references');
  assert.ok(!stagedIndex.includes('papifa-relay'), 'staged no-relay index.html has no relay meta tag');

  const srv = await startStaticServer(stageRoot);
  webServer = srv.server;
  const gameUrl = `http://127.0.0.1:${srv.port}/?size=3`;

  [host, guest] = await Promise.all([launchBrowser('host'), launchBrowser('guest')]);

  // ---------- Scenario (c): Direct WebRTC P2P via invite/reply codes with ZERO relay ----------
  const inviteCode = await navigateToInviteHost(host, gameUrl);
  assert.ok(inviteCode.length < 300, `invite code length < 300 (${inviteCode.length})`);

  await guest.send('Page.navigate', { url: gameUrl });
  await waitUntil(() => guest.evaluate('document.querySelector("#front")?.dataset.ready === "true" && document.querySelector("#title-page")?.hidden === false'), 10000, 80, 'guest title');
  await guest.evaluate('document.querySelector("#new-game").click()');
  await guest.evaluate('document.querySelector(\'#play-mode input[value="join"]\').click()');
  await guest.key('keyDown', 'Space', ' ', 32); await guest.key('keyUp', 'Space', ' ', 32);
  await waitUntil(() => guest.evaluate('document.querySelector("#claim-continue")?.disabled === false'), 5000, 60, 'guest claim');
  await guest.evaluate('document.querySelector("#claim-continue").click()');
  await waitUntil(() => guest.evaluate('document.querySelector("#room-page")?.hidden === false'), 5000, 60, 'guest invite page');
  await guest.evaluate(`document.querySelector("#invite-code-in").value = ${JSON.stringify(inviteCode)}; document.querySelector("#create-reply").click();`);
  const replyCode = await waitUntil(
    () => guest.evaluate('(() => { const v = document.querySelector("#reply-code-out")?.value?.trim(); return v && v.startsWith("P1R-") ? v : null; })()'),
    10000, 80, 'guest reply code',
  );
  assert.ok(replyCode.length < 300, `reply code length < 300 (${replyCode.length})`);

  await host.evaluate(`document.querySelector("#reply-code-in").value = ${JSON.stringify(replyCode)}; document.querySelector("#connect-reply").click();`);
  await waitUntil(() => host.evaluate('document.querySelector("#match-shell")?.hidden === false'), 15000, 100, 'host match shell');
  await waitUntil(() => guest.evaluate('document.querySelector("#match-shell")?.hidden === false'), 15000, 100, 'guest match shell');
  await sleep(600);
  if (await host.evaluate('document.querySelector("#venue-intro")?.hidden === false')) {
    await host.evaluate('document.querySelector("#skip-intro").click()');
  }
  await waitUntil(() => host.evaluate('!!document.querySelector("#controlled")?.textContent'), 10000, 100, 'host live');
  await waitUntil(() => guest.evaluate('!!document.querySelector("#controlled")?.textContent && document.querySelector("#banner")?.textContent !== "Waiting for host"'), 10000, 100, 'guest live');

  const [hNet, gNet] = await Promise.all([
    host.evaluate('({ t: globalThis.__papifaNet.transport(), fb: globalThis.__papifaNet.hasFallback(), badgeHidden: document.querySelector("#net-badge").hidden, stats: globalThis.__papifaNet.stats() })'),
    guest.evaluate('({ t: globalThis.__papifaNet.transport(), fb: globalThis.__papifaNet.hasFallback(), badgeHidden: document.querySelector("#net-badge").hidden, stats: globalThis.__papifaNet.stats() })'),
  ]);
  assert.equal(hNet.t, 'direct'); assert.equal(gNet.t, 'direct');
  assert.equal(hNet.fb, false); assert.equal(gNet.fb, false);
  assert.equal(hNet.badgeHidden, true); assert.equal(gNet.badgeHidden, true);

  // Sync a prayer over the serverless direct link to confirm bidirectional gameplay traffic.
  await guest.key('keyDown', 'KeyR', 'r', 82);
  await waitUntil(() => host.evaluate('document.querySelector("#prayer-1").dataset.state === "charging"'), 10000, 60, 'host sees guest prayer charge directly');
  await guest.key('keyUp', 'KeyR', 'r', 82);

  // Drop direct mid-match -> no-relay build ends cleanly with "Connection lost — make a new invite".
  await host.evaluate('globalThis.__papifaNet.dropDirect()');
  const dropMsg = await waitUntil(
    () => host.evaluate('!document.querySelector("#network-status").hidden ? document.querySelector("#network-status p").textContent : null'),
    5000, 80, 'no-relay mid-match connection lost message',
  );
  assert.equal(dropMsg, 'Connection lost — make a new invite');
  console.log(`Scenario (c) PASSED: direct P2P via invite/reply codes (${inviteCode.length}/${replyCode.length} chars) with no relay + mid-match loss notice.`);

  // ---------- Scenario (d): No-relay build with direct link failing -> plain failure message ----------
  const invite2 = await navigateToInviteHost(host, gameUrl);
  const unpacked = unpackCode(invite2, { expectedKind: 'invite' });
  assert.equal(unpacked.ok, true);
  // Synthesize a valid reply code with an unreachable TEST-NET-1 candidate so real Chromium ICE fails/times out!
  const fakeAnswerSdp = [
    'v=0',
    'o=- 99999 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:fail',
    'a=ice-pwd:failfailfailfailfailfail',
    `a=fingerprint:sha-256 ${unpacked.fingerprint}`,
    'a=setup:active',
    `a=mid:${unpacked.mid}`,
    'a=candidate:1 1 udp 2122260223 192.0.2.1 54321 typ host',
    'a=end-of-candidates',
  ].join('\r\n') + '\r\n';
  const deadReply = packReply({ sdp: fakeAnswerSdp, sessionId: unpacked.sessionId, token: unpacked.token });
  await host.evaluate(`document.querySelector("#reply-code-in").value = ${JSON.stringify(deadReply)}; document.querySelector("#connect-reply").click();`);

  const expectedFail = "Couldn't connect directly — some networks (mobile data, strict office/school Wi-Fi) block it. Try another network.";
  const failStatus = await waitUntil(
    () => host.evaluate(`document.querySelector("#room-status").textContent === ${JSON.stringify(expectedFail)} ? document.querySelector("#room-status").textContent : null`),
    22000, 150, 'no-relay direct failure message',
  );
  assert.equal(failStatus, expectedFail);
  console.log('Scenario (d) PASSED: no-relay build surfaced exact plain failure message when direct link could not open.');

  const [hostCsp, guestCsp] = await Promise.all([
    host.evaluate('window.__cspViolations'),
    guest.evaluate('window.__cspViolations'),
  ]);
  assert.deepEqual(hostCsp, [], `Host CSP violations: ${hostCsp.join('; ')}`);
  assert.deepEqual(guestCsp, [], `Guest CSP violations: ${guestCsp.join('; ')}`);
  assert.deepEqual(host.exceptions, [], `Host exceptions: ${host.exceptions.join('; ')}`);
  assert.deepEqual(guest.exceptions, [], `Guest exceptions: ${guest.exceptions.join('; ')}`);
  console.log('Serverless invite-code online verification PASSED (Scenarios c & d, 0 CSP violations, 0 exceptions).');
} finally {
  await Promise.all([host?.close(), guest?.close()]);
  webServer?.closeAllConnections?.();
  webServer?.close();
  if (tempStage) rmSync(tempStage, { recursive: true, force: true });
}
