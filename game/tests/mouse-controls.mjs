import assert from 'node:assert/strict';
import { createInput } from '../src/input.js';

const windowEvents = new EventTarget(), canvas = new EventTarget();
const human = { pos: { x: 0, z: 0 } }, teammate = { pos: { x: 5, z: 0 } }, match = { human, ball: { owner: human } };
const pad = { axes: [0, 0, 0, 0], buttons: [{ pressed: false }] };
let now = 100, live = true, padActive = false, reticle = false, cameraX = 0;
globalThis.addEventListener = windowEvents.addEventListener.bind(windowEvents);
Object.defineProperty(performance, 'now', { value: () => now, configurable: true });
Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => padActive ? [pad] : [] }, configurable: true });
const controls = createInput({ type: 'keyboard' }, { pitchTarget: {
  canvas,
  at(x, y) { reticle = true; return { x: x + cameraX, z: y }; },
  hide() { reticle = false; },
}, liveMatch: () => live ? match : null });
function pointer(type, button = -1, extra = {}) {
  const event = Object.assign(new Event(type, { cancelable: true }), {
    pointerType: 'mouse', clientX: 14, clientY: -5, button, ...extra,
  });
  canvas.dispatchEvent(event);
  return event;
}
function key(code, type = 'keydown') {
  windowEvents.dispatchEvent(Object.assign(new Event(type), { code }));
}
const { poll, clearActions: clear } = controls;

assert.equal(poll().aim, null);
key('KeyA');
pointer('pointermove');
let input = poll();
assert.deepEqual(input.aim, { x: 14, z: -5 });
assert.deepEqual(input.move, { x: -1, z: 0 });
cameraX = 3;
assert.equal(poll().aim.x, 17, 'a stationary pointer follows the broadcast camera');
key('KeyA', 'keyup');
pointer('pointerdown', 0);
pointer('pointerup', 0);
input = poll(); poll();
assert.ok(input.shootPressed && input.shootReleased && !input.shootHeld, 'a tap between physics ticks survives');
clear();
pointer('pointerdown', 0);
assert.ok(poll().shootHeld);
clear();
now += 500;
assert.ok(poll().shootHeld && !input.shootPressed);
pointer('pointerup', 0);
assert.ok(poll().shootReleased && !input.shootHeld);
clear();
pointer('pointerdown', 2, { shiftKey: true });
assert.ok(poll().throughPressed && input.passPressed && !input.switchPressed);
clear();

// Task E: Space fires passPressed immediately on press with or without mouse (no hold delay, no prayer, no chip overload).
key('Space');
assert.ok(poll().passPressed && !input.chipReleased && !input.prayerHeld, 'Space passes immediately on press while mouse-aiming');
key('Space', 'keyup'); clear();

// Task E: R holds prayer immediately; C chips with the ball; F always shoots even while mouse-aiming; E through; Q one-two.
key('KeyR');
assert.ok(poll().prayerHeld && !input.passPressed, 'R holds prayer immediately while mouse-aiming');
key('KeyR', 'keyup'); clear();

key('KeyC');
assert.ok(poll().shootPressed && input.shootHeld);
key('KeyC', 'keyup');
assert.ok(poll().chipReleased && !input.shootReleased, 'C chips while attacking with mouse');
clear();

key('KeyF');
assert.ok(poll().shootPressed && input.shootHeld && !input.knockOnPressed, 'F always shoots even while mouse-aiming');
key('KeyF', 'keyup');
assert.ok(poll().shootReleased && !input.chipReleased);
clear();

key('KeyE');
assert.ok(poll().throughPressed && !input.oneTwoPressed, 'E plays through ball');
key('KeyE', 'keyup'); clear();

key('KeyQ');
assert.ok(poll().oneTwoPressed && !input.switchPressed, 'Q plays one-two with the ball');
now += 350;
assert.ok(!poll().pressPressed, 'holding Q after attacking one-two does not call press');
key('KeyQ', 'keyup');
assert.ok(!poll().switchPressed);
clear();

now += 4000;
assert.equal(poll().aim, null);
assert.equal(reticle, false);
assert.ok(!input.shootReleased && !input.passPressed);

// Defending with mouse active:
pointer('pointermove');
match.ball.owner = teammate;
pointer('pointerdown', 0); pointer('pointerup', 0);
assert.ok(poll().passPressed && !input.shootPressed && !input.shootReleased);
clear();
pointer('pointerdown', 2); assert.ok(poll().switchPressed && input.switchToAim && !input.passPressed);
clear();
pointer('pointerdown', 2, { shiftKey: true }); assert.ok(!poll().throughPressed && !input.switchPressed);
key('KeyQ'); key('KeyQ', 'keyup');
assert.ok(poll().switchPressed && !input.switchToAim); clear();
key('KeyQ'); now += 350;
assert.ok(poll().pressPressed && !input.switchPressed);
clear(); key('KeyQ', 'keyup'); assert.ok(!poll().switchPressed);
key('Space');
assert.ok(poll().passPressed && !input.pressPressed, 'Space tackles immediately on press while defending with mouse');
key('Space', 'keyup'); clear();
key('KeyC'); key('KeyC', 'keyup');
assert.ok(!poll().chipReleased, 'C while defending does not emit chipReleased / slide');
clear();
assert.equal(pointer('contextmenu').defaultPrevented, true);

match.ball.owner = human;
pointer('pointerdown', 0); poll(); clear();
pointer('pointerleave'); pointer('pointerup', 0);
assert.ok(!poll().aim && !input.shootHeld && !input.shootReleased);
pointer('pointermove');
live = false;
assert.equal(poll().aim, null);
pointer('pointerdown', 0); pointer('pointerup', 0);
assert.ok(!poll().shootPressed && !input.shootReleased);
key('Space'); assert.ok(poll().passPressed, 'Space can skip a replay or rematch');
key('Space', 'keyup'); clear(); live = true;
pointer('pointermove', -1, { pointerType: 'touch' });
assert.equal(poll().aim, null);
pointer('pointermove'); pad.axes[0] = .75; padActive = true;
assert.ok(poll().aim, 'another player using a pad does not hide the mouse target');
assert.equal(input.move.x, 0);
padActive = false;
pointer('pointermove'); windowEvents.dispatchEvent(new Event('blur'));
key('KeyF'); assert.ok(poll().shootHeld && !input.knockOnPressed);
console.log('Mouse targeting, charge, defence, UI cancellation and device isolation passed.');
