import assert from 'node:assert/strict';

function key(send, type, code) {
  const value = code === 'ShiftLeft' ? 'Shift' : code.slice(3).toLowerCase();
  return send('Input.dispatchKeyEvent', {type, code, key:value, windowsVirtualKeyCode:code === 'ShiftLeft' ? 16 : code.charCodeAt(3)});
}

// Start from the desktop rematch. Set up the two sides and ball, then let the
// running game's mouse handler, fixed steps, camera and renderer resolve each play.
export async function checkKeeperControls({ send, evaluate, advance, shot }) {
  const read = body => evaluate(`(() => {
    const m = flowMatch, b = m.ball, gk = m.players.find(p => p.team === 0 && p.isGK);
    const striker = m.players.find(p => p.team === 0 && p.slot === 4);
    const rival = m.players.find(p => p.team === 1 && p.slot === 4);
    ${body}
  })()`);
  const hint = () => evaluate("document.querySelector('#help .control-line[data-guide=keyboard] [data-hint]:not([hidden])')?.id");
  async function point(where) {
    return read(`const p = ${where};
      const ndc = flowCamera.position.clone().set(p.x, 0, p.z).project(flowCamera);
      const canvas = flowRenderer.domElement, r = canvas.getBoundingClientRect();
      const x = r.left + (ndc.x + 1) * r.width / 2, y = r.top + (1 - ndc.y) * r.height / 2;
      if (document.elementFromPoint(x, y) !== canvas) throw Error('Mouse target misses the pitch at ' + [x, y]);
      return {x, y};`);
  }
  async function click(button, where, heldFrames = 0) {
    const pos = await point(where);
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...pos});
    await send('Input.dispatchMouseEvent', {type:'mousePressed', button, buttons:button === 'left' ? 1 : 2, clickCount:1, ...pos});
    if (heldFrames) await advance(50, heldFrames);
    await send('Input.dispatchMouseEvent', {type:'mouseReleased', button, buttons:0, clickCount:1, ...await point(where)});
    await advance(17);
  }

  await read(`striker.pos = {x:gk.pos.x + 8, z:3};
    rival.pos = {x:gk.pos.x + 9, z:-4};
    m.players.find(p => p.team === 0 && p.slot === 1).pos = {x:striker.pos.x + 1, z:striker.pos.z + 2};
    for (const p of m.players) if (p !== striker) p.stun = 4;
    b.owner = rival; b.pos = {...rival.pos, y:.3};`);
  await advance(100, 16);
  await click('right', '({x:striker.pos.x - 2, z:striker.pos.z})');
  assert.ok(await read('return m.human === gk && b.owner === rival'), 'right-click pointing back picks the keeper in defence');
  assert.equal(await hint(), 'defend-hint');
  await click('right', 'striker.pos');
  assert.ok(await read('return m.human === striker'));
  await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...await point('({x:striker.pos.x + 1, z:striker.pos.z + 2})')});
  await key(send, 'keyDown', 'KeyA');
  await key(send, 'keyDown', 'KeyQ');
  await key(send, 'keyUp', 'KeyQ');
  await advance(17);
  await key(send, 'keyUp', 'KeyA');
  assert.ok(await read('return m.human === gk'), 'A + Q selects the keeper even when the cursor points elsewhere');
  await click('right', 'striker.pos');
  await evaluate(`window.controlPad = {axes:[-1,0], buttons:Array.from({length:16}, () => ({pressed:false}))};
    Object.defineProperty(navigator, 'getGamepads', {value:() => [controlPad], configurable:true}); void 0`);
  async function padSwitch(x) {
    await evaluate(`controlPad.axes[0] = ${x}; controlPad.buttons[4].pressed = true`); await advance(17);
    await evaluate('controlPad.buttons[4].pressed = false'); await advance(17);
  }
  await padSwitch(-1);
  assert.ok(await read('return m.human === striker'), 'an unclaimed pad cannot change the mouse player’s priest');
  await padSwitch(1);
  await evaluate('delete navigator.getGamepads');
  assert.ok(await read('return m.human === striker'), 'control is with the outfielder before the save');
  await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...await point('rival.pos')});

  await read(`gk.stun = 0;
    window.beforeSaveRandom = m.rand; m.rand = () => .15;
    b.owner = null; b.receiver = null; b.noPickup.clear(); b.shot = {team:1, rolled:false};
    b.pos = {x:gk.pos.x + 1.3, y:1.1, z:gk.pos.z + .3}; b.vel = {x:-14, y:0, z:0};`);
  await advance(17);
  assert.ok(await read(`m.rand = beforeSaveRandom;
    return m.stats[0].saves === 1 && gk.moveKind === 'catch' && b.owner === gk && m.human === gk
      && document.querySelector('#controlled').textContent === gk.info.name;`), 'a caught shot gives the player control of the keeper');
  assert.equal(await hint(), 'keeper-hint');
  await advance(50, 5);
  assert.ok(await read(`const ring = flowScene.children.find(o => o.geometry?.parameters?.innerRadius === .78);
    const marker = flowScene.children.find(o => o.geometry?.type === 'ConeGeometry');
    const color = getComputedStyle(document.querySelector('#match-shell')).getPropertyValue('--team-0').trim().toLowerCase();
    return [ring, marker].every(o => o.visible && o.position.x === gk.pos.x && o.position.z === gk.pos.z
      && '#' + o.material.color.getHexString() === color)
      && !document.querySelector('#player-edge').classList.contains('visible');`), 'ring and overhead marker follow the keeper in his kit colour');
  await shot('keeper-catch');

  await click('left', '({x:gk.pos.x + 8, z:gk.pos.z + 4})', 8);
  const punt = await read(`return {lofted:gk.moveKind === 'lofted' && b.passer === gk && !b.owner,
    lift:b.vel.y, angle:Math.atan2(b.vel.z, b.vel.x)};`);
  assert.ok(punt.lofted && punt.lift > 0, 'the keeper releases a rising punt');
  assert.ok(Math.abs(punt.angle - Math.atan2(4, 8)) < .04, 'punt travels toward the cursor');
  await advance(50, 3);
  await shot('keeper-punt');

  // The broadcast camera follows play upfield while the selected keeper stays inside his own goal area.
  await read(`rival.pos = {x:m.pitch.length / 2 - 2, z:5}; rival.stun = 3;
    b.owner = rival; b.pos = {...rival.pos, y:.3}; b.vel = {x:0, y:0, z:0};`);
  await advance(100, 15);
  assert.ok(await read(`const edge = document.querySelector('#player-edge'), r = edge.getBoundingClientRect();
    return m.human === gk && edge.classList.contains('visible') && r.left >= 0 && r.right < innerWidth / 2
      && edge.textContent === gk.info.name.split(' ').at(-1)[0];`), 'off-screen keeper is identified on the left edge');
  await shot('keeper-edge');

  for (const [distance, heldFrames, action] of [[25, 0, 'knock'], [23, 0, 'shot'], [25, 8, 'shot']]) {
    await evaluate("(async () => { const {kickoff} = await import('./src/sim.js'); kickoff(flowMatch, 0); })()");
    await read(`striker.pos = {x:m.pitch.length / 2 - ${distance}, z:0}; striker.knockCd = 0;
      b.pos = {...striker.pos, y:.3};
      rival.pos.z = -8;
      for (const p of m.players) if (p !== striker) p.stun = 3;`);
    await advance(100, 9);
    const aim = '({x:striker.pos.x + 6, z:striker.pos.z + 2})';
    await send('Input.dispatchMouseEvent', {type:'mouseMoved', ...await point(aim)});
    await advance(17);
    assert.equal(await hint(), 'aim-hint');
    const before = await read('return m.stats[0].shots');
    await click('left', aim, heldFrames);
    assert.equal(await read('return striker.moveKind'), action, `${distance} m, ${heldFrames ? 'hold' : 'tap'}`);
    assert.equal(await read('return m.stats[0].shots'), before + (action === 'shot' ? 1 : 0));
    if (action === 'knock') assert.ok(await read('return !b.owner && b.receiver === striker && striker.burstT > 0 && b.vel.z > 0'));
  }
  console.log('Keeper selected, caught and punted at', (punt.angle * 180 / Math.PI).toFixed(1),
    'degrees. Directional mouse and Q, device isolation, markers, 25 m knock-on, 23 m quick shot and held 25 m shot passed.');
}

export async function checkStamina({ send, evaluate, advance, shot, mobile }) {
  await evaluate(`(async () => {
    const {kickoff} = await import('./src/sim.js');
    kickoff(flowMatch, 0);
    flowMatch.human.stamina = 1;
    for (const p of flowMatch.players) if (p !== flowMatch.human) p.stun = 20;
  })()`);
  const stick = await evaluate(`(() => {
    const r = document.querySelector('#touch-stick').getBoundingClientRect();
    return {x:r.left + r.width / 2, y:r.top + r.height / 2, radius:r.width * .4};
  })()`);
  let previous = null;
  async function steer(direction) {
    if (mobile) {
      const type = direction === 0 ? 'touchEnd' : previous ? 'touchMove' : 'touchStart';
      const touchPoints = direction ? [{id:1, x:stick.x + direction * stick.radius, y:stick.y}] : [];
      await send('Input.dispatchTouchEvent', {type, touchPoints});
    } else {
      if (previous) await key(send, 'keyUp', previous);
      if (direction) await key(send, 'keyDown', direction < 0 ? 'KeyA' : 'KeyD');
    }
    previous = direction < 0 ? 'KeyA' : direction > 0 ? 'KeyD' : null;
  }
  async function meter(level) {
    const state = await evaluate(`(() => {
      const pitch = document.querySelector('#player-stamina'), touch = document.querySelector('#touch-stamina');
      const value = Math.ceil(flowMatch.human.stamina * 100);
      return {value, pitch:pitch.style.getPropertyValue('--stamina-fill'), touch:Number(touch.getAttribute('aria-valuenow')),
        levels:[pitch.dataset.stamina, touch.dataset.stamina], pitchVisible:pitch.getBoundingClientRect().width >= 30,
        touchVisible:touch.getBoundingClientRect().width > 0};
    })()`);
    assert.equal(state.pitch, state.value + '%'); assert.equal(state.touch, state.value);
    assert.deepEqual(state.levels, [level, level], 'at ' + state.value + '%');
    assert.equal(state.pitchVisible, true, 'visible pitch stamina at ' + state.value + '%');
    assert.equal(state.touchVisible, mobile, 'touch HUD visibility');
    return state.value;
  }
  await advance(100, 4);
  assert.equal(await meter('fresh'), 100);
  if (!mobile) await key(send, 'keyDown', 'ShiftLeft');
  await steer(-1); await advance(100, 32);
  await steer(1);
  await evaluate('for (let i=0; i<58 && flowMatch.human.stamina > .30; i++) advanceFlow(100)');
  const tired = await meter('low');
  assert.ok(tired > 0 && tired < 35);
  await shot(mobile ? 'phone-stamina-low' : 'desktop-stamina-low');
  await steer(-1);
  await evaluate('for (let i=0; i<55 && flowMatch.human.stamina > 0; i++) advanceFlow(100)');
  assert.equal(await meter('empty'), 0);
  await shot(mobile ? 'phone-stamina-empty' : 'desktop-stamina-empty');
  await steer(0);
  if (!mobile) await key(send, 'keyUp', 'ShiftLeft');
  await advance(100, 42);
  assert.equal(await meter('fresh'), 100);
  console.log(mobile ? 'Touch stick' : 'Shift + WASD', 'drained stamina from 100% through', tired, 'to 0%; resting refilled it to 100%.');
}
