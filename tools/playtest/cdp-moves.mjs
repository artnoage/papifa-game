import assert from 'node:assert/strict';

export async function observeGameCall(send, module, name, condition) {
  const { result } = await send('Runtime.evaluate', { expression: `import('./src/${module}.js').then(m => m.${name})`, awaitPromise: true });
  await send('Debugger.setBreakpointOnFunctionCall', { objectId: result.result.objectId, condition });
}

export async function checkAdvancedTouch({ send, evaluate, advance, fingers, point, targets, shot }) {
  // Inspect the real fixed-step inputs and emitted events without changing the game modules.
  await send('Debugger.enable');
  await evaluate('window.testInputs = []; window.testActions = []');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, testInputs.push({...(Array.isArray(input) ? input[0] : input)}), false)');
  await observeGameCall(send, 'audio', 'playEvents', '(testActions.push(...events.filter(e => e.human)), false)');
  await advance();
  async function kickoff() {
    await evaluate(`(async () => {
      const { kickoff } = await import('./src/sim.js');
      kickoff(testMatch, 0);
      const runner = testMatch.players.find(p => p.team === 0 && p.slot === (testMatch.size === 3 ? 1 : 2));
      runner.pos = { x: 7, z: -3 };
      testActions.length = testInputs.length = 0;
    })()`);
  }
  async function gesture(control, dx = 0, dy = 0, holdFrames = 0) {
    const start = point(targets[control], 1);
    await fingers('touchStart', start);
    if (holdFrames) await advance(1000 / 60, holdFrames);
    if (dx || dy) await fingers('touchMove', point(targets[control], 1, dx, dy));
    await fingers('touchEnd');
    await advance(1000 / 60);
  }
  const kinds = () => evaluate('testActions.map(e => e.kind || e.type)');
  const signal = () => evaluate("document.querySelector('#move-signal:not([hidden]) span')?.textContent");

  const guide = await evaluate(`(() => {
    const box = document.querySelector('#move-help summary').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await fingers('touchStart', point(guide, 1));
  await fingers('touchEnd');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('#move-help[open] .finger-move')]
    .filter(el => el.getClientRects().length).map(el => el.textContent)`), [
    'Swipe up on Pass', 'Hold Shoot, swipe up and release', 'Swipe right on Pass',
    'Tap Shoot far from goal to knock it ahead, or double-tap the stick centre', 'Hold Switch', 'Hold Pray (2 s), then tap Jesus, George, or Mary',
  ]);
  await shot('touch-moves');
  await fingers('touchStart', point(guide, 1));
  await fingers('touchEnd');
  assert.ok(await evaluate("!document.querySelector('#move-help').open"));

  await kickoff();
  await fingers('touchStart', point(targets.pass, 1));
  await fingers('touchMove', point(targets.pass, 1, 0, -40));
  await fingers('touchCancel');
  await advance();
  assert.deepEqual(await kinds(), [], 'a cancelled swipe must keep possession');
  assert.ok(await evaluate('testMatch.ball.owner === testMatch.human'));
  await gesture('pass', 0, -42, 4);
  assert.deepEqual(await kinds(), ['through']);
  assert.equal(await signal(), 'Through ball');
  await shot('touch-through');
  await kickoff();
  await gesture('pass', 39, 0);
  assert.deepEqual(await kinds(), ['onetwo']);
  await kickoff();
  await gesture('shoot', 0, -45, 18);
  assert.deepEqual(await kinds(), ['chip']);
  assert.equal(await signal(), 'Chip shot');
  await shot('touch-chip');

  await advance(100, 12);
  await kickoff();
  await evaluate('for (const p of testMatch.players) if (p.team === 0 && p !== testMatch.human) p.pos.x = -22;');
  await gesture('pass', 0, -42);
  const fallback = await kinds();
  assert.equal(fallback.length, 1, 'a through ball without an available runner falls back to a pass');
  assert.notEqual(fallback[0], 'through');
  assert.equal(await signal(), undefined, 'the HUD follows the pass that actually fired');

  await kickoff();
  await gesture('move', 30, 0);
  await gesture('move', 30, 0);
  assert.deepEqual(await kinds(), [], 'steering gestures must not knock the ball on');
  await gesture('move');
  await advance(100);
  await gesture('move');
  assert.deepEqual(await kinds(), ['knock']);
  await kickoff();
  await evaluate('testMatch.ball.owner = testMatch.players.find(p => p.team === 1 && !p.isGK); void 0');
  const defender = await evaluate('testMatch.human.info.id');
  await gesture('switch', 0, 0, 25);
  assert.equal(await evaluate('testInputs.filter(i => i.pressPressed).length'), 1);
  assert.ok(await evaluate('testMatch.pressT[0] > testMatch.t && !testInputs.some(i => i.switchPressed)'));
  assert.equal(await evaluate('testMatch.human.info.id'), defender);

  // Score with enough recorded history to exercise the touch replay and full-time prompts.
  await kickoff();
  await advance(100, 22);
  await evaluate(`Object.assign(testMatch.ball, { owner: null, receiver: null, shot: null, inNet: false,
    pos: {x:testMatch.pitch.length/2+.25,y:0.5,z:0}, vel: {x:10,y:0,z:0} }); void 0`);
  await advance();
  assert.equal(await evaluate('testMatch.phase'), 'goal');
  for (let i = 0; i < 26 && await evaluate("document.querySelector('#replay').hidden"); i++) await advance(100);
  const passLabel = () => evaluate('document.querySelector(\'[data-control="pass"]\').textContent');
  assert.equal(await passLabel(), 'Skip');
  await gesture('pass');
  assert.ok(await evaluate("document.querySelector('#replay').hidden"));
  await kickoff();
  await evaluate('testMatch.clock = 0.001');
  await advance();
  assert.ok(await evaluate("!document.querySelector('#results-card').hidden"));
  const rematch = await evaluate(`(() => {
    const b = document.querySelector('#rematch-button').getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`);
  await fingers('touchStart', point(rematch, 1));
  await fingers('touchEnd');
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) {
    await fingers('touchStart', point(rematch, 1));
    await fingers('touchEnd');
  }
  await advance();
  assert.ok(await evaluate('testMatch.clock > 179 && testMatch.ball.owner === testMatch.human'));
  assert.deepEqual(await kinds(), [], 'restarting must not pass at kick-off');
  await send('Debugger.disable');
}
