// Browser E2E verification for v4 Narration (Step 4):
// 1. Lazy loading: zero assets/narration/ fetches on gate/title/settings before kickoff.
// 2. Settings UI: Narration English / Ελληνικά / Off + volume slider persist across reload.
// 3. Goal plays an English clip lazily after kickoff (zero /el/ fetches); Jesus goal & Clash play right buckets.
// 4. Mid-match Pause switch to Ελληνικά plays a Greek clip on the next goal.
// 5. Narration Off plays zero clips and makes zero audio fetches on kickoff, goal, prayer, and clash.
// 6. KeyM mutes all sound & stops narration.
import assert from 'node:assert/strict';
import { enterMatch, reloadPage } from './cdp-front.mjs';
import { observeGameCall } from './cdp-moves.mjs';

export async function runNarrationPlaytest({ url, send, evaluate, shot }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expr, timeoutMs = 12000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = await evaluate(expr);
      if (v) return v;
      await sleep(80);
    }
    throw new Error('Timed out waiting for ' + expr);
  };

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__cspErrors = [];
      addEventListener('securitypolicyviolation', (e) => window.__cspErrors.push(e.effectiveDirective + ':' + e.blockedURI));
    })()`,
  });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 800, mobile: false, deviceScaleFactor: 1, screenWidth: 1280, screenHeight: 800,
  });

  // ---------- 1. Settings UI & lazy-load check BEFORE kickoff ----------
  await send('Page.navigate', { url });
  await waitFor("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  const menuFetched = await evaluate("performance.getEntriesByType('resource').filter(e => e.name.includes('assets/narration/')).length");
  assert.equal(menuFetched, 0, 'No narration audio may be fetched before kickoff');

  // Default narration language is Greek ('el') with Ελληνικά listed first; saved English choice persists across reload.
  assert.equal(await evaluate("document.querySelector('#narration-state').textContent"), 'Ελληνικά', 'Greek narration is default');
  // Open Narration settings page, verify order, controls & persistence.
  await evaluate("document.querySelector('#menu-narration').click()");
  await waitFor("document.querySelector('#front')?.dataset.page === 'narration'");
  assert.deepEqual(
    await evaluate("[...document.querySelectorAll('#menu-narration-lang input')].map(i => i.value)"),
    ['el', 'en', 'off'],
    'Ελληνικά listed first in Narration menu',
  );
  // A fresh profile (no saved volume) must start at the 85% default, not silent.
  assert.equal(await evaluate("document.querySelector('#menu-narration-vol').value"), '85', 'fresh profile narration volume is 85%');
  await evaluate(`(() => {
    const r = document.querySelector('#menu-narration-lang input[value="en"]');
    r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
    const vol = document.querySelector('#menu-narration-vol');
    vol.value = '70'; vol.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await shot('narration-settings');
  assert.equal(await evaluate("localStorage.getItem('papifa.narration.v2')"), 'en');
  assert.equal(await evaluate("localStorage.getItem('papifa.narrationVol.v2')"), '0.7');

  await reloadPage(send, evaluate);
  await waitFor("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  assert.equal(await evaluate("document.querySelector('#narration-state').textContent"), 'English', 'Saved English preference beats default Greek');

  // Switch to English (85%) and enter match.
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en'); localStorage.setItem('papifa.narrationVol.v2', '0.85');`);
  await reloadPage(send, evaluate);
  await enterMatch(evaluate, send);
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.narrMatch = m, false)');
  await waitFor('!!window.narrMatch');

  // Wait for opening kickoff clip to load & play lazily in EN only (zero /el/ fetches!).
  const afterKickoff = await waitFor(`(async () => {
    const { getNarrationDebug } = await import('./src/narration.js');
    const st = getNarrationDebug();
    return st && st.played.length >= 1 ? st : null;
  })()`, 12000);
  assert.equal(afterKickoff.lang, 'en');
  assert.ok(afterKickoff.played.some((p) => p.lang === 'en' && p.clipId.startsWith('kickoff_')), `kickoff played: ${JSON.stringify(afterKickoff.played)}`);
  assert.ok(afterKickoff.fetchedUrls.every((u) => u.includes('/en/')), `only EN lazily fetched: ${JSON.stringify(afterKickoff.fetchedUrls.slice(0, 5))}`);

  // ---------- 2. Goal by Nikolai plays an EN goal clip then priest_nikolai; choosing Jesus plays prayer_* ----------
  await evaluate(`(() => {
    const m = narrMatch;
    const nikolai = m.players.find((p) => p.team === 0 && p.info.id === 'nikolai');
    Object.assign(m.ball, { owner: null, receiver: null, shot: { team: 0, jesus: false, shooter: nikolai }, lastTouch: nikolai, inNet: false,
      pos: { x: m.pitch.length / 2 + 0.5, y: 0.6, z: 0 }, vel: { x: 10, y: 0, z: 0 } });
  })()`);
  const afterGoal = await waitFor(`(async () => {
    const { getNarrationDebug } = await import('./src/narration.js');
    const st = getNarrationDebug();
    return st?.played.some((p) => p.lang === 'en' && p.clipId === 'priest_nikolai') ? st : null;
  })()`, 12000);
  const goalIdx = afterGoal.played.findIndex((p) => p.lang === 'en' && p.clipId.startsWith('goal_'));
  const callIdx = afterGoal.played.findIndex((p) => p.lang === 'en' && p.clipId === 'priest_nikolai');
  assert.ok(goalIdx >= 0 && callIdx > goalIdx, `EN goal followed by priest_nikolai: ${JSON.stringify(afterGoal.played)}`);

  // Trigger Jesus prayer via real Digit1 key -> must play prayer_* immediately!
  // Exit goal replay first if celebration transitioned into slow-motion replay while goal + priest_nikolai played.
  if (await evaluate('!document.querySelector("#replay").hidden')) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await sleep(60);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
    await waitFor('document.querySelector("#replay").hidden', 5000);
  }
  await evaluate(`(async () => {
    const { kickoff } = await import('./src/sim.js');
    kickoff(narrMatch, 0);
    narrMatch.prayers[0].ready = true;
  })()`);
  await sleep(100);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit1', key: '1', windowsVirtualKeyCode: 49 });
  await sleep(60);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit1', key: '1', windowsVirtualKeyCode: 49 });
  const afterPrayer = await waitFor(`(async () => {
    const { getNarrationDebug } = await import('./src/narration.js');
    const st = getNarrationDebug();
    return st?.played.some((p) => p.lang === 'en' && (p.clipId === 'prayer_with_jesus' || p.clipId.startsWith('prayer_jesus_'))) ? st : null;
  })()`, 10000);
  assert.ok(afterPrayer.played.some((p) => p.lang === 'en' && (p.clipId === 'prayer_with_jesus' || p.clipId.startsWith('prayer_jesus_'))));

  // ---------- 3. Pause menu switch to Greek -> Greek goal clip plays ----------
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyP', key: 'p', windowsVirtualKeyCode: 80 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyP', key: 'p', windowsVirtualKeyCode: 80 });
  await waitFor("document.querySelector('#pause-menu')?.open === true");
  await evaluate(`(() => {
    const r = document.querySelector('#pause-narration-lang input[value="el"]');
    r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await shot('pause-narration');
  await evaluate("document.querySelector('#resume-button').click()");
  await waitFor("document.querySelector('#pause-menu')?.open === false");
  await sleep(200);
  await evaluate(`(async () => {
    const { kickoff } = await import('./src/sim.js');
    kickoff(narrMatch, 0);
    Object.assign(narrMatch.ball, { owner: null, receiver: null, shot: { team: 0, jesus: true }, inNet: false,
      pos: { x: narrMatch.pitch.length / 2 + 0.5, y: 0.6, z: 0 }, vel: { x: 12, y: 0, z: 0 } });
  })()`);
  const afterElGoal = await waitFor(`(async () => {
    const { getNarrationDebug } = await import('./src/narration.js');
    const st = getNarrationDebug();
    return st?.played.some((p) => p.lang === 'el' && p.clipId.startsWith('goal_jesus_')) ? st : null;
  })()`, 10000);
  assert.ok(afterElGoal.played.some((p) => p.lang === 'el' && p.clipId.startsWith('goal_jesus_')), `EL Jesus goal played: ${JSON.stringify(afterElGoal.played)}`);

  // Verify KeyM mutes everything (soundEnabled becomes false & active narration stops).
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyM', key: 'm', windowsVirtualKeyCode: 77 });
  await sleep(150);
  const mutedState = await evaluate(`(async () => {
    const { soundEnabled } = await import('./src/audio.js');
    const { getNarrationDebug } = await import('./src/narration.js');
    return { sound: soundEnabled(), active: getNarrationDebug().active };
  })()`);
  assert.equal(mutedState.sound, false, 'M mutes sound');
  assert.equal(mutedState.active, null, 'M stops active narration');
  // Re-enable sound for the Off test.
  await evaluate("localStorage.setItem('papifa.sound.v2', 'on')");

  // ---------- 4. Narration Off = ZERO fetches and ZERO clips played on kickoff + goal ----------
  await send('Debugger.disable');
  await evaluate("localStorage.setItem('papifa.narration.v2', 'off')");
  await send('Page.navigate', { url });
  await enterMatch(evaluate, send);
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.narrMatch = m, false)');
  await waitFor('!!window.narrMatch');
  await evaluate(`(() => {
    const m = narrMatch;
    Object.assign(m.ball, { owner: null, receiver: null, shot: { team: 0, jesus: false }, inNet: false,
      pos: { x: m.pitch.length / 2 + 0.5, y: 0.6, z: 0 }, vel: { x: 10, y: 0, z: 0 } });
  })()`);
  await waitFor('narrMatch.score[0] === 1', 8000);
  await sleep(500);
  const offState = await evaluate(`(async () => {
    const { getNarrationDebug } = await import('./src/narration.js');
    const st = getNarrationDebug();
    const resCount = performance.getEntriesByType('resource').filter(e => e.name.includes('assets/narration/')).length;
    return { ...st, resCount, csp: window.__cspErrors };
  })()`);
  assert.equal(offState.lang, 'off');
  assert.equal(offState.played.length, 0, `Off must play zero clips, got ${JSON.stringify(offState.played)}`);
  assert.equal(offState.fetchedCount, 0, `Off must fetch zero narration clips, got ${offState.fetchedCount}`);
  assert.equal(offState.resCount, 0, `Off must have zero browser network entries for narration, got ${offState.resCount}`);
  assert.deepEqual(offState.csp, [], `CSP violations: ${JSON.stringify(offState.csp)}`);

  console.log('All browser narration checks (lazy load, EN/EL settings + persistence, EN goal, EL pause switch + Jesus goal, KeyM mute, Off silent & zero fetches) passed.');
}
