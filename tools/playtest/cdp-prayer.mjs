// Browser E2E & visual layout verification for v4 Prayers (Step 2):
// Desktop keyboard (R hold -> cross fill -> 1 Jesus / 2 Mary -> unstoppable golden trail -> goal replay),
// Mary glowing goal + Clash burst & "Everyone is God's favorite child" (EN & EL),
// Gamepad right-stick prayer wheel, LT autopilot aim & Local 2P (both hands on both sides),
// Touch Pray hold + Jesus/Mary buttons + zero-HUD-overlap assertions at 1280x800, 390x844, and 320x568.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { enterMatch, reloadPage } from './cdp-front.mjs';
import { observeGameCall } from './cdp-moves.mjs';

const HUD_CLEARANCE_JS = `(() => {
  const visibleRect = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    return { sel, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  };
  const boxes = [
    visibleRect('#score'),
    visibleRect('#clock'),
    visibleRect('#controlled-bar'),
    visibleRect('#pause-button'),
    visibleRect('#move-help summary'),
    visibleRect('#prayer-0'),
    visibleRect('#prayer-1'),
    visibleRect('#power'),
    visibleRect('#power-1'),
    visibleRect('#touch-stick'),
    visibleRect('[data-control="pray"]'),
    visibleRect('[data-control="switch"]'),
    visibleRect('[data-control="pass"]'),
    visibleRect('[data-control="shoot"]'),
    visibleRect('[data-prayer-choice="jesus"]'),
    visibleRect('[data-prayer-choice="george"]'),
    visibleRect('[data-prayer-choice="mary"]'),
    visibleRect('[data-prayer-choice="phanourios"]'),
  ].filter(Boolean);
  const overlaps = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      // Check prayer slots and touch prayer choices against every other HUD/touch widget.
      const isPrayer = (s) => s.startsWith('#prayer-') || s.includes('data-prayer-choice');
      if (!isPrayer(a.sel) && !isPrayer(b.sel)) continue;
      const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (ox > 1 && oy > 1) overlaps.push({ a: a.sel, b: b.sel, ox: Math.round(ox), oy: Math.round(oy), ra: a, rb: b });
    }
  }
  const clipped = boxes
    .filter((b) => b.sel.startsWith('#prayer-'))
    .filter((b) => b.left < -1 || b.top < -1 || b.right > window.innerWidth + 1 || b.bottom > window.innerHeight + 1);
  return { vw: window.innerWidth, vh: window.innerHeight, boxes, overlaps, clipped };
})()`;

export async function runPrayerPlaytest({ url, out, send, evaluate, shot }) {
  // Deterministic rAF stepping + virtual gamepad support.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      let frame, now = performance.now();
      Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
      window.requestAnimationFrame = (fn) => { frame = fn; return 1; };
      window.advancePrayerTest = (ms = 17, count = 1) => {
        if (!frame) return false;
        for (let i = 0; i < count; i++) { now += ms; frame(now); }
        return true;
      };
      window.__virtualPads = [];
      window.__makePad = (index) => ({
        index, id: 'Virtual Pad ' + (index + 1), connected: true,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
      });
      Object.defineProperty(navigator, 'getGamepads', { value: () => window.__virtualPads, configurable: true });
    })()`,
  });

  const advance = (ms = 17, count = 1) => evaluate(`advancePrayerTest(${ms}, ${count})`);
  const screen = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', {
    width, height, mobile, deviceScaleFactor: 1, screenWidth: width, screenHeight: height,
  });
  const key = (type, code, k, vk) => send('Input.dispatchKeyEvent', { type, code, key: k, windowsVirtualKeyCode: vk });
  const fingers = (type, ...touchPoints) => send('Input.dispatchTouchEvent', { type, touchPoints });

  async function waitForKickoff() {
    for (let i = 0; i < 160; i++) {
      if (await evaluate('window.advancePrayerTest?.(0) && !!document.querySelector("#controlled")?.textContent')) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out waiting for kickoff');
  }

  async function assertClearance(label, minEmblemPx = 0) {
    const res = await evaluate(HUD_CLEARANCE_JS);
    assert.deepEqual(res.overlaps, [], `${label}: HUD overlaps: ${JSON.stringify(res.overlaps)}`);
    assert.deepEqual(res.clipped, [], `${label}: prayer HUD clipped off screen: ${JSON.stringify(res.clipped)}`);
    if (minEmblemPx > 0) {
      const sizes = await evaluate(`[...document.querySelectorAll('.prayer-emblem')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => Math.round(e.getBoundingClientRect().width))`);
      assert.ok(sizes.length > 0 && sizes.every((w) => w >= minEmblemPx), `${label}: emblem size ${JSON.stringify(sizes)} < ${minEmblemPx}px`);
    }
  }

  async function shotEmblem(name, selector = '#prayer-0') {
    if (!out) return;
    const rect = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.max(0, r.left - 10), y: Math.max(0, r.top - 10), width: Math.min(window.innerWidth, r.width + 20), height: Math.min(window.innerHeight, r.height + 20) }; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 3 } });
    writeFileSync(`${out}/${name}.png`, Buffer.from(r.result.data, 'base64'));
  }

  // ---------- 1. Desktop (1280x800): Controls text, Keyboard R hold -> ready -> Jesus -> golden trail -> replay + Mary + Clash ----------
  await screen(1280, 800, false);
  await send('Page.navigate', { url });
  await enterMatch(evaluate, send);
  await waitForKickoff();
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await advance(17, 4);

  // Verify updated Controls / Moves / Hints mention praying.
  const copyCheck = await evaluate(`({
    controlsText: document.querySelector('#controls-page').textContent,
    movesText: document.querySelector('#move-help').textContent,
    helpText: document.querySelector('#help').textContent,
  })`);
  assert.ok(copyCheck.controlsText.includes('Hold R for 2 s') && copyCheck.controlsText.includes('Push and hold the right stick'), 'Controls page lists keyboard & pad pray');
  assert.ok(copyCheck.movesText.includes('Pray (2 per match, Jesus uses both)'), 'Moves panel lists Pray');
  assert.ok(copyCheck.helpText.includes('hold R, 1 / 2 / 3') && copyCheck.helpText.includes('hold right stick'), 'Bottom hints list Pray');

  // Idle state (Release 2.1): both emblems visible at full size (~0.85 opacity, empty bar); human side shows EN/EL caption, AI side does not.
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en')`);
  await advance(17, 2);
  const idleCheck = await evaluate(`(() => {
    const e0 = document.querySelector('#prayer-0 .prayer-emblem');
    const e1 = document.querySelector('#prayer-1 .prayer-emblem');
    return {
      s0: document.querySelector('#prayer-0').dataset.state,
      s1: document.querySelector('#prayer-1').dataset.state,
      d0: getComputedStyle(e0).display,
      d1: getComputedStyle(e1).display,
      o0: parseFloat(getComputedStyle(e0).opacity),
      o1: parseFloat(getComputedStyle(e1).opacity),
      clip0: parseFloat(document.querySelector('#prayer-0 .prayer-bar-clip-rect').getAttribute('width')),
      cap0Hidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
      cap0Title: document.querySelector('#prayer-0 .prayer-caption-title').textContent,
      cap0Hint: document.querySelector('#prayer-0 .prayer-caption-hint').textContent,
      cap1Hidden: document.querySelector('#prayer-1 .prayer-caption').hidden,
    };
  })()`);
  assert.equal(idleCheck.s0, 'idle');
  assert.equal(idleCheck.s1, 'idle');
  assert.notEqual(idleCheck.d0, 'none', 'Team 0 emblem always visible in idle');
  assert.notEqual(idleCheck.d1, 'none', 'AI Team 1 emblem always visible in idle');
  assert.ok(idleCheck.o0 >= 0.8 && idleCheck.o0 <= 0.9, `Team 0 idle opacity ${idleCheck.o0}`);
  assert.ok(idleCheck.o1 >= 0.8 && idleCheck.o1 <= 0.9, `Team 1 idle opacity ${idleCheck.o1}`);
  assert.equal(idleCheck.clip0, 0, 'empty crossbar in idle');
  assert.equal(idleCheck.cap0Hidden, false, 'Human side shows idle blessing caption');
  assert.equal(idleCheck.cap0Title, 'Pray to receive a blessing');
  assert.equal(idleCheck.cap0Hint, 'hold R');
  assert.equal(idleCheck.cap1Hidden, true, 'AI side must not show idle caption');
  await assertClearance('desktop-idle', 105);
  await shot('desktop-idle');

  // Verify Greek idle caption when narration is EL, then restore EN.
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'el')`);
  await advance(17, 2);
  const idleEl = await evaluate(`({
    title: document.querySelector('#prayer-0 .prayer-caption-title').textContent,
    hint: document.querySelector('#prayer-0 .prayer-caption-hint').textContent,
  })`);
  assert.equal(idleEl.title, 'Προσευχήσου για να λάβεις ευλογία');
  assert.equal(idleEl.hint, 'κράτα R');
  await assertClearance('desktop-idle-el', 105);
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en')`);
  await advance(17, 2);

  // Hold R -> charging immediately (~1.0 s hold) -> crossbar fills, idle caption hides.
  await key('keyDown', 'KeyR', 'r', 82);
  await advance(50, 20); // 1.0 s -> ~50% full
  const midCharge = await evaluate(`({
    state: document.querySelector('#prayer-0').dataset.state,
    charge: testMatch.prayers[0].charge,
    clipW: parseFloat(document.querySelector('#prayer-0 .prayer-bar-clip-rect').getAttribute('width')),
    capHidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
  })`);
  assert.equal(midCharge.state, 'charging', `expected charging, got ${JSON.stringify(midCharge)}`);
  assert.ok(midCharge.charge > 0.35 && midCharge.clipW > 20, `crossbar filling: ${JSON.stringify(midCharge)}`);
  assert.equal(midCharge.capHidden, true, 'idle caption hides while charging');
  assert.equal(await evaluate("document.querySelector('#prayer-0 .prayer-status').textContent"), 'Keep holding to pray…');
  await assertClearance('desktop-charging', 105);
  await shot('desktop-charging');
  await shotEmblem('emblem-charging', '#prayer-0');

  // Keep holding R until full (ready), then release R -> stays ready without accidental pass.
  await advance(50, 24); // +1.2 s -> 100% ready
  const passesBefore = await evaluate('testMatch.stats[0].passes');
  await key('keyUp', 'KeyR', 'r', 82);
  await advance(17, 2);
  const readyState = await evaluate(`({
    state: document.querySelector('#prayer-0').dataset.state,
    ready: testMatch.prayers[0].ready,
    remaining: testMatch.prayers[0].remaining,
    status: document.querySelector('#prayer-0 .prayer-status').textContent,
    fontSize: parseFloat(getComputedStyle(document.querySelector('#prayer-0 .prayer-status')).fontSize),
    passesAfter: testMatch.stats[0].passes,
  })`);
  assert.equal(readyState.state, 'ready');
  assert.equal(readyState.ready, true);
  assert.equal(readyState.remaining, 2);
  assert.equal(readyState.status, '1 Jesus · 2 Mary · 3 George · 4 Phanourios');
  assert.ok(readyState.fontSize >= 18, `ready prompt fontSize ${readyState.fontSize} >= 18px`);
  assert.equal(readyState.passesAfter, passesBefore, 'releasing R after charging did not pass');
  await assertClearance('desktop-ready', 105);
  await shot('desktop-ready');
  await shotEmblem('emblem-ready', '#prayer-0');

  // Press Digit1 -> Jesus prayer active (golden aura + 15 s countdown + 1 bead left + descending Christ icon & "Jesus is with you!" banner on the SAME frame!).
  await key('keyDown', 'Digit1', '1', 49);
  await advance(17, 1);
  await key('keyUp', 'Digit1', '1', 49);
  const sameFrame = await evaluate(`({
    hudState: document.querySelector('#prayer-0').dataset.state,
    appHidden: document.querySelector('#prayer-apparition-0').hidden,
    appKind: document.querySelector('#prayer-apparition-0').dataset.kind,
    banner: document.querySelector('#prayer-apparition-0 .apparition-banner').textContent,
  })`);
  assert.equal(sameFrame.hudState, 'jesus', 'HUD aura activates on exact same frame');
  assert.equal(sameFrame.appHidden, false, 'Holy icon apparition starts descending on exact same frame');
  assert.equal(sameFrame.appKind, 'jesus');
  assert.equal(sameFrame.banner, 'Jesus is with you!');
  // Advance ~0.9 s into the 1.5 s hold -> verify icon fully loaded, in top third, and capture screenshot!
  await advance(50, 18);
  const jesusActive = await evaluate(`(() => {
    const app = document.querySelector('#prayer-apparition-0');
    const img = app.querySelector('.apparition-img');
    const r = app.querySelector('.apparition-stage').getBoundingClientRect();
    return {
      state: document.querySelector('#prayer-0').dataset.state,
      active: testMatch.prayers[0].active,
      remaining: testMatch.prayers[0].remaining,
      timer: document.querySelector('#prayer-0 .prayer-timer').textContent,
      imgW: img.naturalWidth,
      stageBottom: Math.round(r.bottom),
      vh: window.innerHeight,
    };
  })()`);
  assert.equal(jesusActive.state, 'jesus');
  assert.equal(jesusActive.active, 'jesus');
  assert.equal(jesusActive.remaining, 0, 'Jesus uses both prayer slots');
  assert.ok(jesusActive.timer.includes('10s') || jesusActive.timer.includes('9s'), `Jesus lasts 10 s: timer=${jesusActive.timer}`);
  assert.ok(jesusActive.imgW >= 256, `Christ icon WebP loaded: naturalWidth=${jesusActive.imgW}`);
  assert.ok(jesusActive.stageBottom <= jesusActive.vh * 0.36, `Christ icon stays in top third: bottom=${jesusActive.stageBottom}/${jesusActive.vh}`);
  await assertClearance('desktop-jesus-active', 105);
  await shot('desktop-jesus-active');
  await shotEmblem('emblem-jesus', '#prayer-0');

  // Position team 0 striker cleanly in attacking half, give him the ball, and shoot with F -> Jesus shot golden trail + goal + replay!
  await evaluate(`(() => {
    const h = testMatch.human;
    h.pos = { x: 8, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: 8.75, y: 0.3, z: 0 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of testMatch.players) if (p !== h && !p.isGK) p.pos = { x: -12, z: p.pos.z };
  })()`);
  await advance(17, 2);
  await key('keyDown', 'KeyF', 'f', 70);
  await advance(50, 6);
  await key('keyUp', 'KeyF', 'f', 70);
  await advance(17, 16); // mid-flight with golden trail & shooter light
  const inFlight = await evaluate(`({
    jesus: !!testMatch.ball.shot?.jesus,
    ballX: testMatch.ball.pos.x,
    score0: testMatch.score[0],
  })`);
  assert.ok(inFlight.jesus || inFlight.score0 === 1, `Jesus shot launched: ${JSON.stringify(inFlight)}`);
  await shot('desktop-jesus-trail');

  // Step through goal celebration into slow-motion goal replay -> capture Jesus beam + descending Christ icon in replay!
  let replaying = false;
  for (let i = 0; i < 180; i++) {
    await advance(17, 2);
    if (await evaluate('!document.querySelector("#replay").hidden')) { replaying = true; break; }
  }
  assert.ok(replaying, 'Goal replay started after Jesus goal');
  // Verify the prayer apparition also appears inside the goal replay window (prayer occurred ~1.2 s before goal!).
  let sawReplayApparition = false;
  for (let i = 0; i < 120; i++) {
    await advance(50, 1);
    if (!sawReplayApparition && await evaluate('!document.querySelector("#prayer-apparition-0").hidden')) {
      sawReplayApparition = true;
      await advance(50, 10);
      await shot('desktop-jesus-replay-apparition');
    }
  }
  assert.equal(sawReplayApparition, true, 'Descending Christ icon appeared inside the goal replay window');
  await shot('desktop-jesus-replay');
  // Skip replay cleanly back to play.
  await key('keyDown', 'Space', ' ', 32);
  await advance(17, 2);
  await key('keyUp', 'Space', ' ', 32);
  await advance(17, 10);

  // ---------- 2. Mary glowing goal + Team 1 Theotokos apparition + Clash burst & "Everyone is God's favorite child" (EN + EL) ----------
  await evaluate(`(async () => {
    const { kickoff } = await import('./src/sim.js');
    kickoff(testMatch, 0);
    testMatch.clock = 120;
    testMatch.prayers[1].ready = true;
    testMatch.prayers[1].remaining = 2;
    testMatch.prayers[1].active = null;
    testMatch.prayers[1].ai.intent = 'mary';
    testMatch.prayers[1].ai.cd = 0;
    testMatch.prayers[0].ready = true;
    testMatch.prayers[0].remaining = 2;
    testMatch.prayers[0].active = null;
    const h = testMatch.human;
    h.pos = { x: 24, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: 24.75, y: 0.3, z: 0 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of testMatch.players) if (p !== h && !p.isGK) p.pos = { x: -16, z: p.pos.z };
  })()`);
  await advance(17, 50); // ~0.85 s into Mary apparition hold on Team 1 right side!
  const maryState = await evaluate(`(async () => {
    const img = document.querySelector('#prayer-apparition-1 .apparition-img');
    if (img && (!img.complete || img.naturalWidth === 0)) {
      await img.decode().catch(() => {});
    }
    return {
      hud: document.querySelector('#prayer-1').dataset.state,
      appHidden: document.querySelector('#prayer-apparition-1').hidden,
      appKind: document.querySelector('#prayer-apparition-1').dataset.kind,
      banner: document.querySelector('#prayer-apparition-1 .apparition-banner').textContent,
      imgW: img ? img.naturalWidth : 0,
    };
  })()`);
  assert.equal(maryState.hud, 'mary', 'Team 1 Mary HUD active');
  assert.equal(maryState.appHidden, false, 'Team 1 Mary icon descending on right side');
  assert.equal(maryState.appKind, 'mary');
  assert.equal(maryState.banner, 'Mother Mary is with you!');
  assert.ok(maryState.imgW >= 256, `Theotokos icon WebP loaded: ${maryState.imgW}`);
  await assertClearance('desktop-mary-goal', 105);
  await shot('desktop-mary-goal');
  await shotEmblem('emblem-mary', '#prayer-1');
  // Advance past 3.1 s total -> confirm apparition fades out & hides cleanly!
  await advance(50, 52);
  assert.equal(await evaluate('document.querySelector("#prayer-apparition-1").hidden'), true, 'Apparition hides cleanly after ~3 s');

  // Re-place ball cleanly at h's feet, press Numpad1 (Jesus), and shoot at Team 1's Mary-glowing goal -> CLASH!
  await evaluate(`(() => {
    const h = testMatch.human;
    h.pos = { x: 18, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: 18.75, y: 0.3, z: 0 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of testMatch.players) if (p !== h && !p.isGK) p.pos = { x: -16, z: p.pos.z };
  })()`);
  await key('keyDown', 'Numpad1', '1', 97);
  await advance(17, 2);
  await key('keyUp', 'Numpad1', '1', 97);
  await advance(17, 1);
  await key('keyDown', 'KeyF', 'f', 70);
  await advance(50, 4);
  await key('keyUp', 'KeyF', 'f', 70);
  let clashBanner = '';
  for (let i = 0; i < 90; i++) {
    await advance(17, 1);
    const txt = await evaluate('document.querySelector("#banner").textContent');
    if (txt.includes('favorite child')) { clashBanner = txt; break; }
  }
  assert.equal(clashBanner, "Everyone is God's favorite child", `clash banner EN: ${clashBanner}`);
  const clashClass = await evaluate('document.querySelector("#banner").classList.contains("clash-banner")');
  assert.equal(clashClass, true);
  await advance(17, 6); // mid-0.6s hold with burst of light visible!
  await shot('desktop-clash-en');

  // Verify Greek clash banner text when narration.v2 = 'el'.
  await evaluate(`(async () => {
    localStorage.setItem('papifa.narration.v2', 'el');
    const { choosePrayer, shoot } = await import('./src/sim.js');
    const h = testMatch.human;
    h.pos = { x: 20, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: 20.75, y: 0.3, z: 0 }; testMatch.ball.clashDrop = false;
    testMatch.prayers[0].remaining = 2; testMatch.prayers[0].ready = true; testMatch.prayers[0].active = null;
    testMatch.prayers[1].remaining = 2; testMatch.prayers[1].ready = true; testMatch.prayers[1].active = null;
    choosePrayer(testMatch, 1, 'mary');
    choosePrayer(testMatch, 0, 'jesus');
    shoot(testMatch, h, 0.7, 0);
  })()`);
  let clashBannerEl = '';
  for (let i = 0; i < 60; i++) {
    await advance(17, 1);
    const txt = await evaluate('document.querySelector("#banner").textContent');
    if (txt.includes('αγαπημένο')) { clashBannerEl = txt; break; }
  }
  assert.equal(clashBannerEl, 'Ο καθένας είναι το αγαπημένο παιδί του Θεού!', `clash banner EL: ${clashBannerEl}`);
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en')`);

  // ---------- 2b. St George on Horseback: Digit3 -> Byzantine icon + mounted white horse gallop + a tackle only knocks the horse away ----------
  await evaluate(`(() => {
    const h = testMatch.human;
    h.pos = { x: -4, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0; h.stamina = 1;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: -3.25, y: 0.3, z: 0 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of testMatch.players) if (p !== h && !p.isGK) p.pos = { x: p.team === 0 ? -20 : 20, z: p.pos.z };
    testMatch.prayers[0].remaining = 2; testMatch.prayers[0].ready = true; testMatch.prayers[0].active = null; testMatch.prayers[0].riderSlot = -1;
    testMatch.prayers[1].active = null; testMatch.prayers[1].timeLeft = 0; testMatch.prayers[1].riderSlot = -1;
    document.querySelector('#banner').textContent = '';
  })()`);
  await advance(17, 2);
  await key('keyDown', 'Digit3', '3', 51);
  await advance(17, 1);
  await key('keyUp', 'Digit3', '3', 51);
  // Sprint forward so the horse is mid-gallop while St George icon descends & holds!
  await key('keyDown', 'KeyD', 'd', 68);
  await key('keyDown', 'ShiftLeft', 'Shift', 16);
  await advance(50, 16); // ~0.8 s -> mid-gallop & icon hold
  const georgeDesktop = await evaluate(`(async () => {
    const app = document.querySelector('#prayer-apparition-0');
    const img = app.querySelector('.apparition-img');
    if (img && (!img.complete || img.naturalWidth === 0)) await img.decode().catch(() => {});
    return {
      hudState: document.querySelector('#prayer-0').dataset.state,
      active: testMatch.prayers[0].active,
      riderSlot: testMatch.prayers[0].riderSlot,
      humanSlot: testMatch.players.indexOf(testMatch.human),
      speed: testMatch.human.speed,
      appHidden: app.hidden,
      appKind: app.dataset.kind,
      banner: app.querySelector('.apparition-banner').textContent,
      imgW: img ? img.naturalWidth : 0,
    };
  })()`);
  assert.equal(georgeDesktop.hudState, 'george', 'St George HUD state active');
  assert.equal(georgeDesktop.active, 'george');
  assert.equal(georgeDesktop.riderSlot, georgeDesktop.humanSlot, 'controlled priest mounted on white horse');
  assert.ok(georgeDesktop.speed > 9.5, `mounted gallop speed boosted (+30%): ${georgeDesktop.speed.toFixed(2)}`);
  assert.equal(georgeDesktop.appHidden, false, 'St George apparition visible');
  assert.equal(georgeDesktop.appKind, 'george');
  assert.equal(georgeDesktop.banner, 'St George is with you!');
  assert.ok(georgeDesktop.imgW >= 256, `St George icon WebP loaded: ${georgeDesktop.imgW}`);
  await assertClearance('desktop-george-riding', 105);
  await shot('desktop-george-riding');
  await shotEmblem('emblem-george', '#prayer-0');
  // Switch to close camera preset (KeyV -> zoom 0.5) for a razor-sharp native in-game close-up of the Tripo horse & seated priest!
  await key('keyDown', 'KeyV', 'v', 86); await key('keyUp', 'KeyV', 'v', 86);
  await advance(50, 14);
  if (out) {
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 240, y: 150, width: 800, height: 520, scale: 1.5 } });
    writeFileSync(`${out}/desktop-george-closeup.png`, Buffer.from(r.result.data, 'base64'));
  }
  // Cycle KeyV twice to restore default broadcast zoom cleanly.
  await key('keyDown', 'KeyV', 'v', 86); await key('keyUp', 'KeyV', 'v', 86);
  await key('keyDown', 'KeyV', 'v', 86); await key('keyUp', 'KeyV', 'v', 86);
  await key('keyUp', 'KeyD', 'd', 68);
  await key('keyUp', 'ShiftLeft', 'Shift', 16);

  // A defender's tackle knocks the horse away (St George ends early), but the rider is thrown ~2 m on and keeps the ball.
  const dismounted = await evaluate(`(async () => {
    const { tackle } = await import('./src/sim.js');
    const rider = testMatch.players[testMatch.prayers[0].riderSlot];
    const def = testMatch.players.find((p) => p.team === 1 && !p.isGK);
    rider.vel = { x: 0, z: 0 }; rider.facing = 0;
    rider.pos = { x: 0, z: 0 };
    for (const p of testMatch.players) if (p !== rider && p !== def) p.pos = { x: p.team === 0 ? -20 : 20, z: p.pos.z };
    def.pos = { x: rider.pos.x + 0.9, z: rider.pos.z + 0.9 }; def.facing = Math.PI;
    testMatch.ball.owner = rider; testMatch.ball.pos = { x: rider.pos.x + 0.75, y: 0.3, z: rider.pos.z };
    const from = { ...rider.pos };
    const origRand = testMatch.rand;
    testMatch.rand = () => 0;
    tackle(testMatch, def);
    testMatch.rand = origRand;
    return {
      active: testMatch.prayers[0].active, riderSlot: testMatch.prayers[0].riderSlot,
      keeps: testMatch.ball.owner === rider, moved: Math.hypot(rider.pos.x - from.x, rider.pos.z - from.z), stun: rider.stun,
    };
  })()`);
  assert.equal(dismounted.active, null, 'tackle knocks the horse away and ends St George early');
  assert.equal(dismounted.riderSlot, -1);
  assert.equal(dismounted.keeps, true, `the thrown rider keeps the ball: ${JSON.stringify(dismounted)}`);
  assert.ok(dismounted.moved > 1.5 && dismounted.moved <= 2.01, `rider thrown ~2 m: ${dismounted.moved}`);
  assert.equal(dismounted.stun, 0);

  // ---------- 2c. St Phanourios: Digit4 -> icon + banner + a loose ball curves to the team, glowing ----------
  await evaluate(`(() => {
    const h = testMatch.human;
    h.pos = { x: -4, z: 0 }; h.vel = { x: 0, z: 0 }; h.facing = 0;
    testMatch.ball.owner = h; testMatch.ball.pos = { x: -3.25, y: 0.3, z: 0 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    for (const p of testMatch.players) if (p !== h && !p.isGK) p.pos = { x: p.team === 0 ? -20 : 20, z: p.pos.z };
    testMatch.prayers[0].remaining = 2; testMatch.prayers[0].ready = true; testMatch.prayers[0].active = null; testMatch.prayers[0].riderSlot = -1;
    document.querySelector('#banner').textContent = '';
  })()`);
  await advance(17, 2);
  await key('keyDown', 'Digit4', '4', 52);
  await advance(17, 1);
  await key('keyUp', 'Digit4', '4', 52);
  // Knock the ball loose 6 m ahead of the priest and freeze him: St Phanourios brings it back.
  await evaluate(`(() => {
    const h = testMatch.human;
    testMatch.ball.owner = null; testMatch.ball.receiver = null; testMatch.ball.shot = null;
    testMatch.ball.clashDrop = false; testMatch.ball.clashHoldT = 0; testMatch.ball.inNet = false;
    testMatch.ball.pos = { x: 2, y: 0.3, z: 1.5 }; testMatch.ball.vel = { x: 0, y: 0, z: 0 };
    window.__phanDbg = () => ({ phase: testMatch.phase, owner: testMatch.ball.owner?.info?.id ?? null, pos: testMatch.ball.pos, stun: h.stun, active: testMatch.prayers[0].active });
    window.__phanHold = () => { h.pos = { x: -4, z: 0 }; h.vel = { x: 0, z: 0 }; };
  })()`);
  let phanGlow = false;
  for (let i = 0; i < 16; i++) {
    await evaluate('window.__phanHold()');
    await advance(50, 1);
    if (await evaluate('testMatch.ball.foundBy === 0')) phanGlow = true;
  }
  if (out) await shot('desktop-phanourios-pull');
  let phanFound = false;
  for (let i = 0; i < 40 && !phanFound; i++) {
    await evaluate('window.__phanHold()');
    await advance(50, 1);
    phanFound = await evaluate('testMatch.ball.owner === testMatch.human');
  }
  const phanDesktop = await evaluate(`(async () => {
    const app = document.querySelector('#prayer-apparition-0');
    const img = app.querySelector('.apparition-img');
    if (img && (!img.complete || img.naturalWidth === 0)) await img.decode().catch(() => {});
    return {
      hudState: document.querySelector('#prayer-0').dataset.state,
      status: document.querySelector('#prayer-0 .prayer-status').textContent,
      active: testMatch.prayers[0].active, remaining: testMatch.prayers[0].remaining,
      timeLeft: testMatch.prayers[0].timeLeft,
      appKind: app.dataset.kind, appHidden: app.hidden,
      banner: app.querySelector('.apparition-banner').textContent,
      imgW: img ? img.naturalWidth : 0,
      ballDist: Math.hypot(testMatch.ball.pos.x + 4, testMatch.ball.pos.z),
    };
  })()`);
  assert.equal(phanDesktop.active, 'phanourios', `Digit4 starts St Phanourios: ${JSON.stringify(phanDesktop)}`);
  assert.equal(phanDesktop.remaining, 1);
  assert.equal(phanDesktop.hudState, 'phanourios');
  assert.equal(phanDesktop.status, 'St Phanourios');
  assert.ok(phanDesktop.timeLeft > 13 && phanDesktop.timeLeft <= 15, `15 s blessing: ${phanDesktop.timeLeft}`);
  assert.equal(phanDesktop.appHidden, false);
  assert.equal(phanDesktop.appKind, 'phanourios');
  assert.equal(phanDesktop.banner, 'St Phanourios is with you!');
  assert.ok(phanDesktop.imgW >= 256, `St Phanourios icon loaded: ${phanDesktop.imgW}`);
  assert.ok(phanGlow, `the loose ball is marked as found (glowing) while it curves in: ${JSON.stringify(await evaluate('window.__phanDbg()'))}`);
  assert.ok(phanFound, `the loose ball rolled back to the priest (now ${phanDesktop.ballDist.toFixed(2)} m away)`);
  await assertClearance('desktop-phanourios', 105);
  await shot('desktop-phanourios-active');
  await shotEmblem('emblem-phanourios', '#prayer-0');
  await evaluate(`delete window.__phanHold; delete window.__phanDbg`);
  await evaluate(`localStorage.removeItem('papifa.narration.v2')`);

  // Desktop spent state: both emblems stay visible, greyed/desaturated (~0.5 opacity), caption hidden.
  await evaluate(`(() => {
    for (const pr of testMatch.prayers) { pr.remaining = 0; pr.active = null; pr.ready = false; pr.charging = false; pr.charge = 0; pr.timeLeft = 0; }
    document.querySelector('#banner').textContent = '';
  })()`);
  await advance(17, 2);
  await evaluate(`document.querySelectorAll('.prayer-emblem').forEach((e) => { void getComputedStyle(e).opacity; e.getAnimations().forEach((a) => a.finish()); })`);
  const spentCheck = await evaluate(`(() => {
    const e0 = document.querySelector('#prayer-0 .prayer-emblem');
    const e1 = document.querySelector('#prayer-1 .prayer-emblem');
    return {
      s0: document.querySelector('#prayer-0').dataset.state,
      s1: document.querySelector('#prayer-1').dataset.state,
      d0: getComputedStyle(e0).display,
      d1: getComputedStyle(e1).display,
      o0: parseFloat(getComputedStyle(e0).opacity),
      o1: parseFloat(getComputedStyle(e1).opacity),
      f0: getComputedStyle(e0).filter,
      f1: getComputedStyle(e1).filter,
      cap0Hidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
    };
  })()`);
  assert.equal(spentCheck.s0, 'spent');
  assert.equal(spentCheck.s1, 'spent');
  assert.notEqual(spentCheck.d0, 'none', 'Team 0 emblem visible when spent');
  assert.notEqual(spentCheck.d1, 'none', 'AI Team 1 emblem visible when spent');
  assert.ok(spentCheck.o0 >= 0.45 && spentCheck.o0 <= 0.55, `spent opacity ${spentCheck.o0}`);
  assert.ok(spentCheck.f0.includes('grayscale'), `spent filter desaturated: ${spentCheck.f0}`);
  assert.ok(spentCheck.f1.includes('grayscale'), `AI spent filter desaturated: ${spentCheck.f1}`);
  assert.equal(spentCheck.cap0Hidden, true, 'idle caption hidden when spent');
  await assertClearance('desktop-spent', 105);
  await shot('desktop-spent');

  // ---------- 3. Gamepad LT + D-pad + Right-stick aim + Local 2P (both hands on both sides) + 320px portrait clearance ----------
  await send('Debugger.disable');
  await screen(1280, 800, false);
  await send('Page.navigate', { url });
  // Navigate to Local 2P claim: Keyboard P1 + Virtual Pad P2.
  await evaluate(`(() => {
    window.__virtualPads = [window.__makePad(0)];
  })()`);
  for (let i = 0; i < 80; i++) {
    if (await evaluate('document.querySelector("#front")?.dataset.ready === "true" && !document.querySelector("#title-page").hidden')) break;
    await new Promise((r) => setTimeout(r, 60));
  }
  await evaluate('document.querySelector("#new-game").click()');
  await evaluate('document.querySelector(\'#play-mode input[value="local"]\').click()');
  // P1 claims keyboard via Space, P2 claims pad 0 via button A (tick rAF so menu.js polls the virtual pad).
  await key('keyDown', 'Space', ' ', 32); await key('keyUp', 'Space', ' ', 32);
  await advance(17, 4);
  await evaluate('window.__virtualPads[0].buttons[0].pressed = true');
  await advance(17, 6);
  await evaluate('window.__virtualPads[0].buttons[0].pressed = false');
  await advance(17, 4);
  const claimed = await evaluate('[document.querySelector("#claim-slot-0").dataset.state, document.querySelector("#claim-slot-1").dataset.state]');
  assert.deepEqual(claimed, ['claimed', 'claimed'], `Local 2P device claims: ${JSON.stringify(claimed)}`);
  await evaluate('document.querySelector("#claim-continue").click()');
  await advance(17, 4);
  await evaluate('document.querySelector("#kick-off").click()');
  await waitForKickoff();
  // Skip venue intro.
  if (await evaluate('!document.querySelector("#venue-intro").hidden')) {
    await evaluate('document.querySelector("#skip-intro").click()');
  }
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await advance(17, 4);

  // Verify live browser gamepad LT autopilot on P2: with LT held the left stick only aims, so A passes south.
  await evaluate(`(() => {
    const m = testMatch, p2 = m.humans[1];
    p2.pos = { x: 4, z: 0 }; p2.vel = { x: 0, z: 0 };
    m.ball.owner = p2; m.ball.pos = { x: 3.3, y: 0.3, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    const mates = m.players.filter((p) => p.team === 1 && p !== p2 && !p.isGK);
    mates[0].pos = { x: 2, z: -12 };
    mates[1].pos = { x: 2, z: 12 };
    window.__rstickSouthId = mates[1].info.id;
    for (const p of m.players) if (p !== p2) p.stun = 4;
    window.__virtualPads[0].axes = [0, 1, 0, 0];
    window.__virtualPads[0].buttons[6].pressed = true; window.__virtualPads[0].buttons[6].value = 1;
    window.__virtualPads[0].buttons[0].pressed = true;
  })()`);
  await advance(17, 2);
  const rstickRes = await evaluate(`(() => {
    window.__virtualPads[0].buttons[0].pressed = false;
    window.__virtualPads[0].buttons[6].pressed = false; window.__virtualPads[0].buttons[6].value = 0;
    window.__virtualPads[0].axes = [0, 0, 0, 0];
    return { receiverId: testMatch.ball.receiver?.info?.id, expectedSouth: window.__rstickSouthId };
  })()`);
  assert.equal(rstickRes.receiverId, rstickRes.expectedSouth, `browser gamepad LT autopilot aim pass: ${JSON.stringify(rstickRes)}`);
  await advance(17, 2);

  // The right-stick prayer wheel shows for the gamepad player only, and dims Jesus once only one slot is left.
  await advance(17, 2);
  const wheel = await evaluate(`({
    w0: document.querySelector('#prayer-0 .prayer-wheel').hidden,
    w1: document.querySelector('#prayer-1 .prayer-wheel').hidden,
    icons: [...document.querySelectorAll('#prayer-1 .pw-icon')].every(i => i.complete && i.naturalWidth > 0),
    count: document.querySelectorAll('#prayer-1 .pw-icon').length,
    below: (() => {
      const st = document.querySelector('#prayer-1 .pw-stick').getBoundingClientRect();
      const ph = document.querySelector('#prayer-1 .pw-phanourios').getBoundingClientRect();
      return ph.top >= st.bottom - 1 && Math.abs((ph.left + ph.right) / 2 - (st.left + st.right) / 2) < 3;
    })(),
  })`);
  assert.deepEqual(wheel, { w0: true, w1: false, icons: true, count: 4, below: true }, `prayer wheel visibility: ${JSON.stringify(wheel)}`);
  await shot('local2p-desktop-wheel');
  await evaluate('testMatch.prayers[1].remaining = 1');
  await advance(17, 2);
  assert.equal(await evaluate("document.querySelector('#prayer-1 .prayer-wheel').classList.contains('no-jesus')"), true, 'Jesus dims with one slot left');
  await evaluate('testMatch.prayers[1].remaining = 2');
  await advance(17, 2);

  // Verify Local 2P idle clearance at 320x568 with BOTH human captions + emblems visible!
  await screen(320, 568, true);
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en'); window.dispatchEvent(new Event('resize'))`);
  await advance(17, 4);
  const l2pIdle = await evaluate(`({
    c0Hidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
    c1Hidden: document.querySelector('#prayer-1 .prayer-caption').hidden,
    t0: document.querySelector('#prayer-0 .prayer-caption-title').textContent,
    h0: document.querySelector('#prayer-0 .prayer-caption-hint').textContent,
    t1: document.querySelector('#prayer-1 .prayer-caption-title').textContent,
    h1: document.querySelector('#prayer-1 .prayer-caption-hint').textContent,
  })`);
  assert.equal(l2pIdle.c0Hidden, false);
  assert.equal(l2pIdle.c1Hidden, false);
  assert.equal(l2pIdle.t0, 'Pray for a blessing');
  assert.equal(l2pIdle.h0, 'hold R');
  assert.equal(l2pIdle.t1, 'Pray for a blessing');
  assert.equal(l2pIdle.h1, 'hold right stick ◀ / ▲ / ▶ / ▼');
  await assertClearance('local2p-320-idle', 56);
  await shot('local2p-320-idle');
  await screen(1280, 800, false);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await advance(17, 4);

  // Simultaneously: P1 holds R (keyboard), P2 holds the right stick to the right (Mary fires when the cross is full).
  await key('keyDown', 'KeyR', 'r', 82);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 1, 0]');
  await advance(50, 44); // 2.2 s -> P1 ready, P2's Mary already started
  await key('keyUp', 'KeyR', 'r', 82);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 0, 0]');
  await advance(17, 2);
  const bothCharged = await evaluate('[testMatch.prayers[0].ready, testMatch.prayers[1].active]');
  assert.deepEqual(bothCharged, [true, 'mary'], 'Local 2P both players charge independently; right stick right fires Mary');

  // P1 presses Digit1 (Jesus).
  await key('keyDown', 'Digit1', '1', 49);
  await advance(17, 3);
  await key('keyUp', 'Digit1', '1', 49);
  await advance(17, 4);
  const bothActive = await evaluate('[document.querySelector("#prayer-0").dataset.state, document.querySelector("#prayer-1").dataset.state]');
  assert.deepEqual(bothActive, ['jesus', 'mary'], 'Local 2P P1 Jesus + P2 Mary both active simultaneously');
  await assertClearance('local2p-desktop');
  await shot('local2p-desktop-prayers');

  // Verify P2 right stick UP activates St George cleanly!
  await evaluate(`(() => { const pr = testMatch.prayers[1]; pr.active = null; pr.timeLeft = 0; pr.riderSlot = -1; pr.ready = false; pr.charge = 0; })()`);
  await advance(17, 2);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 0, -1]');
  await advance(50, 44);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 0, 0]');
  await advance(17, 2);
  const padGeorge = await evaluate('({ active: testMatch.prayers[1].active, riderSlot: testMatch.prayers[1].riderSlot, state: document.querySelector("#prayer-1").dataset.state })');
  assert.equal(padGeorge.active, 'george', `Gamepad right stick UP activates St George: ${JSON.stringify(padGeorge)}`);
  assert.ok(padGeorge.riderSlot >= 0);
  assert.equal(padGeorge.state, 'george');

  // And right stick DOWN asks St Phanourios.
  await evaluate(`(() => { const pr = testMatch.prayers[1]; pr.active = null; pr.timeLeft = 0; pr.riderSlot = -1; pr.ready = false; pr.charge = 0; pr.remaining = 2; })()`);
  await advance(17, 2);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 0, 1]');
  await advance(50, 44);
  await evaluate('window.__virtualPads[0].axes = [0, 0, 0, 0]');
  await advance(17, 2);
  const padPhan = await evaluate('({ active: testMatch.prayers[1].active, state: document.querySelector("#prayer-1").dataset.state })');
  assert.deepEqual(padPhan, { active: 'phanourios', state: 'phanourios' }, `Gamepad right stick DOWN activates St Phanourios: ${JSON.stringify(padPhan)}`);

  // Also check 320x568 portrait clearance with BOTH prayer badges active AND both shot meters visible (>= 56 px emblem)!
  await screen(320, 568, true);
  await evaluate(`window.dispatchEvent(new Event('resize')); testMatch.chargings = [true, true]; testMatch.charges = [0.6, 0.7]; void 0`);
  await advance(17, 6);
  await assertClearance('local2p-320-portrait', 56);
  await shot('local2p-320-portrait');

  // ---------- 4. Touch (390x844, 430x932 & 320x568): Pray hold -> larger Jesus & Mary buttons (no text prompt) -> Mary active + zero HUD overlap ----------
  await send('Debugger.disable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await screen(390, 844, true);
  await send('Page.navigate', { url });
  await enterMatch(evaluate, send, async () => {
    const p = await evaluate(`(() => { const r = document.querySelector('#claim-slot-0').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }; })()`);
    await fingers('touchStart', p);
    await fingers('touchEnd');
  });
  await waitForKickoff();
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await evaluate(`localStorage.setItem('papifa.narration.v2', 'en')`);
  await advance(17, 4);

  // Touch idle at 390x844, 430x932, and 320x568 (shortened "Pray for a blessing" + "hold Pray", both emblems visible, clears shot meter).
  const touchIdle390 = await evaluate(`({
    s0: document.querySelector('#prayer-0').dataset.state,
    s1: document.querySelector('#prayer-1').dataset.state,
    c0Hidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
    c1Hidden: document.querySelector('#prayer-1 .prayer-caption').hidden,
    t0: document.querySelector('#prayer-0 .prayer-caption-title').textContent,
    h0: document.querySelector('#prayer-0 .prayer-caption-hint').textContent,
  })`);
  assert.equal(touchIdle390.s0, 'idle');
  assert.equal(touchIdle390.s1, 'idle');
  assert.equal(touchIdle390.c0Hidden, false);
  assert.equal(touchIdle390.c1Hidden, true);
  assert.equal(touchIdle390.t0, 'Pray for a blessing');
  assert.equal(touchIdle390.h0, 'hold Pray');
  await assertClearance('touch-390-idle', 72);
  await shot('touch-390-idle');

  await screen(430, 932, true);
  await evaluate(`window.dispatchEvent(new Event('resize')); testMatch.chargings[0] = true; testMatch.charges[0] = 0.5; void 0`);
  await advance(17, 4);
  assert.equal(await evaluate(`document.querySelector('#prayer-0 .prayer-caption-title').textContent`), 'Pray for a blessing');
  await assertClearance('touch-430-idle', 72);
  await shot('touch-430-idle');

  await screen(320, 568, true);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await advance(17, 4);
  await assertClearance('touch-320-idle', 56);
  await shot('touch-320-idle');

  await screen(390, 844, true);
  await evaluate(`window.dispatchEvent(new Event('resize')); testMatch.chargings[0] = false; testMatch.charges[0] = 0; void 0`);
  await advance(17, 4);

  // Hold [data-control="pray"] -> charging (~1.1 s) at 390x844 -> capture charging screenshot, then finish to ready!
  const prayPt = await evaluate(`(() => { const r = document.querySelector('[data-control="pray"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 2 }; })()`);
  await fingers('touchStart', prayPt);
  await advance(50, 22); // 1.1 s -> charging
  assert.equal(await evaluate(`document.querySelector('#prayer-0').dataset.state`), 'charging');
  assert.equal(await evaluate(`document.querySelector('#prayer-0 .prayer-caption').hidden`), true);
  await assertClearance('touch-390-charging', 72);
  await shot('touch-390-charging');
  await advance(50, 24); // +1.2 s -> ready
  await fingers('touchEnd');
  await advance(17, 2);
  const touchReady = await evaluate(`({
    state: document.querySelector('#prayer-0').dataset.state,
    choicesHidden: document.querySelector('#touch-prayer-choices').hidden,
    statusHidden: document.querySelector('#prayer-0 .prayer-status').hidden,
    jesusW: Math.round(document.querySelector('[data-prayer-choice="jesus"]').getBoundingClientRect().width),
    georgeW: Math.round(document.querySelector('[data-prayer-choice="george"]').getBoundingClientRect().width),
    maryW: Math.round(document.querySelector('[data-prayer-choice="mary"]').getBoundingClientRect().width),
    phanW: Math.round(document.querySelector('[data-prayer-choice="phanourios"]').getBoundingClientRect().width),
    offscreen: [...document.querySelectorAll('[data-prayer-choice], .touch-actions [data-control]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1;
    }).map((el) => el.dataset.prayerChoice ?? el.dataset.control),
  })`);
  assert.equal(touchReady.state, 'ready');
  assert.deepEqual(touchReady.offscreen, [], `every touch control stays on screen: ${JSON.stringify(touchReady.offscreen)}`);
  assert.equal(touchReady.choicesHidden, false, 'Touch Jesus, George & Mary buttons appear when prayer is full');
  assert.equal(touchReady.statusHidden, true, 'Touch ready prompt uses the buttons themselves, no extra text pill');
  assert.ok(touchReady.jesusW >= 64 && touchReady.georgeW >= 64 && touchReady.maryW >= 64 && touchReady.phanW >= 64, `Touch Jesus/George/Mary/Phanourios buttons properly sized: ${JSON.stringify(touchReady)}`);
  await assertClearance('touch-390-ready', 72);
  await shot('touch-390-ready');
  await shotEmblem('emblem-touch-choices', '#touch-prayer-choices');

  // Verify 430x932 portrait touch clearance with ready badge & choices visible.
  await screen(430, 932, true);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await advance(17, 6);
  await assertClearance('touch-430-ready', 72);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-prayer-choice], .touch-actions [data-control]')].filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }).map((el) => el.dataset.prayerChoice ?? el.dataset.control)`), [], 'touch-430-ready: every touch control stays on screen');
  await shot('touch-430-ready');
  // Also check 320x568 with enlarged touch choice buttons visible (must clear joystick & action buttons!).
  await screen(320, 568, true);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await advance(17, 4);
  await assertClearance('touch-320-ready', 56);
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-prayer-choice], .touch-actions [data-control]')].filter((el) => { const r = el.getBoundingClientRect(); return r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; }).map((el) => el.dataset.prayerChoice ?? el.dataset.control)`), [], 'touch-320-ready: every touch control stays on screen');
  await shot('touch-320-ready');
  await screen(390, 844, true);
  await evaluate(`window.dispatchEvent(new Event('resize'))`);
  await advance(17, 3);

  // Tap [data-prayer-choice="george"] -> St George active at 390x844 (capture touch-390-george during icon hold!).
  // Freeze the opponents for the check: a tackle on the new rider would knock the horse away (and end the prayer) mid-assert.
  await evaluate(`for (const p of testMatch.players) if (p.team === 1) p.stun = 3; void 0`);
  const georgeBtnPt = await evaluate(`(() => { const r = document.querySelector('[data-prayer-choice="george"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 3 }; })()`);
  await fingers('touchStart', georgeBtnPt);
  await fingers('touchEnd');
  await advance(50, 16); // ~0.8 s into St George apparition hold
  assert.equal(await evaluate(`document.querySelector('#prayer-0').dataset.state`), 'george');
  assert.equal(await evaluate(`document.querySelector('#touch-prayer-choices').hidden`), true);
  assert.ok(await evaluate(`testMatch.prayers[0].riderSlot >= 0`), 'Touch George mounted rider');
  await assertClearance('touch-390-george', 72);
  await shot('touch-390-george');

  // Re-ready -> tap [data-prayer-choice="phanourios"] -> St Phanourios active (one slot used).
  await evaluate(`(() => { const pr = testMatch.prayers[0]; pr.active = null; pr.timeLeft = 0; pr.riderSlot = -1; pr.ready = true; pr.charge = 1; pr.remaining = 2; })()`);
  await advance(17, 2);
  const phanBtnPt = await evaluate(`(() => { const r = document.querySelector('[data-prayer-choice="phanourios"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 5 }; })()`);
  await fingers('touchStart', phanBtnPt);
  await fingers('touchEnd');
  await advance(50, 16);
  const touchPhan = await evaluate(`({ state: document.querySelector('#prayer-0').dataset.state, remaining: testMatch.prayers[0].remaining, choicesHidden: document.querySelector('#touch-prayer-choices').hidden })`);
  assert.deepEqual(touchPhan, { state: 'phanourios', remaining: 1, choicesHidden: true }, `Touch Phanourios: ${JSON.stringify(touchPhan)}`);
  await assertClearance('touch-390-phanourios', 72);
  await shot('touch-390-phanourios');

  // Re-ready remaining 1 prayer -> tap [data-prayer-choice="mary"] -> Mary active at 390x844 & 320x568!
  await evaluate(`(() => { const pr = testMatch.prayers[0]; pr.active = null; pr.timeLeft = 0; pr.ready = true; pr.charge = 1; })()`);
  await advance(17, 2);
  const maryBtnPt = await evaluate(`(() => { const r = document.querySelector('[data-prayer-choice="mary"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 4 }; })()`);
  await fingers('touchStart', maryBtnPt);
  await fingers('touchEnd');
  await advance(50, 16); // ~0.8 s into Mary apparition resting hold
  const touchMary = await evaluate(`({
    state: document.querySelector('#prayer-0').dataset.state,
    choicesHidden: document.querySelector('#touch-prayer-choices').hidden,
    remaining: testMatch.prayers[0].remaining,
  })`);
  assert.equal(touchMary.state, 'mary');
  assert.equal(touchMary.choicesHidden, true);
  assert.equal(touchMary.remaining, 0);
  await assertClearance('touch-390-mary', 72);
  await shot('touch-390-mary');

  // Verify 320x568 touch portrait clearance with Mary active, shot meter visible, AND resting icon clearing #controlled-bar!
  await screen(320, 568, true);
  await evaluate(`window.dispatchEvent(new Event('resize')); testMatch.chargings[0] = true; testMatch.charges[0] = 0.65; void 0`);
  await advance(17, 4);
  await assertClearance('touch-320-mary', 56);
  const appClear320 = await evaluate(`(() => {
    const ctrl = document.querySelector('#controlled-bar').getBoundingClientRect();
    const stage = document.querySelector('#prayer-apparition-0 .apparition-stage').getBoundingClientRect();
    const app = document.querySelector('#prayer-apparition-0').getBoundingClientRect();
    const p0 = document.querySelector('#prayer-0').getBoundingClientRect();
    const p1 = document.querySelector('#prayer-1').getBoundingClientRect();
    return {
      ctrlBottom: Math.round(ctrl.bottom),
      stageTop: Math.round(stage.top),
      appLeft: Math.round(app.left),
      appRight: Math.round(app.right),
      p0Right: Math.round(p0.right),
      p1Left: Math.round(p1.left),
    };
  })()`);
  assert.ok(appClear320.stageTop >= appClear320.ctrlBottom - 1, `320px descending icon clears controlled priest label: ${JSON.stringify(appClear320)}`);
  assert.ok(appClear320.appLeft >= appClear320.p0Right - 2, `320px apparition clears #prayer-0: ${JSON.stringify(appClear320)}`);
  assert.ok(appClear320.appRight <= appClear320.p1Left + 2, `320px apparition clears #prayer-1: ${JSON.stringify(appClear320)}`);
  await shot('touch-320-mary');

  // Return to 390x844 and transition to spent state (remaining=0, active=null) -> desaturated emblem visible, caption hidden!
  await screen(390, 844, true);
  await evaluate(`(() => {
    window.dispatchEvent(new Event('resize'));
    testMatch.chargings[0] = false; testMatch.charges[0] = 0;
    for (const pr of testMatch.prayers) { pr.active = null; pr.timeLeft = 0; pr.ready = false; pr.remaining = 0; }
  })()`);
  await advance(50, 60); // advance past apparition fade-out too
  await evaluate(`document.querySelectorAll('.prayer-emblem').forEach((e) => { void getComputedStyle(e).opacity; e.getAnimations().forEach((a) => a.finish()); })`);
  const touchSpent = await evaluate(`(() => {
    const e0 = document.querySelector('#prayer-0 .prayer-emblem');
    return {
      state: document.querySelector('#prayer-0').dataset.state,
      display: getComputedStyle(e0).display,
      opacity: parseFloat(getComputedStyle(e0).opacity),
      filter: getComputedStyle(e0).filter,
      capHidden: document.querySelector('#prayer-0 .prayer-caption').hidden,
    };
  })()`);
  assert.equal(touchSpent.state, 'spent');
  assert.notEqual(touchSpent.display, 'none');
  assert.ok(touchSpent.opacity >= 0.45 && touchSpent.opacity <= 0.55);
  assert.ok(touchSpent.filter.includes('grayscale'));
  assert.equal(touchSpent.capHidden, true);
  await assertClearance('touch-390-spent', 72);
  await shot('touch-390-spent');
  await evaluate(`localStorage.removeItem('papifa.narration.v2')`);

  // ---------- 5. ?prayer=george URL test switch: kicks off directly on the white horse with remaining = 2 ----------
  await send('Debugger.disable');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await screen(1280, 800, false);
  const sep = url.includes('?') ? '&' : '?';
  await send('Page.navigate', { url: `${url}${sep}prayer=george` });
  await enterMatch(evaluate, send);
  await waitForKickoff();
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await advance(17, 10);
  const urlGeorge = await evaluate(`({
    active: testMatch.prayers[0].active,
    riderSlot: testMatch.prayers[0].riderSlot,
    remaining: testMatch.prayers[0].remaining,
    hudState: document.querySelector('#prayer-0').dataset.state,
  })`);
  assert.equal(urlGeorge.active, 'george', `?prayer=george mounts at kickoff: ${JSON.stringify(urlGeorge)}`);
  assert.ok(urlGeorge.riderSlot >= 0);
  assert.equal(urlGeorge.remaining, 2, '?prayer=george preserves both regular prayers');
  assert.equal(urlGeorge.hudState, 'george');
  await shot('desktop-george-url');

  console.log('All browser prayer checks (idle/charging/ready/jesus/george/phanourios/mary/spent, ?prayer=george, captions, keyboard, gamepad, touch, local 2P, replay, 320/390/430/1280px clearance) passed.');
}
