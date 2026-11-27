import assert from 'node:assert/strict';
import { createMatch, kickoff, passTo, throughPass, shoot, tackle, knockOn, step } from '../src/sim.js';
import { resultRows } from '../src/results.js';

const dt = 1 / 60, idle = { move: { x: 0, z: 0 } };
const player = (m, team, slot) => m.players.find(p => p.team === team && p.slot === slot);
function playTo(m, p) {
  m.ball.pos = { ...p.pos, y: 0.3 };
  m.ball.vel = { x: 0, y: 0, z: 0 };
  m.ball.noPickup.clear();
  step(m, idle, dt);
  assert.equal(m.ball.owner, p);
}
const m = createMatch(17), passer = m.human, mate = player(m, 0, 2);
const opponent = player(m, 1, 2);
passTo(m, passer, mate);
playTo(m, mate);
assert.equal(m.stats[0].passes, 1);
assert.equal(m.stats[0].completed, 1);
passTo(m, mate, passer);
playTo(m, opponent);
assert.equal(m.stats[0].passes, 2);
assert.equal(m.stats[0].completed, 1, 'an interception cannot complete a pass');
passTo(m, opponent, player(m, 1, 3), 'clear');
playTo(m, player(m, 1, 3));
assert.equal(m.stats[1].passes, 0);
assert.equal(m.stats[1].completed, 0);
kickoff(m, 0);
mate.pos = { x: 7, z: -3 };
throughPass(m, m.human, { x: 1, z: 0 });
assert.equal(m.stats[0].through, 1);
assert.equal(m.stats[0].passes, 3);
playTo(m, m.ball.receiver);
assert.equal(m.stats[0].completed, 2);
passTo(m, m.ball.owner, passer);
playTo(m, mate);  // the same passer regains his own ball
assert.equal(m.stats[0].completed, 2);
knockOn(m, mate, { x: 1, z: 0 });
playTo(m, mate);
assert.equal(m.stats[0].completed, 2, 'a knock-on is never a pass');
kickoff(m, 0);
assert.equal(m.stats[0].passes, 4, 'kick-off preserves earlier match stats');
const carrier = m.ball.owner;
opponent.pos = { ...carrier.pos };
m.rand = () => 0;
tackle(m, opponent);
assert.equal(m.stats[1].tackles, 1);
tackle(m, opponent);
assert.equal(m.stats[1].tackles, 1);

function shotFixture() {
  const match = createMatch(1);
  shoot(match, match.human, 0.5);
  assert.equal(match.stats[0].shots, 1);
  return match;
}
for (const kind of ['goal', 'miss', 'catch', 'parry', 'pickup']) {
  const game = shotFixture(), ball = game.ball, keeper = player(game, 1, 0);
  const goalLine = game.pitch.length / 2;
  if (kind === 'goal' || kind === 'miss') {
    ball.pos = { x: goalLine + .26, z: kind === 'goal' ? 0 : 8, y: 0.6 }; ball.vel = { x: 10, y: 0, z: 0 };
  } else {
    keeper.pos = { x: goalLine - 3, z: 0 };
    ball.pos = { x: goalLine - 3.2, z: 0, y: 0.6 }; ball.vel = { x: kind === 'parry' ? 28 : 12, y: 0, z: 0 };
    ball.shot.rolled = kind === 'pickup';
    game.rand = () => 0;
  }
  step(game, idle, dt);
  assert.equal(game.stats[0].onTarget, Number(kind !== 'miss'), kind);
  assert.equal(game.stats[1].saves, Number(['catch', 'parry', 'pickup'].includes(kind)), kind);
  assert.equal(game.score[0], Number(kind === 'goal'), kind);
  for (let i = 0; i < 4; i++) step(game, idle, dt);
  assert.ok(game.stats[0].onTarget <= game.stats[0].shots, kind);
}
const deflection = createMatch(2);
Object.assign(deflection.ball, { owner: null, shot: null, pos: {x:deflection.pitch.length/2+.26,z:0,y:.6}, vel: {x:10,y:0,z:0} });
step(deflection, idle, dt);
assert.deepEqual(deflection.score, [1,0]);
assert.equal(deflection.stats[0].onTarget, 0, 'a goal without a shot adds only to the score');

const time = createMatch(8);
time.ball.owner = player(time, 0, 0);
step(time, idle, dt); step(time, idle, dt);
time.ball.owner = player(time, 1, 0); step(time, idle, dt);
time.ball.owner = null; time.ball.pos = {x:0,z:0,y:8}; step(time, idle, dt);
assert.deepEqual(resultRows(time).find(([label]) => label === 'Possession')[1], ['67%', '33%']);
time.clock = 0.001; step(time, idle, dt);
const frozen = structuredClone(time.stats);
for (let i = 0; i < 30; i++) step(time, idle, dt);
assert.deepEqual(time.stats, frozen);
assert.deepEqual(resultRows(createMatch(8)).find(([label]) => label === 'Possession')[1], ['—', '—']);
console.log('Full-time stats passed for both teams, receptions, interceptions, saves, own goals and possession.');
