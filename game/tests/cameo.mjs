import assert from 'node:assert/strict';
import { createMatch, step, STRONG_CATCH_SPEED } from '../src/sim.js';
import {
  CAMEO_PROB,
  cameoAudioLang,
  cameoForEvent,
  cameoHash01,
  createCameoEngine,
  isStrongCatchEvent,
} from '../src/cameo-core.js';

// 1. Language selection rule: English -> en; Greek or Off -> el.
assert.equal(cameoAudioLang('en'), 'en');
assert.equal(cameoAudioLang('el'), 'el');
assert.equal(cameoAudioLang('off'), 'el');
assert.equal(cameoAudioLang(undefined), 'el');

// 2. Event filtering: goal -> #1 scorer side; strong catch -> #2 keeper side; parry/soft catch -> null.
assert.deepEqual(cameoForEvent({ type: 'goal', team: 0 }), { id: 'petsokopses', team: 0 });
assert.deepEqual(cameoForEvent({ type: 'goal', team: 1 }), { id: 'petsokopses', team: 1 });
assert.deepEqual(cameoForEvent({ type: 'catch', team: 1, speed: STRONG_CATCH_SPEED }), { id: 'ante_geia', team: 1 });
assert.deepEqual(cameoForEvent({ type: 'catch', team: 0, kind: 'strong' }), { id: 'ante_geia', team: 0 });
assert.equal(cameoForEvent({ type: 'catch', team: 1, speed: STRONG_CATCH_SPEED - 0.1 }), null, 'soft catch must not trigger #2');
assert.equal(cameoForEvent({ type: 'catch', team: 0 }), null, 'speedless loose pickup must not trigger #2');
assert.equal(cameoForEvent({ type: 'parry', team: 1 }), null, 'parry must never trigger #2');
assert.equal(cameoForEvent({ type: 'kick', team: 0 }), null);
assert.equal(isStrongCatchEvent({ type: 'catch', team: 0, speed: 12 }), false);
assert.equal(isStrongCatchEvent({ type: 'catch', team: 0, speed: STRONG_CATCH_SPEED + 2 }), true);

// 3. Deterministic hash distribution: goal cameo ~1 in 3, repeatable across identical inputs.
let hits = 0;
const N = 20000;
for (let i = 0; i < N; i++) {
  const u1 = cameoHash01(123456, i * 17, i, 'petsokopses');
  const u2 = cameoHash01(123456, i * 17, i, 'petsokopses');
  assert.equal(u1, u2, 'hash must be deterministic');
  assert.ok(u1 >= 0 && u1 < 1, 'hash must lie in [0, 1)');
  if (u1 < CAMEO_PROB.petsokopses) hits++;
}
const rate = hits / N;
assert.ok(rate > 0.318 && rate < 0.348, `expected ~33% hit rate, got ${(rate * 100).toFixed(2)}%`);

// 4. Cameo engine NEVER touches m.rand(): two identical seeded matches produce identical final state.
const mA = createMatch(424242, { size: 5, level: 'normal', humans: [false, false] });
const mB = createMatch(424242, { size: 5, level: 'normal', humans: [false, false] });
let clockNow = 0;
const eng = createCameoEngine({ now: () => clockNow, getLang: () => 'el' });
for (let f = 0; f < 60 * 40; f++) {
  clockNow = f / 60;
  step(mA, [null, null], 1 / 60);
  step(mB, [null, null], 1 / 60);
  eng.handleEvents(mB.events, mB);
}
assert.equal(mA.rand(), mB.rand(), 'cameo engine must never consume m.rand()');
assert.deepEqual(mA.score, mB.score);
assert.equal(mA.ball.pos.x, mB.ball.pos.x);
assert.equal(mA.ball.pos.z, mB.ball.pos.z);

// 5. Lifecycle, non-overlap, forceProb hook, expiry, and host -> guest wire parity.
let tNow = 10;
let langPref = 'off';
const started = [];
const stopped = [];
const hostEng = createCameoEngine({
  now: () => tNow,
  getLang: () => langPref,
  onStart: (e) => started.push({ ...e }),
  onStop: (e) => stopped.push({ ...e }),
});
const guestEng = createCameoEngine({
  isGuest: true,
  now: () => tNow,
  getLang: () => 'en',
});

hostEng.setForceProb(1.0);
const goalEv = { type: 'goal', team: 0 };
const res1 = hostEng.handleEvents([goalEv], { seed: 7, t: 5.0 });
assert.equal(res1.length, 1);
assert.equal(res1[0].id, 'petsokopses');
assert.equal(res1[0].team, 0);
assert.equal(res1[0].lang, 'el', 'narration off -> Greek cameo audio');
assert.equal(goalEv.kind, 'cameo', 'host tags wire kind for online guest sync');

// Guest mirrors exact trigger in its own language preference.
const gRes1 = guestEng.handleEvents([{ ...goalEv }], { seed: 999, t: 5.0 });
assert.equal(gRes1.length, 1);
assert.equal(gRes1[0].id, 'petsokopses');
assert.equal(gRes1[0].team, 0);
assert.equal(gRes1[0].lang, 'en');

// While active, a strong catch must NOT overlap!
tNow += 1.0;
const overlapCatch = { type: 'catch', team: 1, speed: STRONG_CATCH_SPEED + 3, kind: 'strong' };
assert.equal(hostEng.handleEvents([overlapCatch], { seed: 7, t: 6.0 }).length, 0, 'no overlap while active');
assert.equal(overlapCatch.kind, 'strong', 'skipped catch must not be promoted to strong_cameo');

// After cameo expires (> 3.25 s), strong catch triggers #2 on keeper side.
tNow += 3.0;
langPref = 'en';
const catchEv = { type: 'catch', team: 1, speed: STRONG_CATCH_SPEED + 2, kind: 'strong' };
const res2 = hostEng.handleEvents([catchEv], { seed: 7, t: 9.0 });
assert.equal(stopped.length, 1, 'previous cameo expired cleanly');
assert.equal(res2.length, 1);
assert.equal(res2[0].id, 'ante_geia');
assert.equal(res2[0].team, 1);
assert.equal(res2[0].lang, 'en');
assert.equal(catchEv.kind, 'strong_cameo');

// Guest mirrors strong_cameo and ignores plain strong catch (when host rolled miss).
guestEng.stop();
assert.equal(guestEng.handleEvents([{ type: 'catch', team: 1, kind: 'strong' }], { seed: 999, t: 9.0 }).length, 0);
const gRes2 = guestEng.handleEvents([{ type: 'catch', team: 1, kind: 'strong_cameo' }], { seed: 999, t: 9.0 });
assert.equal(gRes2.length, 1);
assert.equal(gRes2[0].id, 'ante_geia');
assert.equal(gRes2[0].team, 1);

// Without the force hook, a strong held catch always shows its cameo.
const plainEng = createCameoEngine({ now: () => 100, getLang: () => 'el' });
for (let i = 0; i < 50; i++) {
  plainEng.stop();
  assert.equal(plainEng.handleEvents([{ type: 'catch', team: i % 2, speed: STRONG_CATCH_SPEED + 1, kind: 'strong' }], { seed: i, t: i }).length, 1, 'strong catch always fires');
}
plainEng.stop();
assert.equal(plainEng.handleEvents([{ type: 'catch', team: 0, speed: STRONG_CATCH_SPEED - 3 }], { seed: 1, t: 1 }).length, 0, 'soft catch never fires');

// Force prob = 0 never triggers.
hostEng.stop();
hostEng.setForceProb(0.0);
assert.equal(hostEng.handleEvents([{ type: 'goal', team: 1 }], { seed: 7, t: 15.0 }).length, 0);

// 6. Task H #4 (karvouno): 4th, 5th+ goals by a team -> conceding corner, odds 1.0, priority #1 over ordinary & spectacular goals, margin ignored.
assert.deepEqual(cameoForEvent({ type: 'goal', team: 0 }, { score: [3, 0] }), { id: 'petsokopses', team: 0 }, '3rd goal does NOT trigger karvouno');
assert.deepEqual(cameoForEvent({ type: 'goal', team: 0 }, { score: [4, 3] }), { id: 'karvouno', team: 1 }, '4th goal triggers karvouno in conceding corner regardless of margin');
assert.deepEqual(cameoForEvent({ type: 'goal', team: 1, kind: 'spectacular' }, { score: [4, 5] }), { id: 'karvouno', team: 0 }, '5th+ spectacular goal still prioritizes karvouno in conceding corner');
const kHost = createCameoEngine({ now: () => 200, getLang: () => 'el' });
const kGuest = createCameoEngine({ isGuest: true, now: () => 200, getLang: () => 'en' });
const kEv = { type: 'goal', team: 0, kind: 'spectacular' };
const kHostRes = kHost.handleEvents([kEv], { seed: 123, t: 88, score: [4, 4] });
assert.equal(kHostRes.length, 1, 'karvouno always fires (odds 1.0)');
assert.equal(kHostRes[0].id, 'karvouno');
assert.equal(kHostRes[0].team, 1, 'conceding team corner');
assert.equal(kEv.kind, 'karvouno', 'host tags wire kind for guest sync');
const kGuestRes = kGuest.handleEvents([{ ...kEv }], { seed: 999, t: 88, score: [4, 4] });
assert.equal(kGuestRes.length, 1);
assert.equal(kGuestRes[0].id, 'karvouno');
assert.equal(kGuestRes[0].team, 1);
assert.equal(kGuestRes[0].lang, 'en');

console.log(`cameo unit tests passed (20k hash rate=${(rate * 100).toFixed(2)}%, STRONG_CATCH_SPEED=${STRONG_CATCH_SPEED} m/s)`);
