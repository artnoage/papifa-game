import assert from 'node:assert/strict';
import { checkAdvancedTouch } from './cdp-moves.mjs';
import { checkMatchSettings } from './cdp-settings.mjs';
import { enterMatch, reloadPage } from './cdp-front.mjs';

export async function runTouchPlaytest({ url, send, evaluate, shot }) {
  // Drive display frames explicitly so even a tap between two simulation ticks is repeatable.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    let frame, now = performance.now();
    Object.defineProperty(performance, 'now', { value: () => now });
    window.requestAnimationFrame = (fn) => { frame = fn; return 1; };
    window.advanceTouchTest = (ms, count = 1) => {
      if (!frame) return false;
      for (let i = 0; i < count; i++) { now += ms; frame(now); }
      return true;
    };
  })()` });

  const advance = (ms = 17, count = 1) => evaluate(`advanceTouchTest(${ms}, ${count})`);
  const fingers = (type, ...touchPoints) => send('Input.dispatchTouchEvent', { type, touchPoints });
  const screen = (width, height, mobile) => send('Emulation.setDeviceMetricsOverride', {
    width, height, mobile, deviceScaleFactor: 1, screenWidth: width, screenHeight: height,
  });
  async function load(location = url, claimDevice) {
    const { result } = await send('Page.navigate', { url: location });
    if (!result.loaderId) await reloadPage(send, evaluate);
    await enterMatch(evaluate, send, claimDevice);
    for (let i = 0; i < 150; i++) {
      if (await evaluate('window.advanceTouchTest?.(0) && !!document.querySelector("#controlled")?.textContent')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The game did not reach kick-off');
  }
  async function waitForRoster() {
    await evaluate(`(async () => {
      const { Scene, AnimationAction } = await import('three');
      let scene;
      const original = Scene.prototype.onBeforeRender;
      Scene.prototype.onBeforeRender = function (...args) { scene = this; return original.apply(this, args); };
      try { advanceTouchTest(0); } finally { Scene.prototype.onBeforeRender = original; }
      window.touchTestPlayer = scene.children.find(obj => obj.name === 'nikolai');
      const actorCount = 2 * Number(document.querySelector('#match-size :checked').value) + 1;
      window.touchTestRosterReady = () => scene.children.filter(obj => obj.getObjectByProperty('isSkinnedMesh', true)).length === actorCount;
      window.touchTestClips = [];
      const play = AnimationAction.prototype.play;
      AnimationAction.prototype.play = function () {
        if (touchTestPlayer.getObjectById(this.getMixer().getRoot().id)) touchTestClips.push(this.getClip().name);
        return play.call(this);
      };
    })()`);
    for (let i = 0; i < 300; i++) {
      if (await evaluate('touchTestRosterReady()')) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('The skinned lineup did not load');
  }
  const hud = () => evaluate(`({
    player: document.querySelector('#controlled').textContent,
    pass: document.querySelector('[data-control="pass"]').textContent,
    charging: document.querySelector('#power').style.visibility === 'visible',
    power: parseFloat(document.querySelector('#powerfill').style.width),
    held: [...document.querySelectorAll('#touch-controls .held')].map(el => el.dataset.control).sort(),
    stick: document.querySelector('.stick-thumb').style.transform,
  })`);
  async function positions() {
    const targets = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-control]')].map(el => {
      const b = el.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
      return [el.dataset.control, {x, y, w: b.width, h: b.height, visible: b.left >= 0 && b.top >= 0 &&
        b.right <= innerWidth && b.bottom <= innerHeight && el.contains(document.elementFromPoint(x, y))}];
    }))`);
    for (const [name, b] of Object.entries(targets)) {
      assert.ok(b.visible && b.w >= 44 && b.h >= 44, `${name} is hard to reach: ${JSON.stringify(b)}`);
    }
    return targets;
  }
  const point = (b, id, dx = 0, dy = 0) => ({ id, x: b.x + dx, y: b.y + dy });

  // A narrow desktop window still uses the keyboard HUD.
  await screen(390, 844, false);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await load();
  assert.ok(await evaluate(`document.querySelector('#touch-controls').hidden && getComputedStyle(document.querySelector('#help')).display !== 'none'`));

  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await screen(390, 844, true);
  await load();
  await waitForRoster();
  assert.ok(await evaluate(`!document.querySelector('#touch-controls').hidden && getComputedStyle(document.querySelector('#help')).display === 'none'`));
  let b = await positions();
  const centre = point(b.move, 1), forward = point(b.move, 1, b.move.w * .55, -12), shoot = point(b.shoot, 2);
  await fingers('touchStart', centre);
  await fingers('touchMove', forward);
  await fingers('touchStart', forward, shoot);
  await advance(17, 18);
  let state = await hud();
  assert.deepEqual(state.held, ['move', 'shoot']);
  assert.ok(state.charging && state.power > 20 && state.stick, 'steering while charging');
  const before = await evaluate('touchTestPlayer.position.toArray()');
  await advance(1000 / 60);
  const after = await evaluate('touchTestPlayer.position.toArray()');
  assert.ok(after[0] > before[0] && after[2] < before[2], 'diagonal stick direction reaches the pitch');
  assert.ok(Math.hypot(after[0] - before[0], after[2] - before[2]) * 60 > 7, 'the rim engages sprint');
  await shot('touch-portrait');
  // The second finger drags outside Shoot and lifts. The stick stays captured.
  const outside = point(b.shoot, 2, -75, -85);
  await fingers('touchMove', forward, outside);
  await fingers('touchEnd', outside);
  await advance();
  state = await hud();
  assert.deepEqual(state.held, ['move']);
  assert.ok(!state.charging && state.pass === 'Tackle', 'release must take the shot');
  await fingers('touchStart', forward, point(b.pass, 3));
  await fingers('touchEnd', point(b.pass, 3));
  await advance();
  assert.ok(await evaluate("touchTestClips.includes('tackle')"), 'Pass becomes a tackle off the ball');
  await fingers('touchStart', forward, point(b.switch, 4));
  await fingers('touchEnd', point(b.switch, 4));
  await advance();
  assert.notEqual((await hud()).player, state.player, 'switch while steering');
  await fingers('touchEnd');
  await advance();
  assert.equal((await hud()).stick, '');

  await screen(844, 390, true);
  await load();
  await waitForRoster();
  b = await positions();
  const left = point(b.move, 1, -18), trigger = point(b.shoot, 2);
  await fingers('touchStart', left);
  await fingers('touchStart', left, trigger);
  await advance();
  await fingers('touchEnd', left);
  await advance(17, 6);
  assert.deepEqual((await hud()).held, ['shoot'], 'lifting the stick leaves Shoot held');
  await shot('touch-landscape');
  await fingers('touchCancel');
  await advance();
  state = await hud();
  assert.ok(!state.charging && state.pass === 'Pass' && !state.held.length, 'cancel must keep possession');
  await fingers('touchStart', trigger);
  await advance();
  await evaluate("window.dispatchEvent(new Event('blur'))");
  await fingers('touchEnd');
  await advance();
  assert.equal((await hud()).pass, 'Pass', 'returning from the background must not kick');

  const passer = (await hud()).player;
  await fingers('touchStart', point(b.pass, 1));
  await fingers('touchEnd');
  await advance(5);
  await advance(12);
  assert.notEqual((await hud()).player, passer, 'a quick pass survives the next physics tick');
  await screen(320, 568, true);
  await load();
  b = await positions();
  await fingers('touchStart', point(b.shoot, 1));
  await fingers('touchEnd');
  await advance(5);
  await advance(12);
  assert.equal((await hud()).pass, 'Tackle', 'a quick shot takes a low-power kick');
  await screen(390, 844, true);
  await load();
  await waitForRoster();
  await checkAdvancedTouch({ send, evaluate, advance, fingers, point, targets: await positions(), shot });
  await checkMatchSettings({ url, send, evaluate, load, advance, fingers, shot, screen });
  console.log('Touch CDP passed at 390×844, 844×390 and 320×568, plus a narrow non-touch desktop.');
}
