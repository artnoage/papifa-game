import assert from 'node:assert/strict';
import { createMatch, step } from '../src/sim.js';
import { TUTORIAL_STEPS, createTutorialRunner, demoInput, blankInput } from '../src/tutorial.js';

const DT = 1 / 60;
const changes = [];
const m = createMatch(777, { size: 5, level: 'normal', humans: [true, false] });
const run = createTutorialRunner(TUTORIAL_STEPS, { onChange: (s) => changes.push(`${s.index}:${s.phase}`) });
run.begin(m, 0);

for (const [i, st] of TUTORIAL_STEPS.entries()) {
  // 1. The demonstration plays the real mechanic: the step's own success check passes during the demo.
  assert.equal(run.state().index, i);
  assert.equal(run.state().phase, 'watch', `${st.id}: starts with the demo`);
  let demoOk = false;
  const demoState = {};
  st.start?.(demoState, m);
  let guard = 0;
  while (run.state().phase === 'watch' && guard++ < 600) {
    const inp = run.input(m, blankInput());
    m.clock = 180;
    step(m, [inp, null], DT);
    st.track?.(demoState, m, inp);
    if (st.id === 'pause' || st.success(m, m.events, demoState, inp)) demoOk = true;
    run.after(m, m.events, inp, DT);
  }
  assert.ok(demoOk, `${st.id}: the demo itself performs the move`);
  assert.equal(run.state().phase, 'try', `${st.id}: hands over after the demo`);
  assert.ok(m.players.filter(p => p.team === 1 && !p.isGK).every(p => p.hold || st.id === 'never'), `${st.id}: outfield opponents stand still`);

  // 2. A player doing the same thing on the pad completes the step.
  const fired = new Set();
  let t = 0;
  guard = 0;
  if (st.id === 'pause') run.notePaused();
  while (run.state().phase === 'try' && guard++ < 600) {
    const real = demoInput(st, t, fired);
    const inp = run.input(m, real);
    assert.equal(inp, real, `${st.id}: the real pad drives the player on his turn`);
    m.clock = 180;
    step(m, [inp, null], DT);
    run.after(m, m.events, inp, DT);
    t += DT;
  }
  assert.equal(run.state().phase, 'done', `${st.id}: completes when the player does the move (t=${t.toFixed(2)})`);
  // 3. The tick beat, then the next step (or the end).
  guard = 0;
  while (run.state().phase === 'done' && guard++ < 200) {
    const inp = run.input(m, blankInput());
    step(m, [inp, null], DT);
    run.after(m, m.events, inp, DT);
  }
}
assert.equal(run.state().phase, 'complete');

// Doing nothing never completes a step; skip moves on.
{
  const m2 = createMatch(5, { size: 5, humans: [true, false] });
  const r2 = createTutorialRunner();
  r2.begin(m2, 2);                                       // pass
  for (let i = 0; i < 400; i++) { const inp = r2.input(m2, blankInput()); step(m2, [inp, null], DT); r2.after(m2, m2.events, inp, DT); }
  assert.equal(r2.state().phase, 'try', 'idle player does not pass the pass step');
  r2.skip(m2);
  assert.equal(r2.state().index, 3);
  assert.equal(r2.state().phase, 'watch');
}

console.log(`tutorial tests passed (${TUTORIAL_STEPS.length} steps: ${TUTORIAL_STEPS.map(s => s.id).join(', ')})`);
