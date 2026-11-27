// Usage: node tools/playtest/cdp-playtest.mjs http://127.0.0.1:8790/ <outdir> [--touch | --kits]
// Drive the game in headless Chromium over CDP: real key events, HUD reads, screenshots, FPS.
// node playtest.mjs <url> <outdir>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enterMatch, checkFrontEnd } from './cdp-front.mjs';

const [url, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'papifa-playtest-'));
const chrome = spawn('chromium', ['--headless=new', '--mute-audio', '--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--window-size=1280,720', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
const stopped = new Promise((resolve) => chrome.once('close', resolve));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, id = 0;
const pending = new Map();
const consoleLines = [];
async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = targets.find((t) => t.type === 'page');
      if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r)); break; }
    } catch {}
    await sleep(200);
  }
  if (!ws) throw new Error('Could not connect to the playtest Chromium instance');
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') consoleLines.push('EXCEPTION ' + msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
  });
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, (msg) => msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg));
  ws.send(JSON.stringify({ id: i, method, params }));
});
async function evaluate(expression) {
  const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
const KEYS = { KeyD: ['d', 68], KeyA: ['a', 65], KeyW: ['w', 87], KeyS: ['s', 83], ShiftLeft: ['Shift', 16], Space: [' ', 32], KeyF: ['f', 70], KeyQ: ['q', 81], KeyP: ['p', 80] };
const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: KEYS[code][0], windowsVirtualKeyCode: KEYS[code][1] });
const down = (c) => key('keyDown', c), up = (c) => key('keyUp', c);
async function tap(c, ms = 60) { await down(c); await sleep(ms); await up(c); }
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64'));
}
const hud = () => evaluate(`({score: document.getElementById('s0').textContent + ':' + document.getElementById('s1').textContent,
  clock: document.getElementById('clock').textContent, ctrl: document.getElementById('controlled').textContent,
  banner: document.getElementById('banner').textContent})`);

async function runKeyboardPlaytest() {
  await send('Page.navigate', { url });
  await enterMatch(evaluate, send);
  await sleep(9000);                                    // models load
  const log = [];
  const note = async (label) => { const h = await hud(); log.push({ t: label, ...h }); console.log(label, JSON.stringify(h)); };
  await note('loaded');
  // FPS over 3 s
  const fps = await evaluate(`new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 3000) requestAnimationFrame(f); else r(n / ((performance.now() - t0) / 1000)); }; requestAnimationFrame(f); })`);
  console.log('fps', fps);
  await shot('01-kickoff');
  // Dribble right with sprint for 2.5 s
  await down('ShiftLeft'); await down('KeyD'); await sleep(2500); await shot('02-dribble'); await note('after dribble');
  await up('KeyD'); await up('ShiftLeft');
  // Pass forward
  await down('KeyD'); await tap('Space'); await sleep(300); await up('KeyD'); await sleep(700); await note('after pass'); await shot('03-after-pass');
  // Run to goal and shoot (hold F 0.6 s)
  await down('ShiftLeft'); await down('KeyD'); await sleep(2500); await up('ShiftLeft');
  await down('KeyF'); await sleep(600); await shot('04-charging'); await up('KeyF'); await up('KeyD');
  await sleep(1200); await note('after shot'); await shot('05-after-shot');
  // Switch and tackle attempts for 6 s
  for (let i = 0; i < 6; i++) { await tap('KeyQ'); await down('KeyA'); await sleep(500); await tap('Space'); await sleep(400); await up('KeyA'); }
  await note('after defending'); await shot('06-defending');
  // Let the match run 20 s while chasing the ball loosely
  for (let i = 0; i < 20; i++) { await tap(i % 2 ? 'Space' : 'KeyQ'); await sleep(1000); }
  await note('after 20s'); await shot('07-later');
  writeFileSync(`${out}/log.json`, JSON.stringify({ fps, log, console: consoleLines }, null, 2));
  console.log('console:', consoleLines.slice(0, 20));
}

try {
  await connect();
  await send('Runtime.enable'); await send('Page.enable');
  if (process.argv.includes('--flow')) {
    await checkFrontEnd({ url, send, evaluate, shot });
    if (consoleLines.some(line => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--kits')) {
    const { checkBroadcastKits } = await import('./cdp-kits.mjs');
    await checkBroadcastKits({ url, out, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--touch')) {
    const { runTouchPlaytest } = await import('./cdp-touch.mjs');
    await runTouchPlaytest({ url, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--local2p')) {
    const { checkLocal2P } = await import('./cdp-local-2p.mjs');
    await checkLocal2P({ url, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--prayer')) {
    const { runPrayerPlaytest } = await import('./cdp-prayer.mjs');
    await runPrayerPlaytest({ url, out, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--narration')) {
    const { runNarrationPlaytest } = await import('./cdp-narration.mjs');
    await runNarrationPlaytest({ url, out, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--tutorial')) {
    const { runTutorialPlaytest } = await import('./cdp-tutorial.mjs');
    await runTutorialPlaytest({ url, out, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else if (process.argv.includes('--cameo')) {
    const { runCameoPlaytest } = await import('./cdp-cameo.mjs');
    await runCameoPlaytest({ url, out, send, evaluate, shot });
    if (consoleLines.some((line) => line.startsWith('EXCEPTION '))) throw new Error(consoleLines.join('\n'));
  } else {
    await runKeyboardPlaytest();
  }
} finally {
  ws?.close();
  chrome.kill();
  await stopped;
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
