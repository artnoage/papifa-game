import assert from 'node:assert/strict';
import { observeGameCall } from './cdp-moves.mjs';
import { reloadPage } from './cdp-front.mjs';

export async function checkMatchSettings({ url, send, evaluate, load, advance, fingers, shot, screen }) {
  const launch = new URL(url);
  launch.searchParams.set('level', 'HARD');
  launch.searchParams.set('match', 'friendly');
  launch.hash = 'pitch';
  await load(launch.href);
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await advance();
  const state = () => evaluate(`({
    level: testMatch.level, noise: testMatch.ai[1].noise, clock: testMatch.clock, score: testMatch.score.slice(),
    selected: document.querySelector('#difficulty :checked').value, paused: document.querySelector('#pause-menu').open
  })`);
  async function tap(selector) {
    const p = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, id: 1 }; })()`);
    await fingers('touchStart', p);
    await fingers('touchEnd');
  }
  async function key(code, key, windowsVirtualKeyCode) {
    for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode });
    await advance();
  }
  const noise = await evaluate("import('./src/config.js').then(m => Object.fromEntries(Object.entries(m.AI_LEVELS).map(([k,v]) => [k,v.noise])))");
  assert.equal((await state()).noise, noise.hard);
  await evaluate('testMatch.score = [2, 1]; testMatch.clock = 93; void 0');
  await tap('#pause-button');
  await advance(100, 5);
  await tap('#difficulty label:has([value=veryEasy])');
  assert.deepEqual(await state(), { level: 'veryEasy', noise: noise.veryEasy, clock: 93, score: [2, 1], selected: 'veryEasy', paused: true });
  const address = new URL(await evaluate('location.href'));
  assert.equal(address.searchParams.get('level'), 'veryEasy');
  assert.equal(address.searchParams.get('match'), 'friendly');
  assert.equal(address.hash, '#pitch');
  assert.equal(await evaluate("localStorage.getItem('papifa.level.v1')"), 'veryEasy');
  await shot('touch-difficulty');
  await tap('#resume-button');
  await advance();
  assert.ok(!(await state()).paused && (await state()).clock < 93);

  await key('KeyP', 'p', 80);
  assert.ok(!(await state()).paused, 'an unclaimed keyboard cannot pause a touch match');
  async function startWith(claimDevice, level) {
    await send('Debugger.disable');
    if (level === null) launch.searchParams.delete('level');
    else launch.searchParams.set('level', level);
    await load(launch.href, claimDevice);
    await send('Debugger.enable');
    await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
    await advance();
  }
  await startWith(() => key('Space', ' ', 32), 'veryhard');
  assert.equal((await state()).level, 'veryHard', 'lowercase ?level=veryhard resolves to veryHard');
  await startWith(() => key('Space', ' ', 32), 'veryeasy');
  assert.equal((await state()).level, 'veryEasy', 'lowercase ?level=veryeasy resolves to veryEasy');
  await key('KeyP', 'p', 80);
  assert.ok((await state()).paused);
  await evaluate("document.querySelector('#difficulty :checked').focus()");
  await key('ArrowRight', 'ArrowRight', 39);
  assert.equal((await state()).selected, 'easy');
  await key('ArrowRight', 'ArrowRight', 39);
  assert.equal((await state()).selected, 'normal');
  await key('Escape', 'Escape', 27);
  assert.ok(!(await state()).paused, 'Escape closes the modal once');

  await startWith(async () => {
    await evaluate(`window.testPad = { index: 0, connected: true, axes: [0,0], buttons: Array.from({length:16}, () => ({pressed:false})) };
      Object.defineProperty(navigator, 'getGamepads', {value: () => [testPad], configurable:true}); void 0`);
    await padTap(0);
  }, 'normal');
  async function padTap(i) {
    await evaluate(`testPad.buttons[${i}].pressed = true`); await advance();
    await evaluate(`testPad.buttons[${i}].pressed = false`); await advance();
  }
  await padTap(9);
  await padTap(15);
  assert.equal((await state()).selected, 'hard');
  await padTap(15);
  assert.equal((await state()).selected, 'veryHard');
  await padTap(15);
  assert.equal((await state()).selected, 'veryEasy', 'D-pad right wraps from veryHard to veryEasy');
  await padTap(14);
  assert.equal((await state()).selected, 'veryHard', 'D-pad left wraps back to veryHard');
  await padTap(14);
  assert.equal((await state()).selected, 'hard', 'D-pad left steps back to hard');
  await padTap(0);
  assert.ok(!(await state()).paused && await evaluate('testMatch.ball.owner === testMatch.human'));
  await evaluate('testMatch.clock = 0.001');
  await advance();
  await padTap(0);
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) await padTap(0);
  await advance();
  assert.ok((await state()).clock > 179 && (await state()).level === 'hard');
  assert.equal((await state()).noise, noise.hard);
  await evaluate(`(() => {
    const m = testMatch, keeper = m.players.find(p => p.team === 0 && p.isGK);
    m.human.pos = { x: keeper.pos.x + 6, z: keeper.pos.z };
    for (const p of m.players) if (p !== keeper && p !== m.human) { p.pos.x = 12; p.stun = 1; }
    m.ball.owner = m.players.find(p => p.team === 1 && p.slot === 4);
    testPad.axes[0] = -1;
  })()`);
  await padTap(4);
  assert.ok(await evaluate('testMatch.human.isGK'), 'the claimed pad can select the keeper with left stick and LB');
  await startWith(undefined, 'hard');
  await send('Debugger.disable');
  // Simulate a complete match and let the usual display frame process the final whistle.
  await evaluate(`(async () => {
    const {step} = await import('./src/sim.js');
    for (let i = 0; i < 18000 && (testMatch.phase === 'goal' || testMatch.clock > 1/60 + 0.001); i++)
      step(testMatch, null, 1/60);
  })()`);
  await screen(320, 568, true);
  await advance(34);
  const table = () => evaluate(`[...document.querySelectorAll('#results-card tbody tr')]
    .map(row => [...row.cells].map(cell => cell.textContent))`);
  const rows = await table();
  const stats = await evaluate('testMatch.stats');
  const score = (await state()).score;
  const home = Math.round(100 * stats[0].possession / (stats[0].possession + stats[1].possession));
  assert.deepEqual(rows, [
    [String(score[0]), 'Goals', String(score[1])],
    [`${stats[0].shots} (${stats[0].onTarget})`, 'Shots (on target)', `${stats[1].shots} (${stats[1].onTarget})`],
    [home + '%', 'Possession', (100-home) + '%'],
    [`${stats[0].completed} / ${stats[0].passes}`, 'Passes completed / attempted', `${stats[1].completed} / ${stats[1].passes}`],
    [String(stats[0].through), 'Through balls', String(stats[1].through)],
    [String(stats[0].tackles), 'Tackles won', String(stats[1].tackles)],
    [String(stats[0].saves), 'Saves', String(stats[1].saves)],
  ]);
  for (const team of stats) {
    assert.ok(team.passes >= team.completed && team.completed > 0);
    assert.ok(team.shots >= team.onTarget && team.shots > 0);
  }
  async function visibleButtons() {
    return evaluate(`[...document.querySelectorAll('#results-card button')].every(el => {
      const r = el.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
      return r.height >= 44 && r.top >= 0 && r.bottom <= innerHeight && el.contains(document.elementFromPoint(x,y));
    })`);
  }
  assert.ok(await visibleButtons());
  await shot('full-time-portrait');
  await screen(844, 390, true);
  await advance(0);
  assert.ok(await visibleButtons());
  await shot('full-time-landscape');
  await tap('#change-level');
  assert.equal(await evaluate("document.querySelector('#pause-title').textContent"), 'Match difficulty');
  await tap('#difficulty label:has([value=veryEasy])');
  await tap('#resume-button');
  assert.deepEqual(await table(), rows, 'changing level preserves the finished match');
  await send('Debugger.enable');
  await observeGameCall(send, 'sim', 'step', '(window.testMatch = m, false)');
  await tap('#rematch-button');
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) await tap('#skip-intro');
  await advance();
  assert.ok(await evaluate("document.querySelector('#results-card').hidden && testMatch.clock > 179 && testMatch.level === 'veryEasy'"));
  assert.deepEqual((await state()).score, [0, 0]);
  assert.ok(await evaluate('testMatch.stats.every(s => !s.shots && !s.passes && !s.saves)'));
  await send('Debugger.disable');
  // Clean URL without ?level= restores saved preference ('veryEasy'); invalid explicit ?level= falls back to 'normal'.
  launch.searchParams.delete('level');
  await load(launch.href);
  assert.equal(await evaluate("document.querySelector('#difficulty :checked').value"), 'veryEasy');
  launch.searchParams.set('level', 'constructor');
  await load(launch.href);
  assert.equal(await evaluate("document.querySelector('#difficulty :checked').value"), 'normal');

  // Give each offline audio render a fresh module and input listeners under the release CSP.
  async function rms(type, mute = false) {
    await reloadPage(send, evaluate);
    return evaluate(`(async () => {
      const { initAudio, playEvents, setSoundEnabled } = await import('./src/audio.js');
      const context = new OfflineAudioContext(1, 22050, 44100);
      window.AudioContext = function () { return context; };
      setSoundEnabled(true);
      initAudio();
      window.dispatchEvent(new Event('pointerdown'));
      if (${mute}) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM' }));
      playEvents([{ type: ${JSON.stringify(type)} }]);
      const wave = (await context.startRendering()).getChannelData(0);
      return Math.sqrt(wave.reduce((sum, x) => sum + x*x, 0) / wave.length);
    })()`);
  }
  const levels = { knock: await rms('knock'), pass: await rms('pass'), mute: await rms('knock', true) };
  assert.ok(levels.knock > 0 && levels.knock < levels.pass * 0.5, JSON.stringify(levels));
  assert.equal(levels.mute, 0);
  console.log('Difficulty via URL, touch, keyboard and gamepad passed. Knock/pass audio RMS ratio', (levels.knock / levels.pass).toFixed(2));
}
