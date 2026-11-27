// Browser E2E verification & 4x CPU throttle benchmark for Task G real-time 3D cameos:
// 1. Lazy loading: zero assets/cameos/ fetches on menu; GLBs load lazily after kickoff.
// 2. With force-prob hook = 1.0:
//    - Goal -> #1 (petsokopses) on scoring team's side, renders 3D frames, drives mouth morph, plays audio, disappears afterwards.
//    - Strong catch -> #2 (ante_geia) on keeper's side, renders 3D frames, plays audio, disappears afterwards.
//    - Parry & soft catch -> nothing.
//    - Language rule: narration 'en' -> *_en.mp3; 'el' or 'off' -> *_el.mp3.
//    - Mute (KeyM) -> cameo still displays visibly, zero new audio plays.
// 3. Zero HUD overlap & viewport clearance across Desktop (1280x800), Portrait (390x844), and Landscape (844x390).
// 4. 4x phone CPU throttle frame-time cost measurement (active cameo vs idle baseline).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { enterMatch } from './cdp-front.mjs';
import { observeGameCall } from './cdp-moves.mjs';

const CAMEO_CLEARANCE_JS = `(() => {
  const rectOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { sel, left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) };
  };
  const cameo = rectOf('#cameo-slot-0') || rectOf('#cameo-slot-1');
  const others = [
    rectOf('#score'),
    rectOf('#clock'),
    rectOf('#controlled-bar'),
    rectOf('#pause-button'),
    rectOf('#move-help summary'),
    rectOf('#prayer-0'),
    rectOf('#prayer-1'),
    rectOf('#banner'),
    rectOf('#touch-stick'),
    rectOf('[data-control="pray"]'),
    rectOf('[data-control="switch"]'),
    rectOf('[data-control="pass"]'),
    rectOf('[data-control="shoot"]'),
  ].filter(Boolean);
  const overlaps = [];
  if (cameo) {
    for (const o of others) {
      const ox = Math.min(cameo.right, o.right) - Math.max(cameo.left, o.left);
      const oy = Math.min(cameo.bottom, o.bottom) - Math.max(cameo.top, o.top);
      if (ox > 1 && oy > 1) overlaps.push({ cameo, other: o, ox, oy });
    }
  }
  const clipped = cameo && (cameo.left < -1 || cameo.top < -1 || cameo.right > window.innerWidth + 1 || cameo.bottom > window.innerHeight + 1);
  return { vw: window.innerWidth, vh: window.innerHeight, cameo, overlaps, clipped };
})()`;

export async function runCameoPlaytest({ url, out, send, evaluate, shot }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, timeoutMs = 15000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await evaluate(expr);
      if (v) return v;
      await sleep(80);
    }
    throw new Error('Timed out waiting for ' + expr);
  };
  const setViewport = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', {
    width, height, mobile, deviceScaleFactor: 1, screenWidth: width, screenHeight: height,
  });

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__cspErrors = [];
      addEventListener('securitypolicyviolation', (e) => window.__cspErrors.push(e.effectiveDirective + ':' + e.blockedURI));
    })()`,
  });

  // ---------- 1. Desktop (1280x800): verify zero cameo fetch on menu ----------
  await setViewport(1280, 800, false);
  await send('Page.navigate', { url });
  await waitFor("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  const menuCameoFetches = await evaluate(
    "performance.getEntriesByType('resource').filter(e => e.name.includes('assets/cameos/')).length"
  );
  assert.equal(menuCameoFetches, 0, 'Cameo GLBs/audio must NOT be fetched on the menu before kickoff');

  // Set Greek narration and enter match
  await evaluate("localStorage.setItem('papifa.narration.v2', 'el'); localStorage.setItem('papifa.sound.v2', 'on');");
  await enterMatch(evaluate, send);
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.cameoMatch = m, false)');
  await waitFor('!!window.cameoMatch && !!window.__papifaCameo');

  // Wait for lazy-loaded cameo GLBs to finish loading after kickoff
  await waitFor('window.__papifaCameo.getState().loadedModels.length >= 3', 20000);
  const loadedAfterKickoff = await evaluate('window.__papifaCameo.getState().loadedModels');
  assert.ok(loadedAfterKickoff.includes('petsokopses') && loadedAfterKickoff.includes('ante_geia') && loadedAfterKickoff.includes('karvouno'),
    `All cameo GLBs loaded lazily: ${JSON.stringify(loadedAfterKickoff)}`);

  // Force deterministic 100% cameo probability via test hook
  await evaluate('window.__papifaCameoForceProb = 1.0; window.__papifaCameo.stop();');

  // ---------- 2. Goal by Home (team 0) -> #1 on Home left corner + Greek audio + disappears ----------
  await evaluate(`(() => {
    const m = cameoMatch;
    const striker = m.players.find(p => p.team === 0 && !p.isGK);
    Object.assign(m.ball, {
      owner: null, receiver: null, shot: { team: 0, jesus: false, shooter: striker }, lastTouch: striker, inNet: false,
      pos: { x: m.pitch.length / 2 + 0.5, y: 0.6, z: 0 }, vel: { x: 14, y: 0, z: 0 },
    });
  })()`);

  const goalState = await waitFor("(() => { const s = window.__papifaCameo.getState(); return s.active && s.renderFrames > 4 ? s : null; })()", 6000);
  assert.equal(goalState.active.id, 'petsokopses', 'Goal must show #1 petsokopses');
  assert.equal(goalState.active.team, 0, 'Goal by Home must show on team 0 (left) side');
  assert.equal(goalState.active.lang, 'el', 'Greek narration setting -> Greek cameo line');
  assert.ok(goalState.lastAudioUrl.endsWith('petsokopses_el.mp3'), `Audio URL: ${goalState.lastAudioUrl}`);
  await sleep(600);
  const midGoal = await evaluate('window.__papifaCameo.getState()');
  assert.ok(midGoal.audioPlayedCount >= 1, `Audio must play on goal cameo (count=${midGoal.audioPlayedCount})`);
  assert.ok(midGoal.mouth > 0.01, `Runtime mouth morph must open during speech (mouth=${midGoal.mouth})`);
  const desktopGoalClr = await evaluate(CAMEO_CLEARANCE_JS);
  assert.ok(desktopGoalClr.cameo && desktopGoalClr.cameo.sel === '#cameo-slot-0', 'Team 0 slot visible on left');
  const frameStyle0 = await evaluate(`(() => {
    const cs = getComputedStyle(document.querySelector('#cameo-slot-0'));
    return { borderW: parseFloat(cs.borderTopWidth), radius: parseFloat(cs.borderTopLeftRadius), borderColor: cs.borderTopColor };
  })()`);
  assert.ok(frameStyle0.borderW >= 2 && frameStyle0.radius >= 10, `TV PiP bezel frame missing: ${JSON.stringify(frameStyle0)}`);
  assert.deepEqual(desktopGoalClr.overlaps, [], `Desktop goal cameo overlaps: ${JSON.stringify(desktopGoalClr.overlaps)}`);
  assert.equal(desktopGoalClr.clipped, false, `Desktop goal cameo clipped: ${JSON.stringify(desktopGoalClr)}`);
  await shot('cameo-desktop-goal');

  // Wait for cameo to finish and disappear cleanly (~3.1 s)
  await waitFor('window.__papifaCameo.getState().active === null', 7000);
  const slotHiddenAfter = await evaluate("document.querySelector('#cameo-slot-0').hidden");
  assert.equal(slotHiddenAfter, true, 'Goal cameo slot must hide after finishing');

  // Skip replay if active before next check
  if (await evaluate('!document.querySelector("#replay").hidden')) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await sleep(60);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await waitFor('document.querySelector("#replay").hidden', 5000);
  }

  // ---------- 3. Parry must show NOTHING; soft catch must show NOTHING ----------
  await evaluate(`(() => {
    window.__papifaCameo.handleEvents([{ type: 'parry', team: 1, keeper: 'nikolai' }], cameoMatch);
  })()`);
  assert.equal(await evaluate('window.__papifaCameo.getState().active'), null, 'Parry must never trigger cameo');
  await evaluate(`(() => {
    window.__papifaCameo.handleEvents([{ type: 'catch', team: 1, keeper: 'nikolai', speed: 14.0 }], cameoMatch);
  })()`);
  assert.equal(await evaluate('window.__papifaCameo.getState().active'), null, 'Weak roller catch must never trigger cameo');

  // ---------- 4. Strong catch by Away keeper (team 1) with English narration -> #2 on Away right corner + EN audio ----------
  await evaluate("localStorage.setItem('papifa.narration.v2', 'en');");
  const prevAudioCnt = await evaluate('window.__papifaCameo.getState().audioPlayedCount');
  await evaluate(`(async () => {
    const { kickoff } = await import('./src/sim.js');
    kickoff(cameoMatch, 0);
    const gk1 = cameoMatch.players.find(p => p.team === 1 && p.isGK);
    // Launch a fierce 28 m/s shot straight into Away keeper's grasp (hits sim.js strong catch!)
    Object.assign(cameoMatch.ball, {
      owner: null, receiver: null, lastTouch: cameoMatch.players[4], inNet: false,
      shot: { team: 0, rolled: true, shooter: cameoMatch.players[4] },
      pos: { x: gk1.pos.x - 0.35, y: 0.9, z: gk1.pos.z },
      vel: { x: 28.5, y: 0, z: 0 },
    });
  })()`);

  const catchState = await waitFor("(() => { const s = window.__papifaCameo.getState(); return s.active && s.active.id === 'ante_geia' ? s : null; })()", 5000);
  assert.equal(catchState.active.team, 1, 'Strong catch by Away keeper must show on team 1 (right) corner');
  assert.equal(catchState.active.lang, 'en', 'English narration setting -> English cameo line');
  assert.ok(catchState.lastAudioUrl.endsWith('ante_geia_en.mp3'), `Audio URL: ${catchState.lastAudioUrl}`);
  await sleep(550);
  const midCatch = await evaluate('window.__papifaCameo.getState()');
  assert.ok(midCatch.audioPlayedCount > prevAudioCnt, 'Strong catch cameo must play English audio');
  const desktopCatchClr = await evaluate(CAMEO_CLEARANCE_JS);
  assert.ok(desktopCatchClr.cameo && desktopCatchClr.cameo.sel === '#cameo-slot-1', 'Team 1 slot visible on right');
  assert.deepEqual(desktopCatchClr.overlaps, [], `Desktop catch cameo overlaps: ${JSON.stringify(desktopCatchClr.overlaps)}`);
  assert.equal(desktopCatchClr.clipped, false, 'Desktop catch cameo not clipped');
  await shot('cameo-desktop-catch');

  // ---------- 4b. 4th goal by Home (score 4:1) -> #4 karvouno on CONCEDING team (team 1, right) corner + EL audio ----------
  await evaluate("localStorage.setItem('papifa.narration.v2', 'el'); window.__papifaCameo.stop(); cameoMatch.score = [4, 1]; window.__papifaCameo.handleEvents([{ type: 'goal', team: 0 }], cameoMatch);");
  const karvounoState = await waitFor("(() => { const s = window.__papifaCameo.getState(); return s.active && s.active.id === 'karvouno' && s.renderFrames > 4 ? s : null; })()", 5000);
  assert.equal(karvounoState.active.team, 1, '4th goal by Home must show #4 karvouno in CONCEDING team 1 (right) corner');
  assert.equal(karvounoState.active.lang, 'el');
  assert.ok(karvounoState.lastAudioUrl.endsWith('karvouno_el.mp3'), `Audio URL: ${karvounoState.lastAudioUrl}`);
  await sleep(750);
  const midKarv = await evaluate('window.__papifaCameo.getState()');
  assert.ok(midKarv.mouth > 0.01, `Karvouno runtime mouth morph must open during speech (mouth=${midKarv.mouth})`);
  const karvClr = await evaluate(CAMEO_CLEARANCE_JS);
  assert.ok(karvClr.cameo && karvClr.cameo.sel === '#cameo-slot-1', 'Team 1 conceding corner visible for karvouno');
  assert.deepEqual(karvClr.overlaps, [], `Desktop karvouno cameo overlaps: ${JSON.stringify(karvClr.overlaps)}`);
  await shot('cameo-desktop-karvouno');
  await evaluate('cameoMatch.score = [1, 0]; window.__papifaCameo.stop();');

  // ---------- 5. 4x Phone CPU Throttle Cost Measurement (active cameo vs idle baseline) ----------
  await send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const measureFrameMs = () => evaluate(`new Promise((resolve) => {
    const times = [];
    let last = performance.now();
    const step = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      if (times.length < 36) requestAnimationFrame(step);
      else {
        const sorted = [...times].sort((a, b) => a - b);
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        resolve({ avg: +avg.toFixed(2), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2), n: times.length });
      }
    };
    requestAnimationFrame(step);
  })`);
  // Measure active cameo under 4x CPU throttle
  await evaluate("window.__papifaCameo.stop(); window.__papifaCameo.handleEvents([{ type: 'goal', team: 0 }], cameoMatch);");
  await sleep(250);
  const cpuActive = await measureFrameMs();
  // Measure idle baseline (no cameo active) under 4x CPU throttle
  await evaluate('window.__papifaCameo.stop();');
  await sleep(250);
  const cpuIdle = await measureFrameMs();
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });

  // ---------- 6. Mute check (KeyM) -> cameo displays visibly, zero new audio ----------
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await sleep(100);
  const mutedBefore = await evaluate('window.__papifaCameo.getState().audioPlayedCount');
  await evaluate("window.__papifaCameo.handleEvents([{ type: 'goal', team: 0 }], cameoMatch);");
  await sleep(500);
  const mutedAfter = await evaluate('window.__papifaCameo.getState()');
  assert.ok(mutedAfter.active && mutedAfter.active.id === 'petsokopses', 'Muted cameo must still display visibly');
  assert.equal(mutedAfter.audioPlayedCount, mutedBefore, 'Muted cameo must NOT play audio');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });

  // ---------- 7. Portrait (390x844) & Landscape (844x390) layout clearance + screenshots ----------
  await setViewport(390, 844, true);
  await evaluate("document.documentElement.classList.add('touch-enabled'); document.querySelector('#touch-controls').hidden = false; window.dispatchEvent(new Event('resize'));");
  await evaluate("window.__papifaCameo.stop(); window.__papifaCameo.handleEvents([{ type: 'goal', team: 0 }], cameoMatch); document.querySelector('#banner').textContent = 'GOAL! Gold Cross';");
  await sleep(500);
  const portraitClr = await evaluate(CAMEO_CLEARANCE_JS);
  assert.ok(portraitClr.cameo, 'Portrait cameo visible');
  assert.deepEqual(portraitClr.overlaps, [], `Portrait (390x844) overlaps: ${JSON.stringify(portraitClr.overlaps)}`);
  assert.equal(portraitClr.clipped, false, 'Portrait cameo not clipped');
  await shot('cameo-portrait-goal');

  await setViewport(844, 390, true);
  await evaluate("window.dispatchEvent(new Event('resize')); document.querySelector('#banner').textContent = ''; window.__papifaCameo.stop(); window.__papifaCameo.handleEvents([{ type: 'catch', team: 1, kind: 'strong', speed: 28.0 }], cameoMatch);");
  await sleep(500);
  const landscapeClr = await evaluate(CAMEO_CLEARANCE_JS);
  assert.ok(landscapeClr.cameo, 'Landscape cameo visible');
  assert.deepEqual(landscapeClr.overlaps, [], `Landscape (844x390) overlaps: ${JSON.stringify(landscapeClr.overlaps)}`);
  assert.equal(landscapeClr.clipped, false, 'Landscape cameo not clipped');
  await shot('cameo-landscape-catch');

  const cspErrors = await evaluate('window.__cspErrors');
  assert.deepEqual(cspErrors, [], `CSP errors during cameo test: ${JSON.stringify(cspErrors)}`);

  const summary = {
    menuCameoFetches,
    loadedAfterKickoff,
    cpu4xThrottleMs: { idle: cpuIdle, activeCameo: cpuActive, deltaAvgMs: +(cpuActive.avg - cpuIdle.avg).toFixed(2) },
    clearance: {
      desktopGoal: desktopGoalClr.cameo,
      desktopCatch: desktopCatchClr.cameo,
      portrait390x844: portraitClr.cameo,
      landscape844x390: landscapeClr.cameo,
    },
  };
  if (out) writeFileSync(`${out}/cameo-report.json`, JSON.stringify(summary, null, 2));
  console.log('CDP cameo test PASSED:', JSON.stringify(summary));
}
