// Gamepad tutorial E2E: "made for a gamepad" notes on the title, Controls and Who's playing? pages; the
// Gamepad tutorial page waits for A on a (virtual) controller, then every step plays its demo and is
// completed by real pad input (one step skipped with View), Start opens the pause menu with Quit tutorial,
// and A on "Tutorial complete" returns to the menu. Screenshots at 1280x800 and 844x390.
import assert from 'node:assert/strict';

export async function runTutorialPlaytest({ url, out, send, evaluate, shot }) {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      let frame, now = performance.now();
      Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
      const queue = [];
      window.requestAnimationFrame = (fn) => { queue.push(fn); return queue.length; };
      window.cancelAnimationFrame = () => {};
      window.advanceTut = (ms = 17, count = 1) => {
        for (let i = 0; i < count; i++) { now += ms; const run = queue.splice(0); for (const fn of run) fn(now); }
        return true;
      };
      window.__virtualPads = [];
      Object.defineProperty(navigator, 'getGamepads', { value: () => window.__virtualPads, configurable: true });
      window.__plugPad = () => { window.__virtualPads[0] = { index: 0, id: 'Virtual Pad', connected: true, axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) }; };
      window.__btn = (i, on) => { const pad = window.__virtualPads[0]; if (!pad) return; const b = pad.buttons[i]; b.pressed = on; b.value = on ? 1 : 0; };
      window.__axes = (a) => { if (window.__virtualPads[0]) window.__virtualPads[0].axes = a; };
    })()`,
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const advance = (ms = 17, count = 1) => evaluate(`advanceTut(${ms}, ${count})`);
  const screen = (width, height) => send('Emulation.setDeviceMetricsOverride', { width, height, mobile: false, deviceScaleFactor: 1, screenWidth: width, screenHeight: height });
  async function until(expr, label, limit = 400) {
    for (let i = 0; i < limit; i++) {
      await advance(34, 2);
      if (await evaluate(expr)) return;
      if (i % 10 === 9) await sleep(30);
    }
    throw new Error('Timed out waiting for ' + label);
  }
  const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el || el.closest('[hidden]')) return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`;
  const btn = (i, on) => evaluate(`__btn(${i}, ${on})`);
  const axes = (a) => evaluate(`__axes(${JSON.stringify(a)})`);
  const hold = (ms) => advance(34, Math.max(1, Math.round(ms / 34)));   // two sim ticks per rendered frame
  async function tapBtn(i, ms = 100) { await btn(i, true); await hold(ms); await btn(i, false); await hold(68); }

  await screen(1280, 800);
  await send('Page.navigate', { url });
  await until("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'", 'title page');

  // 1. Gamepad advice on the title page, the Controls page and (stronger with a keyboard) on Who's playing?.
  assert.ok(await evaluate(visible('.title-actions + .pad-advice')), 'title page shows the gamepad note');
  assert.ok(await evaluate(visible('#menu-tutorial')), 'title menu lists Gamepad tutorial');
  await shot('tutorial-01-title');
  await evaluate("document.querySelector('#title-page [data-page=controls]').click()");
  await until(visible('#controls-page .pad-advice'), 'controls note');
  await evaluate("document.querySelector('#menu-back').click()");
  await evaluate("document.querySelector('#new-game').click()");
  await until("document.querySelector('#front').dataset.page === 'players'", 'players page');
  assert.ok(await evaluate(visible('#claim-pad-advice')), 'claim page shows the gamepad note');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 });
  await until("document.querySelector('#claim-pad-advice').classList.contains('strong')", 'stronger note after keyboard claim');
  await shot('tutorial-02-claim-keyboard');
  for (const size of [[390, 844], [844, 390]]) {
    await screen(...size); await advance(17, 2);
    const clipped = await evaluate(`(() => { const r = document.querySelector('#claim-pad-advice').getBoundingClientRect(); return r.left < 0 || r.right > innerWidth + 1; })()`);
    assert.equal(clipped, false, `claim note fits at ${size.join('x')}`);
  }
  await screen(1280, 800);
  await evaluate("document.querySelector('#menu-back').click()");
  await until("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'", 'back to title');

  // 2. Tutorial page: waits for A on a controller (a held A doesn't count), then loads the courtyard.
  await evaluate("document.querySelector('#menu-tutorial').click()");
  await until("document.querySelector('#front').dataset.page === 'tutorial'", 'tutorial page');
  await shot('tutorial-03-start-page');
  await evaluate('__plugPad()');
  await advance(17, 3);
  await btn(0, true); await advance(17, 3); await btn(0, false); await advance(17, 2);
  await until("!!document.querySelector('#tutorial-panel')", 'tutorial panel', 600);
  await until(`document.querySelector('#tutorial-panel').dataset.phase === 'watch'`, 'first demo');
  assert.equal(await evaluate("document.querySelector('#match-shell').classList.contains('tutorial')"), true);
  assert.equal(await evaluate(visible('#clock')), false, 'clock hidden in the tutorial');

  const panel = () => evaluate(`(() => { const p = document.querySelector('#tutorial-panel'); return { phase: p.dataset.phase, count: p.querySelector('.tut-count').textContent, title: p.querySelector('.tut-title').textContent, targets: [...p.querySelectorAll('[data-pad].target')].map(e => e.dataset.pad), on: [...p.querySelectorAll('[data-pad].on')].map(e => e.dataset.pad) }; })()`);

  // What a player does on his turn, per step.
  const DO = {
    move: async () => { await axes([1, 0, 0, 0]); await hold(1600); await axes([0, 0, 0, 0]); },
    pass: async () => { await axes([0.8, 0.6, 0, 0]); await hold(250); await tapBtn(0); await axes([0, 0, 0, 0]); },
    through: async () => { await axes([0.9, 0.4, 0, 0]); await hold(250); await tapBtn(3); await axes([0, 0, 0, 0]); },
    shoot: async () => { await axes([1, -0.15, 0, 0]); await btn(1, true); await hold(600); await btn(1, false); await hold(100); await axes([0, 0, 0, 0]); },
    chip: async () => { await axes([1, 0, 0, 0]); await btn(4, true); await btn(1, true); await hold(500); await btn(1, false); await hold(60); await btn(4, false); await axes([0, 0, 0, 0]); },
    onetwo: async () => { await axes([1, 0.15, 0, 0]); await btn(4, true); await tapBtn(0); await btn(4, false); await btn(7, true); await hold(800); await btn(7, false); await axes([0, 0, 0, 0]); },
    knock: async () => { await axes([1, 0, 0, 0]); await tapBtn(1, 50); await hold(300); await axes([0, 0, 0, 0]); },
    tackle: async () => { await axes([1, 0, 0, 0]); await hold(500); await tapBtn(0); await axes([0, 0, 0, 0]); },
    switch: async () => { await tapBtn(4); },
    press: async () => { await btn(5, true); await hold(800); await btn(5, false); },
    autopilot: async () => { await btn(6, true); await hold(250); await axes([0.35, 0.94, 0, 0]); await hold(500); await tapBtn(0); await btn(6, false); await axes([0, 0, 0, 0]); },
    pray: async () => { await axes([0, 0, -1, 0]); await hold(2600); await axes([0, 0, 0, 0]); },
  };
  const ids = ['move', 'sprint', 'pass', 'through', 'shoot', 'chip', 'onetwo', 'knock', 'tackle', 'switch', 'press', 'autopilot', 'pray', 'pause'];
  for (const [i, id] of ids.entries()) {
    await until(`document.querySelector('#tutorial-panel .tut-count').textContent === '${i + 1} / ${ids.length}'`, `step ${id}`);
    if (id === 'sprint') {                             // View skips a step, even during its demo
      await advance(17, 20);
      const p = await panel();
      assert.equal(p.phase, 'watch');
      assert.ok(p.targets.includes('RT') && p.on.includes('RT'), `sprint demo shows RT pressed: ${JSON.stringify(p)}`);
      await tapBtn(8);
      continue;
    }
    if (id === 'pass') { await advance(17, 50); await shot('tutorial-04-pass-demo'); }
    await until(`document.querySelector('#tutorial-panel').dataset.phase === 'try'`, `${id} your turn`);
    if (id === 'autopilot') {
      await screen(844, 390); await advance(17, 12); await sleep(300); await advance(17, 4);
      const fits = await evaluate(`(() => { const r = document.querySelector('#tutorial-panel').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`);
      assert.ok(fits, 'tutorial panel fits at 844x390');
      await shot('tutorial-05-autopilot-844x390');
      await screen(1280, 800); await advance(17, 4);
    }
    if (id === 'pause') {
      await tapBtn(9);
      await until("document.querySelector('#pause-menu').open", 'pause menu');
      assert.ok(await evaluate(visible('#quit-tutorial')), 'pause menu offers Quit tutorial');
      assert.match(await evaluate("document.querySelector('#pad-pause-hint').textContent"), /View to quit/);
      await shot('tutorial-06-pause');
      await tapBtn(0);
      await until("!document.querySelector('#pause-menu').open", 'resume');
    } else {
      if (id === 'shoot') {                            // on his turn the diagram mirrors the real pad (X does nothing with the ball)
        await btn(2, true); await hold(100);
        const p = await panel();
        assert.ok(p.on.includes('X') && p.targets.includes('B') && !p.on.includes('B'), `real pad mirrored: ${JSON.stringify(p)}`);
        await btn(2, false); await hold(50);
        assert.equal((await panel()).phase, 'try', 'X with the ball does not complete the shoot step');
      }
      await DO[id]();
    }
    await until(`['done', 'complete'].includes(document.querySelector('#tutorial-panel').dataset.phase) || document.querySelector('#tutorial-panel .tut-count').textContent !== '${i + 1} / ${ids.length}'`, `${id} completed by the player`, 250);
    if (id === 'pray') await shot('tutorial-07-pray-done');
  }
  await until(`document.querySelector('#tutorial-panel').dataset.phase === 'complete'`, 'tutorial complete');
  await shot('tutorial-08-complete');
  const prevOrigin = await evaluate('performance.timeOrigin');
  await btn(0, true);
  await advance(17, 3).catch(() => {});                // A reloads the page back to the menu
  for (let i = 0; i < 100 && await evaluate(`performance.timeOrigin === ${prevOrigin}`).catch(() => false); i++) await sleep(100);
  await until("document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'", 'back to the menu after the tutorial');
  console.log('Gamepad tutorial E2E passed: notes on 3 pages, 13 steps completed by pad input, 1 skipped with View, pause menu quit option, back to menu.');
}
