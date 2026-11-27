import assert from 'node:assert/strict';
import { observeGameCall } from './cdp-moves.mjs';

async function waitFor(evaluate, expression, tries = 250) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error('Timed out waiting for ' + expression);
}

async function activate(send, evaluate, selector, mobile = false) {
  const target = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw Error('Missing element: ' + ${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!el.contains(document.elementFromPoint(x, y))) throw Error('Control is covered: ' + el.outerHTML.slice(0, 120));
    return { x, y };
  })()`);
  if (mobile) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...target, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, ...target, button: 'left', clickCount: 1 });
    }
  }
}

async function installVirtualPads(send) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__virtualPads = [];
      window.__makePad = (index) => ({
        index,
        id: 'Virtual Controller ' + (index + 1),
        connected: true,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
      });
      Object.defineProperty(navigator, 'getGamepads', {
        value: () => window.__virtualPads,
        configurable: true,
      });
    `,
  });
}

async function hookMatchLoop(send, evaluate) {
  await evaluate(`(() => {
    let now = performance.now(), callback;
    Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
    window.requestAnimationFrame = fn => { callback = fn; return 1; };
    window.advanceFlow = (ms = 0, n = 1) => {
      if (!callback) return false;
      for (let i = 0; i < n; i++) { now += ms; callback(now); }
      return true;
    };
  })()`);
}

async function attachSceneAndSim(send, evaluate, expectedActors) {
  await evaluate(`(async () => {
    const { Scene } = await import('three');
    const orig = Scene.prototype.onBeforeRender;
    Scene.prototype.onBeforeRender = function (...args) {
      window.flowScene = this;
      window.flowRenderer = args[0];
      window.flowCamera = args[2];
      return orig.apply(this, args);
    };
    try { advanceFlow(17, 1); } finally { Scene.prototype.onBeforeRender = orig; }
    window.roster = () => flowScene.children.filter(o => o.getObjectByProperty('isSkinnedMesh', true));
  })()`);
  await waitFor(evaluate, `window.roster && roster().length === ${expectedActors}`, 300);
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.flowMatch = m, false)');
  await evaluate('advanceFlow(17, 2)');
  await waitFor(evaluate, '!!window.flowMatch');
}

export async function checkLocal2P({ url, send, evaluate, shot }) {
  await installVirtualPads(send);

  // ---------- 1. Phone (touch-only): NO Local 2P offered, Touch claims P1 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Page.navigate', { url });
  await waitFor(evaluate, "document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  await activate(send, evaluate, '#new-game', true);
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'players'");
  assert.equal(await evaluate("document.querySelector('#local-mode-option').hidden"), true, 'Phone must NOT offer Local 2P');
  assert.equal(await evaluate("document.querySelector('#claim-continue').disabled"), true);
  await activate(send, evaluate, '#claim-slot-0', true);
  await waitFor(evaluate, "document.querySelector('#claim-continue').disabled === false");
  assert.equal(await evaluate("document.querySelector('#claim-slot-0 [data-slot-device]').textContent"), 'Touch');
  assert.equal(await evaluate("document.querySelector('#controls-page').dataset.guide"), 'touch');
  await shot('01-phone-claim');
  console.log('1/3 Phone touch-only claim verified (Local 2P hidden).');

  // ---------- 2. Desktop Local 2P: Two gamepads (pad 0 + pad 1) ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, mobile: false, deviceScaleFactor: 1 });
  await send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  const twoPadUrl = new URL(url);
  twoPadUrl.searchParams.set('size', '3');
  await send('Page.navigate', { url: twoPadUrl.href });
  await waitFor(evaluate, "document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  await evaluate('window.__virtualPads = [__makePad(0), __makePad(1)]; void 0');
  await activate(send, evaluate, '#new-game');
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'players'");
  assert.equal(await evaluate("document.querySelector('#local-mode-option').hidden"), false, 'Desktop must offer Local 2P');
  await activate(send, evaluate, '#local-mode-option');
  await waitFor(evaluate, "document.querySelector('#players-page').dataset.mode === 'local'");
  assert.equal(await evaluate("document.querySelector('#claim-slot-1').hidden"), false);

  // Pad 0 presses A -> claims Player 1
  await evaluate('__virtualPads[0].buttons[0].pressed = true; void 0');
  await waitFor(evaluate, "document.querySelector('#claim-slot-0').dataset.state === 'claimed'");
  await evaluate('__virtualPads[0].buttons[0].pressed = false; void 0');
  assert.equal(await evaluate("document.querySelector('#claim-slot-0 [data-slot-device]').textContent"), 'Controller 1');
  assert.equal(await evaluate("document.querySelector('#controls-page').dataset.guide"), 'gamepad');
  assert.equal(await evaluate("document.querySelector('#claim-continue').disabled"), true);

  // Duplicate press on Pad 0 must not claim Player 2
  await new Promise((r) => setTimeout(r, 80));
  await evaluate('__virtualPads[0].buttons[0].pressed = true; void 0');
  await waitFor(evaluate, "document.querySelector('#claim-notice').textContent.includes('already Player 1')");
  await evaluate('__virtualPads[0].buttons[0].pressed = false; void 0');
  await shot('02-claim-waiting-p2');

  // Pad 1 presses Start -> claims Player 2
  await new Promise((r) => setTimeout(r, 80));
  await evaluate('__virtualPads[1].buttons[9].pressed = true; void 0');
  await waitFor(evaluate, "document.querySelector('#claim-slot-1').dataset.state === 'claimed'");
  await evaluate('__virtualPads[1].buttons[9].pressed = false; void 0');
  assert.equal(await evaluate("document.querySelector('#claim-slot-1 [data-slot-device]').textContent"), 'Controller 2');
  assert.equal(await evaluate("document.querySelector('#claim-continue').disabled"), false);
  await shot('03-claim-two-pads');

  // Fresh A on Pad 0 advances to teams page
  await new Promise((r) => setTimeout(r, 80));
  await evaluate('__virtualPads[0].buttons[0].pressed = true; void 0');
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'teams'");
  await evaluate('__virtualPads[0].buttons[0].pressed = false; void 0');
  assert.equal(await evaluate("document.querySelector('#selected-kit').textContent"), 'P1 Gold Cross vs P2 Blue Dome');
  await shot('04-teams-2p');

  await hookMatchLoop(send, evaluate);
  await activate(send, evaluate, '#kick-off');
  await waitFor(evaluate, "!document.querySelector('#match-shell').hidden && advanceFlow(0)");
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) await activate(send, evaluate, '#skip-intro');
  await evaluate('advanceFlow(17, 4)');
  await attachSceneAndSim(send, evaluate, 7);

  // Verify 2 humans, 2 rings, 2 markers, 2 stamina bars, 2 controlled names
  const initCheck = await evaluate(`(() => {
    const m = flowMatch;
    const r0 = flowScene.getObjectByName('Human ring 0'), r1 = flowScene.getObjectByName('Human ring 1');
    const m0 = flowScene.getObjectByName('Human marker 0'), m1 = flowScene.getObjectByName('Human marker 1');
    return {
      humanTeams: m.humanTeams,
      bothHumans: Boolean(m.humans[0] && m.humans[1]),
      ringsVisible: r0.visible && r1.visible,
      ringColors: [r0.material.color.getHex(), r1.material.color.getHex()],
      markersVisible: m0.visible && m1.visible,
      ctrl0: document.querySelector('#controlled').textContent,
      ctrl1: document.querySelector('#controlled-1').textContent,
      ctrl1Hidden: document.querySelector('#controlled-1').hidden,
      stam0Visible: !document.querySelector('#player-stamina').hidden,
      stam1Visible: !document.querySelector('#player-stamina-1').hidden,
      helpLines: document.querySelectorAll('#help .control-line').length,
    };
  })()`);
  assert.deepEqual(initCheck.humanTeams, [true, true]);
  assert.equal(initCheck.bothHumans, true);
  assert.equal(initCheck.ringsVisible, true);
  assert.deepEqual(initCheck.ringColors, [0xffc83d, 0x3d9bff]);
  assert.equal(initCheck.markersVisible, true);
  assert.ok(initCheck.ctrl0.startsWith('P1 · '));
  assert.ok(initCheck.ctrl1.startsWith('P2 · '));
  assert.equal(initCheck.ctrl1Hidden, false);
  assert.equal(initCheck.stam0Visible, true);
  assert.equal(initCheck.stam1Visible, true);
  assert.equal(initCheck.helpLines, 2);

  // Drive both pads simultaneously in opposite directions + sprint, check independent motion, stamina drain & camera pull-back
  const before = await evaluate(`(() => ({
    p0: { x: flowMatch.humans[0].pos.x, z: flowMatch.humans[0].pos.z, s: flowMatch.humans[0].stamina },
    p1: { x: flowMatch.humans[1].pos.x, z: flowMatch.humans[1].pos.z, s: flowMatch.humans[1].stamina },
    camY: flowCamera.position.y,
  }))()`);
  await evaluate(`
    __virtualPads[0].axes[0] = -1; __virtualPads[0].axes[1] = -0.35; __virtualPads[0].buttons[7].pressed = true;
    __virtualPads[1].axes[0] = 1;  __virtualPads[1].axes[1] = 0.35;  __virtualPads[1].buttons[7].pressed = true;
    advanceFlow(34, 40);
  `);
  const after = await evaluate(`(() => ({
    p0: { x: flowMatch.humans[0].pos.x, z: flowMatch.humans[0].pos.z, s: flowMatch.humans[0].stamina },
    p1: { x: flowMatch.humans[1].pos.x, z: flowMatch.humans[1].pos.z, s: flowMatch.humans[1].stamina },
    camY: flowCamera.position.y,
    inFrame: [flowMatch.ball.pos, flowMatch.humans[0].pos, flowMatch.humans[1].pos].map(p => {
      const v = flowCamera.position.clone().set(p.x, p.y ?? 0, p.z).project(flowCamera);
      return { x: v.x, y: v.y };
    }),
  }))()`);
  assert.ok(after.p0.x < before.p0.x - 4, 'Pad 0 moved P1 left');
  assert.ok(after.p1.x > before.p1.x + 4, 'Pad 1 moved P2 right');
  assert.ok(after.p0.s < before.p0.s - 0.1 && after.p1.s < before.p1.s - 0.1, 'Both humans drained stamina');
  assert.ok(after.camY > before.camY + 0.5, 'Camera pulled back to keep ball + both humans framed');
  for (const [idx, pt] of after.inFrame.entries()) {
    assert.ok(Math.abs(pt.x) < 1.0 && Math.abs(pt.y) < 1.0, `Framed point ${idx} stays on screen: ${JSON.stringify(pt)}`);
  }
  await shot('05-two-pads-match');

  // Stop pads, give ball to P2, charge shot with Pad 1 B -> #power-1 visible, #power hidden
  await evaluate(`
    __virtualPads[0].axes = [0, 0, 0, 0]; __virtualPads[0].buttons[7].pressed = false;
    __virtualPads[1].axes = [0, 0, 0, 0]; __virtualPads[1].buttons[7].pressed = false;
    const h1 = flowMatch.humans[1];
    h1.pos = { x: 4, z: 0 };
    flowMatch.ball.owner = h1; flowMatch.ball.pos = { x: 4, y: 0.3, z: 0 };
    __virtualPads[1].buttons[1].pressed = true;
    advanceFlow(34, 15);
  `);
  const p2Charge = await evaluate(`({
    p0Vis: getComputedStyle(document.querySelector('#power')).visibility,
    p1Vis: getComputedStyle(document.querySelector('#power-1')).visibility,
    p1W: parseFloat(document.querySelector('#powerfill-1').style.width),
  })`);
  assert.equal(p2Charge.p0Vis, 'hidden');
  assert.equal(p2Charge.p1Vis, 'visible');
  assert.ok(p2Charge.p1W > 20, 'P2 power bar fills while Pad 1 holds B');
  await shot('06-p2-charging');
  await evaluate('__virtualPads[1].buttons[1].pressed = false; advanceFlow(34, 2);');

  // Force both controlled priests to opposite touchlines off-screen -> both edge arrows visible in their team colours
  await evaluate(`
    flowMatch.ball.owner = null; flowMatch.ball.pos = { x: 0, y: 0.3, z: 0 }; flowMatch.ball.vel = { x: 0, y: 0, z: 0 };
    flowMatch.humans[0].pos = { x: -flowMatch.pitch.length, z: 0 };
    flowMatch.humans[1].pos = { x: flowMatch.pitch.length, z: 0 };
    advanceFlow(0, 1);
  `);
  const edges = await evaluate(`(() => {
    const e0 = document.querySelector('#player-edge'), e1 = document.querySelector('#player-edge-1');
    return {
      v0: e0.classList.contains('visible'),
      v1: e1.classList.contains('visible'),
      left0: e0.getBoundingClientRect().left,
      left1: e1.getBoundingClientRect().left,
      bg0: getComputedStyle(e0).backgroundColor,
      bg1: getComputedStyle(e1).backgroundColor,
    };
  })()`);
  assert.equal(edges.v0, true, 'Team 0 edge marker visible off-screen left');
  assert.equal(edges.v1, true, 'Team 1 edge marker visible off-screen right');
  assert.ok(edges.left0 < 200 && edges.left1 > 1000, 'Edge markers sit on opposite edges');
  assert.notEqual(edges.bg0, edges.bg1, 'Edge markers use distinct team colours');
  await shot('07-both-offscreen-edges');
  await send('Debugger.disable');
  console.log('2/3 Local 2P two-gamepad flow, rings, markers, stamina, camera pull-back, P2 charge & dual edge arrows verified.');

  // ---------- 3. Desktop Local 2P: Keyboard+mouse (P1, Blue Dome) + Gamepad (P2, Gold Cross) ----------
  await send('Page.navigate', { url: twoPadUrl.href });
  await waitFor(evaluate, "document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  await evaluate('window.__virtualPads = [__makePad(0)]; void 0');
  await activate(send, evaluate, '#new-game');
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'players'");
  await activate(send, evaluate, '#local-mode-option');
  await waitFor(evaluate, "document.querySelector('#players-page').dataset.mode === 'local'");

  // Claim P1 with Space (even while Local 2P radio still has focus!)
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await waitFor(evaluate, "document.querySelector('#claim-slot-0').dataset.state === 'claimed'");
  assert.equal(await evaluate("document.querySelector('#claim-slot-0 [data-slot-device]').textContent"), 'Keyboard & mouse');
  assert.equal(await evaluate("document.querySelector('#claim-slot-1 [data-slot-prompt]').textContent"), 'Press A or Start on a controller.');

  // Claim P2 with Pad 0 A
  await new Promise((r) => setTimeout(r, 80));
  await evaluate('__virtualPads[0].buttons[0].pressed = true; void 0');
  await waitFor(evaluate, "document.querySelector('#claim-slot-1').dataset.state === 'claimed'");
  await evaluate('__virtualPads[0].buttons[0].pressed = false; void 0');
  await shot('08-claim-kb-pad');

  await activate(send, evaluate, '#claim-continue');
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'teams'");
  // Swap P1 kit to Blue Dome
  await activate(send, evaluate, '.team-choice.blue');
  assert.equal(await evaluate("document.querySelector('#selected-kit').textContent"), 'P1 Blue Dome vs P2 Gold Cross');

  await hookMatchLoop(send, evaluate);
  await activate(send, evaluate, '#kick-off');
  await waitFor(evaluate, "!document.querySelector('#match-shell').hidden && advanceFlow(0)");
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) await activate(send, evaluate, '#skip-intro');
  await evaluate('advanceFlow(17, 4)');
  await attachSceneAndSim(send, evaluate, 7);

  // Verify kit-swapped ring colours & mixed-device Moves selector
  const mixedInit = await evaluate(`({
    ring0: flowScene.getObjectByName('Human ring 0').material.color.getHex(),
    ring1: flowScene.getObjectByName('Human ring 1').material.color.getHex(),
    guideOwnerHidden: document.querySelector('#guide-owner').hidden,
    helpGuides: [...document.querySelectorAll('#help .control-line')].map(el => el.dataset.guide),
  })`);
  assert.deepEqual([mixedInit.ring0, mixedInit.ring1], [0x3d9bff, 0xffc83d], 'Swapped kit colours applied to both 3D rings');
  assert.equal(mixedInit.guideOwnerHidden, false, 'Mixed kb+pad shows owner selector in Moves');
  assert.deepEqual(mixedInit.helpGuides, ['keyboard', 'gamepad']);

  // Drive P1 with KeyD and P2 with Pad 0 left simultaneously
  const mBefore = await evaluate(`({ p0x: flowMatch.humans[0].pos.x, p1x: flowMatch.humans[1].pos.x })`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
  await evaluate('__virtualPads[0].axes[0] = -1; advanceFlow(34, 24);');
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
  await evaluate('__virtualPads[0].axes[0] = 0;');
  const mAfter = await evaluate(`({ p0x: flowMatch.humans[0].pos.x, p1x: flowMatch.humans[1].pos.x })`);
  assert.ok(mAfter.p0x > mBefore.p0x + 2, 'Keyboard KeyD drove P1 right');
  assert.ok(mAfter.p1x < mBefore.p1x - 2, 'Pad 0 left drove P2 left');

  // Visually show mixed kb+pad play with real mouse aim + real held left-click shot charge on P1
  await evaluate(`
    const h0 = flowMatch.humans[0], h1 = flowMatch.humans[1];
    h0.pos = { x: -4, z: -2 }; h1.pos = { x: 6, z: 3 };
    flowMatch.ball.owner = h0; flowMatch.ball.pos = { x: -4, y: 0.3, z: -2 };
    for (const p of flowMatch.players) if (p !== h0 && p !== h1) p.stun = 3;
  `);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 760, y: 460 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 760, y: 460, button: 'left', buttons: 1, clickCount: 1 });
  await evaluate('advanceFlow(34, 15);');
  const p1Power = await evaluate(`({
    p0Vis: getComputedStyle(document.querySelector('#power')).visibility,
    p1Vis: getComputedStyle(document.querySelector('#power-1')).visibility,
    p0W: parseFloat(document.querySelector('#powerfill').style.width),
  })`);
  assert.equal(p1Power.p0Vis, 'visible');
  assert.equal(p1Power.p1Vis, 'hidden');
  assert.ok(p1Power.p0W > 20, 'P1 power bar fills while left mouse button is held');
  await shot('09-kb-pad-match-p1-charging');
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 760, y: 460, button: 'left', buttons: 0, clickCount: 1 });
  await evaluate('advanceFlow(34, 2);');
  await send('Debugger.disable');
  console.log('3/3 Local 2P keyboard+mouse + gamepad flow, kit-swapped rings, mixed controls & P1 mouse charge verified.');
}
