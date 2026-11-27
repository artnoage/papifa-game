import assert from 'node:assert/strict';
import { createDeviceClaim, canClaimInMode, deviceKey, deviceLabel, isTouchOnlyDevice } from '../src/device-claim.js';

function makePad(index, pressed = []) {
  const buttons = Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) }));
  return { index, buttons, axes: [0, 0, 0, 0] };
}

// 1. Touch-only device detection
assert.equal(isTouchOnlyDevice({
  navigator: { maxTouchPoints: 5 },
  matchMedia: q => ({ matches: q === '(pointer: coarse)' }),
}), true, 'phone with coarse pointer and no fine pointer is touch-only');

assert.equal(isTouchOnlyDevice({
  navigator: { maxTouchPoints: 5 },
  matchMedia: q => ({ matches: q === '(pointer: coarse)' || q === '(any-pointer: fine)' }),
}), false, 'hybrid touch laptop with mouse/trackpad is not touch-only');

assert.equal(isTouchOnlyDevice({
  navigator: { maxTouchPoints: 0 },
  matchMedia: q => ({ matches: q === '(any-pointer: fine)' }),
}), false, 'desktop is not touch-only');

// 2. Touch-only device cannot switch to Local 2P
{
  const claim = createDeviceClaim({ touchOnly: true, getGamepads: () => [] });
  claim.setMode('local');
  assert.equal(claim.state().mode, 'ai', 'touch-only forces vs AI');
  assert.equal(claim.claim({ type: 'touch' }).claimed, true);
  assert.equal(claim.ready(), true);
  assert.deepEqual(claim.devices(), [{ type: 'touch' }, null]);
}

// 3. vs AI mode accepts keyboard, gamepad, or touch; calls onClaim; ignores duplicate
{
  const claimed = [];
  const claim = createDeviceClaim({
    touchOnly: false,
    getGamepads: () => [],
    onClaim: (dev, slot) => claimed.push({ dev, slot }),
  });
  assert.equal(claim.ready(), false);
  const r1 = claim.claim({ type: 'keyboard' });
  assert.equal(r1.claimed, true);
  assert.equal(claim.ready(), true);
  assert.deepEqual(claim.devices(), [{ type: 'keyboard' }, null]);
  assert.deepEqual(claimed, [{ dev: { type: 'keyboard' }, slot: 0 }]);

  // Upgrading to Local 2P keeps P1 keyboard and waits for P2 gamepad
  claim.setMode('local');
  assert.equal(claim.ready(), false);
  assert.deepEqual(claim.devices(), [{ type: 'keyboard' }, null]);

  // Duplicate keyboard rejected in Local 2P
  const dup = claim.claim({ type: 'keyboard' });
  assert.equal(dup.claimed, false);
  assert.equal(dup.reason, 'duplicate');
  assert.ok(claim.state().notice.includes('already Player 1'));

  // Touch rejected in Local 2P
  assert.equal(canClaimInMode('local', { type: 'touch' }), false);
  const badTouch = claim.claim({ type: 'touch' });
  assert.equal(badTouch.claimed, false);
  assert.equal(badTouch.reason, 'unsupported');

  // Pad 0 fills Player 2
  const r2 = claim.claim({ type: 'gamepad', index: 0 });
  assert.equal(r2.claimed, true);
  assert.equal(r2.slot, 1);
  assert.equal(claim.ready(), true);
  assert.deepEqual(claim.devices(), [{ type: 'keyboard' }, { type: 'gamepad', index: 0 }]);

  // Swap P1/P2 swaps team order cleanly
  claim.swapSlots();
  assert.deepEqual(claim.devices(), [{ type: 'gamepad', index: 0 }, { type: 'keyboard' }]);

  // Clear slot 0 and re-claim with Pad 1
  claim.clearSlot(0);
  assert.equal(claim.ready(), false);
  claim.claim({ type: 'gamepad', index: 1 });
  assert.equal(claim.ready(), true);
  assert.deepEqual(claim.devices(), [{ type: 'gamepad', index: 1 }, { type: 'keyboard' }]);
}

// 4. Two gamepads via polling: held button on activate is debounced, fresh A/Start claims, second press continues, disconnect clears slot
{
  let pads = [makePad(0, [0]), makePad(1, [])]; // Pad 0 holding A on entry
  let continued = 0;
  const claim = createDeviceClaim({
    touchOnly: false,
    getGamepads: () => pads,
    onContinue: () => { continued++; },
  });
  claim.setMode('local');
  claim.activate();
  claim.pollGamepads();
  assert.deepEqual(claim.devices(), [null, null], 'held A on activate must not claim');

  // Release and press A on Pad 0 -> claims P1
  pads = [makePad(0, []), makePad(1, [])];
  claim.pollGamepads();
  pads = [makePad(0, [0]), makePad(1, [])];
  claim.pollGamepads();
  assert.deepEqual(claim.devices(), [{ type: 'gamepad', index: 0 }, null]);

  // Press Start (button 9) on Pad 1 -> claims P2
  pads = [makePad(0, []), makePad(1, [9])];
  claim.pollGamepads();
  assert.deepEqual(claim.devices(), [{ type: 'gamepad', index: 0 }, { type: 'gamepad', index: 1 }]);
  assert.equal(claim.ready(), true);
  assert.equal(continued, 0);

  // Fresh A on Pad 0 when both slots ready triggers continue
  pads = [makePad(0, [0]), makePad(1, [])];
  claim.pollGamepads();
  assert.equal(continued, 1);

  // Disconnecting Pad 1 releases slot 1 with a notice
  pads = [makePad(0, []), null];
  claim.pollGamepads();
  assert.equal(claim.ready(), false);
  assert.deepEqual(claim.devices(), [{ type: 'gamepad', index: 0 }, null]);
  assert.ok(claim.state().notice.includes('Controller 2 disconnected'));
  claim.deactivate();
}

assert.equal(deviceKey({ type: 'gamepad', index: 1 }), 'gamepad:1');
assert.equal(deviceLabel({ type: 'keyboard' }), 'Keyboard & mouse');
assert.equal(deviceLabel({ type: 'gamepad', index: 0 }), 'Controller 1');
assert.equal(deviceLabel({ type: 'touch' }), 'Touch');

console.log('device-claim tests passed.');
