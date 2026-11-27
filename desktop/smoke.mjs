#!/usr/bin/env node
// Headless CDP smoke test against the packaged Linux desktop app.
// Verifies papifa://app origin, security flags, title menu, kickoff vs AI,
// and Gamepad API + Gamepad tutorial step 1 via a virtual controller.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(desktopDir, '..');

function parseArgs(argv) {
  const opts = {
    app: '',
    distDir: process.env.PAPIFA_DESKTOP_OUT || join(homedir(), 'scratch', 'papifa', 'desktop-dist'),
    out: join(repoDir, 'assets-src', 'screens', 'desktop-smoke'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--app') opts.app = argv[++i];
    else if (a === '--dist') opts.distDir = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

function resolveLaunchTarget(opts) {
  if (opts.app) {
    const p = resolve(opts.app);
    if (!existsSync(p)) throw new Error(`App target not found: ${p}`);
    if (p.endsWith('.tar.gz')) {
      const tmp = mkdtempSync(join(tmpdir(), 'papifa-desktop-tar-'));
      const res = spawnSync('tar', ['-xzf', p, '-C', tmp], { stdio: 'inherit' });
      if (res.status !== 0) throw new Error(`Failed to extract ${p}`);
      const entries = readdirSync(tmp);
      const bin = entries.map((e) => join(tmp, e, 'papifa')).find((cand) => existsSync(cand));
      if (!bin) throw new Error(`Could not locate papifa binary inside ${p}`);
      return { bin, cleanupDir: tmp, label: p };
    }
    return { bin: p, cleanupDir: null, label: p };
  }
  if (!existsSync(opts.distDir)) {
    throw new Error(`Dist directory not found: ${opts.distDir}. Run \`npm run build:linux\` first.`);
  }
  const files = readdirSync(opts.distDir).sort();
  const appImage = files.findLast((f) => f.endsWith('.AppImage'));
  if (appImage) return { bin: join(opts.distDir, appImage), cleanupDir: null, label: join(opts.distDir, appImage) };
  const tarGz = files.findLast((f) => f.endsWith('.tar.gz'));
  if (tarGz) return resolveLaunchTarget({ ...opts, app: join(opts.distDir, tarGz) });
  throw new Error(`No .AppImage or .tar.gz found in ${opts.distDir}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listPapifaCoreDumps() {
  if (process.platform !== 'linux') return null;
  const res = spawnSync('coredumpctl', ['list', 'papifa', '--no-legend', '--no-pager'], { encoding: 'utf8' });
  if (res.error) return null; // coredumpctl not installed
  if (res.status !== 0) return []; // status 1 => "No coredumps found."
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const target = resolveLaunchTarget(opts);
  mkdirSync(opts.out, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'papifa-desktop-smoke-'));
  const coresBefore = listPapifaCoreDumps();

  console.log(`Launching desktop build headless: ${target.label}`);
  const launchArgs = [
    '--ozone-platform=headless',
    '--headless',
    '--mute-audio',
    '--no-sandbox',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
  ];
  const proc = spawn(target.bin, launchArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PAPIFA_HEADLESS: '1',
      ...(target.bin.endsWith('.AppImage') ? { APPIMAGE_EXTRACT_AND_RUN: '1' } : {}),
    },
  });
  let stderrTail = '';
  proc.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });
  let exitCode = null;
  let exitSignal = null;
  const stopped = new Promise((resolveStop) => {
    proc.once('close', (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      resolveStop({ code, signal });
    });
  });

  let ws;
  let id = 0;
  const pending = new Map();
  const consoleLines = [];
  const exceptions = [];
  let send = null;
  let closedPolitely = false;
  let summary = null;
  let testPassed = false;

  try {
    let pageTarget = null;
    for (let i = 0; i < 80; i++) {
      if (proc.exitCode !== null) {
        throw new Error(`Desktop app exited early with code ${proc.exitCode}\n${stderrTail}`);
      }
      try {
        const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        pageTarget = targets.find((t) => t.type === 'page' && t.url.startsWith('papifa://app'));
        if (pageTarget) {
          ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
          await new Promise((r, rej) => {
            ws.addEventListener('open', r, { once: true });
            ws.addEventListener('error', rej, { once: true });
          });
          break;
        }
      } catch {}
      await sleep(250);
    }
    if (!ws || !pageTarget) {
      throw new Error(`Could not attach CDP to papifa://app page.\n${stderrTail}`);
    }

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        consoleLines.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const detail = msg.params.exceptionDetails;
        exceptions.push(detail.exception?.description || detail.text);
      }
    });

    send = (method, params = {}) => new Promise((resolveReq, rejectReq) => {
      const reqId = ++id;
      pending.set(reqId, (msg) => (msg.error ? rejectReq(new Error(`${method}: ${msg.error.message}`)) : resolveReq(msg)));
      ws.send(JSON.stringify({ id: reqId, method, params }));
    });

    async function evaluate(expression) {
      const { result } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      }
      return result.result.value;
    }

    async function waitFor(expr, label, tries = 200, intervalMs = 100) {
      for (let i = 0; i < tries; i++) {
        if (await evaluate(expr)) return;
        await sleep(intervalMs);
      }
      throw new Error(`Timed out waiting for ${label}`);
    }

    async function clickSelector(selector) {
      const pt = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) throw new Error('Missing selector: ' + ${JSON.stringify(selector)});
        el.scrollIntoView({ block: 'nearest' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt, button: 'left', clickCount: 1 });
    }

    async function shot(name) {
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      const filePath = join(opts.out, `${name}.png`);
      writeFileSync(filePath, Buffer.from(result.data, 'base64'));
      return filePath;
    }

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });

    // Attach CSP violation monitor for the current page and all future navigations.
    const cspScript = "window.__cspErrors = []; addEventListener('securitypolicyviolation', (e) => window.__cspErrors.push(e.effectiveDirective + ':' + e.blockedURI));";
    await send('Page.addScriptToEvaluateOnNewDocument', { source: cspScript });
    await evaluate(cspScript);

    // 1. Verify custom scheme origin, security flags, native Gamepad API, and that the title menu opens directly.
    await waitFor("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'", 'title page');
    await waitFor("document.querySelector('.portrait-model img')?.naturalWidth > 0", 'title portrait');

    const envInfo = await evaluate(`({
      origin: location.origin,
      href: location.href,
      isSecureContext: window.isSecureContext,
      hasCryptoSubtle: Boolean(globalThis.crypto?.subtle),
      hasRequire: typeof window.require !== 'undefined',
      hasProcess: typeof window.process !== 'undefined',
      hasGamepadApi: typeof navigator.getGamepads === 'function',
      gamepadListLen: navigator.getGamepads ? Array.from(navigator.getGamepads()).length : -1,
      hasCspMeta: Boolean(document.querySelector('meta[http-equiv="Content-Security-Policy"]')),
      baseHref: document.querySelector('base')?.getAttribute('href') || '',
      popupResult: window.open('https://example.com', '_blank') === null,
    })`);

    assert.equal(envInfo.origin, 'papifa://app', 'page origin must be papifa://app');
    assert.equal(envInfo.isSecureContext, true, 'papifa://app must be a secure context');
    assert.equal(envInfo.hasCryptoSubtle, true, 'crypto.subtle must be available');
    assert.equal(envInfo.hasRequire, false, 'nodeIntegration must be disabled');
    assert.equal(envInfo.hasProcess, false, 'sandbox/contextIsolation must hide process');
    assert.equal(envInfo.hasGamepadApi, true, 'navigator.getGamepads must be exposed');
    assert.equal(envInfo.hasCspMeta, true, 'staged CSP meta tag must be present');
    assert.match(envInfo.baseHref, /^r\/[0-9a-f]+\/$/, 'staged <base href> must point to release folder');
    assert.equal(envInfo.popupResult, true, 'window.open to external URL must be blocked');
    assert.equal(await evaluate('location.origin'), 'papifa://app', 'external window.open must not navigate app');

    await shot('01-title');

    // 2. Menu screen + 3D portrait WebGL preview.
    await waitFor("Boolean(document.querySelector('.portrait-model.has-model canvas'))", '3D title portrait canvas', 200, 150);
    assert.equal(await evaluate("!document.querySelector('#menu-tutorial').hidden"), true, 'Gamepad tutorial menu item must be visible');
    await shot('02-menu');

    // 3. Kickoff vs AI.
    await clickSelector('#new-game');
    await waitFor("document.querySelector('#front')?.dataset.page === 'players'", 'players page');
    await clickSelector('#claim-slot-0');
    await waitFor("document.querySelector('#claim-continue')?.disabled === false", 'claim continue enabled');
    await clickSelector('#claim-continue');
    await waitFor("document.querySelector('#front')?.dataset.page === 'teams'", 'teams page');
    await clickSelector('#kick-off');
    await waitFor("document.querySelector('#match-shell')?.hidden === false", 'match shell visible', 200, 150);
    if (await evaluate("!document.querySelector('#venue-intro')?.hidden")) {
      await clickSelector('#skip-intro');
    }
    await waitFor("document.querySelector('#venue-intro')?.hidden === true", 'venue intro hidden');
    await waitFor("Boolean(document.querySelector('#match-shell canvas') && document.querySelector('#controlled')?.textContent?.trim())", 'match canvas and controlled priest', 200, 150);
    // Let models finish loading and match clock tick at least 1 s.
    await waitFor("document.querySelector('#clock')?.textContent !== '3:00'", 'match clock ticking', 250, 150);
    await sleep(1500);
    await shot('03-kickoff-ai');
    assert.deepEqual(await evaluate('window.__cspErrors'), [], 'no CSP errors during kickoff vs AI');

    // 4. Gamepad tutorial step 1 through a virtual pad.
    const { result: { identifier: padShimId } } = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => {
        let now = performance.now();
        Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
        const queue = [];
        window.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
        window.cancelAnimationFrame = () => {};
        window.advanceTut = (ms = 17, count = 1) => {
          for (let i = 0; i < count; i++) {
            now += ms;
            const run = queue.splice(0);
            for (const fn of run) fn(now);
          }
          return true;
        };
        window.__virtualPads = [];
        Object.defineProperty(navigator, 'getGamepads', { value: () => window.__virtualPads, configurable: true });
        window.__plugPad = () => {
          window.__virtualPads[0] = {
            index: 0,
            id: 'Virtual Pad',
            connected: true,
            axes: [0, 0, 0, 0],
            buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
          };
        };
        window.__btn = (i, on) => {
          const pad = window.__virtualPads[0];
          if (!pad) return;
          pad.buttons[i].pressed = on;
          pad.buttons[i].value = on ? 1 : 0;
        };
        window.__axes = (a) => {
          if (window.__virtualPads[0]) window.__virtualPads[0].axes = a;
        };
      })()`,
    });

    const prevOrigin = await evaluate('performance.timeOrigin');
    await send('Page.navigate', { url: 'papifa://app/' });
    await waitFor(`performance.timeOrigin !== ${prevOrigin}`, 'navigation back to papifa://app/');

    const advance = (ms = 34, count = 2) => evaluate(`advanceTut(${ms}, ${count})`);
    async function untilTut(expr, label, limit = 400) {
      for (let i = 0; i < limit; i++) {
        await advance(34, 2);
        if (await evaluate(expr)) return;
        if (i % 10 === 9) await sleep(30);
      }
      throw new Error(`Timed out waiting for ${label}`);
    }

    await untilTut("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'", 'title page for tutorial');
    await evaluate("document.querySelector('#menu-tutorial').click()");
    await untilTut("document.querySelector('#front')?.dataset.page === 'tutorial'", 'tutorial start page');

    await evaluate('__plugPad()');
    await advance(17, 4);
    assert.match(await evaluate("document.querySelector('#tutorial-status')?.textContent || ''"), /Controller found/i);

    await evaluate('__btn(0, true)');
    await advance(17, 3);
    await evaluate('__btn(0, false)');
    await advance(17, 3);

    await untilTut("Boolean(document.querySelector('#tutorial-panel'))", 'tutorial panel');
    await untilTut("document.querySelector('#tutorial-panel')?.dataset.phase === 'watch'", 'step 1 demo watch');
    assert.equal(await evaluate("document.querySelector('#tutorial-panel .tut-count')?.textContent"), '1 / 14');
    assert.equal(await evaluate("document.querySelector('#tutorial-panel .tut-title')?.textContent"), 'Move');

    await untilTut("document.querySelector('#tutorial-panel')?.dataset.phase === 'try'", 'step 1 your turn');
    await shot('04-tutorial-step1-try');

    // Complete step 1 ("Move") with virtual left stick.
    await evaluate('__axes([1, 0, 0, 0])');
    await untilTut(
      "['done', 'complete'].includes(document.querySelector('#tutorial-panel')?.dataset.phase) || document.querySelector('#tutorial-panel .tut-count')?.textContent === '2 / 14'",
      'step 1 completion by virtual pad',
      250,
    );
    await evaluate('__axes([0, 0, 0, 0])');
    await shot('05-tutorial-step1-done');

    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: padShimId });

    const cspErrors = await evaluate('window.__cspErrors');
    assert.deepEqual(cspErrors, [], `Unexpected CSP errors: ${JSON.stringify(cspErrors)}`);
    assert.deepEqual(exceptions, [], `Unexpected runtime exceptions: ${JSON.stringify(exceptions)}`);

    // Exercise the normal window-close exit path (window.close() -> window-all-closed -> app.quit()).
    closedPolitely = true;
    await Promise.race([
      send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {}),
      sleep(1500),
    ]);
    await Promise.race([stopped, sleep(3500)]);
    if (proc.exitCode === null && proc.signalCode === null && ws?.readyState === WebSocket.OPEN) {
      await Promise.race([send('Browser.close').catch(() => {}), sleep(1000)]);
    }
    ws?.close();
    await Promise.race([stopped, sleep(5000)]);

    summary = {
      passed: true,
      app: target.label,
      origin: envInfo.origin,
      baseHref: envInfo.baseHref,
      security: {
        isSecureContext: envInfo.isSecureContext,
        hasCryptoSubtle: envInfo.hasCryptoSubtle,
        nodeIntegrationDisabled: !envInfo.hasRequire && !envInfo.hasProcess,
        externalPopupBlocked: envInfo.popupResult,
      },
      gamepadApiExposed: envInfo.hasGamepadApi,
      screenshotsDir: opts.out,
      cspErrors: cspErrors.length,
      exceptions: exceptions.length,
    };
    testPassed = true;
  } finally {
    if (!closedPolitely && ws?.readyState === WebSocket.OPEN && send) {
      await Promise.race([send('Runtime.evaluate', { expression: 'window.close()' }).catch(() => {}), sleep(1000)]);
      await Promise.race([send('Browser.close').catch(() => {}), sleep(1000)]);
    }
    ws?.close();
    if (proc.exitCode === null && proc.signalCode === null) {
      await Promise.race([stopped, sleep(5000)]);
    }
    // Escalate only if still alive — signal the main PID only, never the process group.
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGTERM'); } catch {}
      await Promise.race([stopped, sleep(3000)]);
    }
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
      await Promise.race([stopped, sleep(1500)]);
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    if (target.cleanupDir) {
      rmSync(target.cleanupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  }

  if (testPassed) {
    assert.equal(exitSignal, null, `Desktop app exited via signal ${exitSignal}\n${stderrTail}`);
    assert.equal(exitCode, 0, `Desktop app must exit with code 0 (got ${exitCode})\n${stderrTail}`);
    if (coresBefore !== null) {
      await sleep(300);
      const coresAfter = listPapifaCoreDumps();
      assert.equal(
        coresAfter.length,
        coresBefore.length,
        `New papifa core dump detected after smoke run!\nBefore: ${coresBefore.length}\nAfter: ${coresAfter.length}\n${coresAfter.slice(coresBefore.length).join('\n')}`,
      );
    }
    console.log(JSON.stringify({
      ...summary,
      cleanExit: { code: exitCode, signal: exitSignal, newCoreDumps: coresBefore !== null ? 0 : 'unchecked' },
    }, null, 2));
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
