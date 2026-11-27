import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NARRATION_CLIPS,
  PRIEST_CLIP_MAP,
  clipUrl,
  createNarrationEngine,
  resolveNarrationLang,
} from '../src/narration.js';
import { prayerBannerText } from '../src/prayer-apparition.js';
import { prayerIdleCaption } from '../src/prayer-hud.js';
import { createMatch, shoot, step } from '../src/sim.js';

// 1. Language default resolution: Greek ('el') whenever unsaved/invalid regardless of browser language; saved choice wins.
assert.equal(resolveNarrationLang(null, 'el-GR'), 'el');
assert.equal(resolveNarrationLang(null, 'el'), 'el');
assert.equal(resolveNarrationLang(null, 'en-GB'), 'el');
assert.equal(resolveNarrationLang(null, 'de-DE'), 'el');
assert.equal(resolveNarrationLang(undefined, 'en-US'), 'el');
assert.equal(resolveNarrationLang('en', 'el-GR'), 'en');
assert.equal(resolveNarrationLang('el', 'en-US'), 'el');
assert.equal(resolveNarrationLang('off', 'el-GR'), 'off');
assert.equal(resolveNarrationLang('invalid', 'en-US'), 'el');

// Dramatic prayer banner text (EN & EL).
assert.equal(prayerBannerText('jesus', 'en'), 'Jesus is with you!');
assert.equal(prayerBannerText('mary', 'en'), 'Mother Mary is with you!');
assert.equal(prayerBannerText('george', 'en'), 'St George is with you!');
assert.equal(prayerBannerText('jesus', 'el'), 'Ο Χριστός είναι μαζί σου!');
assert.equal(prayerBannerText('mary', 'el'), 'Η Παναγία είναι μαζί σου!');
assert.equal(prayerBannerText('george', 'el'), 'Ο Άγιος Γεώργιος είναι μαζί σου!');

// Idle human prayer caption copy (EN/EL, off->browser fallback, device hints, <=430px shortening, null for AI).
assert.deepEqual(prayerIdleCaption('keyboard', 'en'), { title: 'Pray to receive a blessing', hint: 'hold R' });
assert.deepEqual(prayerIdleCaption('gamepad', 'en'), { title: 'Pray to receive a blessing', hint: 'hold right stick ◀ / ▲ / ▶' });
assert.deepEqual(prayerIdleCaption('touch', 'en'), { title: 'Pray to receive a blessing', hint: 'hold Pray' });
assert.deepEqual(prayerIdleCaption('keyboard', 'el'), { title: 'Προσευχήσου για να λάβεις ευλογία', hint: 'κράτα R' });
assert.deepEqual(prayerIdleCaption('gamepad', 'el'), { title: 'Προσευχήσου για να λάβεις ευλογία', hint: 'κράτα δεξί μοχλό ◀ / ▲ / ▶' });
assert.deepEqual(prayerIdleCaption('touch', 'el'), { title: 'Προσευχήσου για να λάβεις ευλογία', hint: 'κράτα Προσευχή' });
assert.deepEqual(prayerIdleCaption('touch', 'en', { narrow: true }), { title: 'Pray for a blessing', hint: 'hold Pray' });
assert.deepEqual(prayerIdleCaption('touch', 'el', { narrow: true }), { title: 'Προσευχή για ευλογία', hint: 'κράτα Προσευχή' });
assert.deepEqual(prayerIdleCaption('keyboard', 'off', { browserLang: 'el-GR' }), { title: 'Προσευχήσου για να λάβεις ευλογία', hint: 'κράτα R' });
assert.deepEqual(prayerIdleCaption('keyboard', 'off', { browserLang: 'en-US' }), { title: 'Pray to receive a blessing', hint: 'hold R' });
assert.equal(prayerIdleCaption(null, 'en'), null);

// Shipped holy icon WebP size check (<= 250 KB each).
const uiRoot = resolve(import.meta.dirname, '../assets/ui');
for (const icon of ['icon_christ.webp', 'icon_mary.webp', 'icon_george.webp']) {
  const sz = statSync(resolve(uiRoot, icon)).size;
  assert.ok(sz > 4000 && sz <= 250 * 1024, `${icon} size ${sz} B must be <= 250 KB`);
}

// 2. Shipped MP3 inventory integrity & < 3 MB per language cap (all 68 EN + 68 EL clips shipped).
const audioRoot = resolve(import.meta.dirname, '../assets/narration');
for (const lang of ['en', 'el']) {
  const dir = resolve(audioRoot, lang);
  const files = readdirSync(dir).filter((f) => f.endsWith('.mp3'));
  for (const id of Object.values(PRIEST_CLIP_MAP)) {
    assert.ok(files.includes(`${id}.mp3`), `${lang}: missing shipped priest call-out ${id}.mp3`);
  }
  const totalBytes = files.reduce((sum, f) => sum + statSync(resolve(dir, f)).size, 0);
  assert.ok(totalBytes < 3 * 1024 * 1024, `${lang}: shipped MP3s (${totalBytes} B) must stay under 3 MB`);

  const catalogIds = new Set();
  for (const [bucket, val] of Object.entries(NARRATION_CLIPS[lang])) {
    if (Array.isArray(val)) val.forEach((id) => catalogIds.add(id));
    else if (val && typeof val === 'object') Object.values(val).forEach((id) => catalogIds.add(id));
  }
  assert.equal(catalogIds.size, files.length, `${lang}: catalog count (${catalogIds.size}) matches shipped files (${files.length})`);
  assert.equal(files.length, 68, `${lang}: expected 68 shipped clips`);
  for (const id of catalogIds) {
    assert.ok(files.includes(`${id}.mp3`), `${lang}: missing shipped file for ${id}`);
    assert.equal(clipUrl(lang, id), `assets/narration/${lang}/${id}.mp3`);
  }
}
assert.ok(NARRATION_CLIPS.el.kickoff.includes('kickoff_3'));
assert.ok(NARRATION_CLIPS.el.fulltime_draw.includes('fulltime_draw_3'));

// Helper harness for deterministic queue / priority / cooldown / ducking / no-overlap testing.
function makeHarness({ lang = 'en', enabled = true, random = () => 0, catalog = NARRATION_CLIPS } = {}) {
  let t = 0;
  let activeCount = 0;
  let maxConcurrent = 0;
  let ducked = false;
  const duckLog = [];
  const played = [];
  const stopped = [];
  let finishCurrent = null;

  const engine = createNarrationEngine({
    lang,
    getEnabled: () => enabled,
    now: () => t,
    random,
    catalog,
    onDuck(on) {
      ducked = on;
      duckLog.push({ t, on });
    },
    playClip(l, clipId, onDone, meta) {
      activeCount++;
      maxConcurrent = Math.max(maxConcurrent, activeCount);
      const handle = { l, clipId, stopped: false, done: false };
      played.push({ t, lang: l, clipId, category: meta.category, priority: meta.priority });
      finishCurrent = () => {
        if (handle.done || handle.stopped) return;
        handle.done = true;
        activeCount--;
        finishCurrent = null;
        onDone();
      };
      return handle;
    },
    stopClip(handle) {
      if (!handle || handle.stopped || handle.done) return;
      handle.stopped = true;
      activeCount--;
      stopped.push(handle.clipId);
      finishCurrent = null;
    },
  });

  return {
    engine,
    setTime(sec) { t = sec; },
    advance(sec) { t += sec; },
    setEnabled(v) { enabled = v; },
    finish() { finishCurrent?.(); },
    get activeCount() { return activeCount; },
    get maxConcurrent() { return maxConcurrent; },
    get ducked() { return ducked; },
    duckLog,
    played,
    stopped,
  };
}

// 3. Priority queue, no overlap, preemption (clash > prayer_with_* > goal/fulltime > mary_block > save > action > ambient), and ducking.
{
  const h = makeHarness({ lang: 'en' });
  const teams = [{ id: 'gold' }, { id: 'blue' }];
  // Save starts playing -> ducking turns ON.
  h.engine.handleEvents([{ type: 'parry', team: 1 }], { teams });
  assert.equal(h.played.length, 1);
  assert.equal(h.played[0].category, 'save');
  assert.equal(h.ducked, true);
  assert.equal(h.activeCount, 1);

  // While save plays, steal (prio 2) then maryBlock (prio 4) arrive -> maryBlock replaces steal in pending slot.
  h.advance(0.4);
  h.engine.handleEvents([{ type: 'steal', team: 0 }], { teams });
  assert.equal(h.engine.pending?.category, 'steal');
  h.advance(0.2);
  h.engine.handleEvents([{ type: 'maryBlock', team: 1 }], { teams });
  assert.equal(h.engine.pending?.category, 'mary_block');
  assert.equal(h.activeCount, 1, 'no overlap while pending');

  // Finishing save starts queued mary_block.
  h.advance(0.6);
  h.finish();
  assert.equal(h.played.length, 2);
  assert.equal(h.played[1].clipId.startsWith('mary_block_'), true);
  assert.equal(h.ducked, true);

  // While mary_block (prio 4) plays, goal (prio 5) preempts cleanly with zero overlap.
  h.advance(0.3);
  h.engine.handleEvents([{ type: 'goal', team: 0, jesus: true }], { teams });
  assert.equal(h.stopped.length, 1);
  assert.equal(h.played.length, 3);
  assert.equal(h.played[2].clipId.startsWith('goal_jesus_'), true);
  assert.equal(h.activeCount, 1);

  // While goal (prio 5) plays, choosing a prayer (prio 6) preempts goal!
  h.advance(0.3);
  h.engine.handleEvents([{ type: 'prayer', team: 0, kind: 'jesus' }], { teams });
  assert.equal(h.stopped.length, 2, 'prayer chosen preempts goal (priority above everything except clash)');
  assert.equal(h.played.length, 4);
  assert.ok(NARRATION_CLIPS.en.prayer_jesus.includes(h.played[3].clipId));
  assert.equal(h.activeCount, 1);

  // While prayer (prio 6) plays, clash (prio 7) preempts prayer cleanly!
  h.advance(0.3);
  h.engine.handleEvents([{ type: 'clash', attacker: 0, defender: 1 }], { teams });
  assert.equal(h.stopped.length, 3, 'clash preempts prayer');
  assert.equal(h.played.length, 5);
  assert.equal(h.played[4].category, 'clash');
  assert.equal(h.activeCount, 1);

  // While clash (prio 7) plays, choosing Mary (prio 6) does NOT interrupt clash; it queues behind clash.
  h.advance(0.3);
  h.engine.handleEvents([{ type: 'prayer', team: 1, kind: 'mary' }], { teams });
  assert.equal(h.played.length, 5, 'prayer does not interrupt clash');
  assert.ok(NARRATION_CLIPS.en.prayer_mary.includes(h.engine.pending?.clipId));
  h.advance(0.5);
  h.finish();
  assert.equal(h.played.length, 6);
  assert.ok(NARRATION_CLIPS.en.prayer_mary.includes(h.played[5].clipId));
  h.advance(1.0);
  h.finish();
  assert.equal(h.ducked, false, 'ducking restored when queue drains');
  assert.equal(h.maxConcurrent, 1, 'strictly one clip plays at a time');
}

// 3b. Prayer rotation pools (prayer_with_* + prayer_*_1..3) and strict no-immediate-repeat per kind.
{
  assert.deepEqual(NARRATION_CLIPS.en.prayer_jesus, ['prayer_with_jesus', 'prayer_jesus_1', 'prayer_jesus_2', 'prayer_jesus_3']);
  assert.deepEqual(NARRATION_CLIPS.en.prayer_mary, ['prayer_with_mary', 'prayer_mary_1', 'prayer_mary_2', 'prayer_mary_3']);
  assert.deepEqual(NARRATION_CLIPS.el.prayer_jesus, ['prayer_with_jesus', 'prayer_jesus_1', 'prayer_jesus_2', 'prayer_jesus_3']);
  assert.deepEqual(NARRATION_CLIPS.el.prayer_mary, ['prayer_with_mary', 'prayer_mary_1', 'prayer_mary_2', 'prayer_mary_3']);

  let seed = 1;
  const detRand = () => { seed = (seed * 48271) % 2147483647; return (seed - 1) / 2147483646; };
  const h = makeHarness({ lang: 'en', random: detRand });
  const seenJesus = new Set();
  const seenMary = new Set();
  let prevJesus = null;
  let prevMary = null;
  for (let i = 0; i < 32; i++) {
    h.engine.handleEvents([{ type: 'prayer', team: 0, kind: 'jesus' }], {});
    const jClip = h.played.at(-1).clipId;
    assert.ok(NARRATION_CLIPS.en.prayer_jesus.includes(jClip));
    assert.notEqual(jClip, prevJesus, `Jesus prayer clip must not repeat immediately (${jClip})`);
    prevJesus = jClip;
    seenJesus.add(jClip);
    h.advance(1.0); h.finish(); h.advance(1.0);

    h.engine.handleEvents([{ type: 'prayer', team: 1, kind: 'mary' }], {});
    const mClip = h.played.at(-1).clipId;
    assert.ok(NARRATION_CLIPS.en.prayer_mary.includes(mClip));
    assert.notEqual(mClip, prevMary, `Mary prayer clip must not repeat immediately (${mClip})`);
    prevMary = mClip;
    seenMary.add(mClip);
    h.advance(1.0); h.finish(); h.advance(1.0);
  }
  assert.equal(seenJesus.size, 4, `all 4 Jesus prayer clips rotated: ${[...seenJesus]}`);
  assert.equal(seenMary.size, 4, `all 4 Mary prayer clips rotated: ${[...seenMary]}`);
}

// 4. Cooldowns, low-priority spacing, and stale pending drop.
{
  const h = makeHarness({ lang: 'en' });
  h.engine.handleEvents([{ type: 'steal', team: 0 }], {});
  assert.equal(h.played.length, 1);
  h.advance(1.0);
  h.finish();
  // Immediate second steal is suppressed by cooldown (9 s) and low-priority gap (4.5 s).
  h.advance(2.0);
  h.engine.handleEvents([{ type: 'steal', team: 1 }], {});
  assert.equal(h.played.length, 1, 'steal within cooldown suppressed');
  // Slide tackle within 4.5 s low-priority gap after previous clip finished is also suppressed.
  h.engine.handleEvents([{ type: 'tackle', kind: 'slide', team: 0 }], {});
  assert.equal(h.played.length, 1, 'low-priority gap prevents back-to-back chatter');
  // After 5 s gap, slide tackle plays.
  h.advance(3.0);
  h.engine.handleEvents([{ type: 'tackle', kind: 'slide', team: 0 }], {});
  assert.equal(h.played.length, 2);
  assert.equal(h.played[1].category, 'slide_tackle');
  // Pending save queued for > 2.2 s becomes stale and is dropped on finish.
  h.engine.handleEvents([{ type: 'parry', team: 0 }], {});
  assert.equal(h.engine.pending?.category, 'save');
  h.advance(3.0);
  h.finish();
  assert.equal(h.played.length, 2, 'stale queued clip dropped instead of playing late');
}

// 5. Kickoff plays only on opening kickoff, not after goals.
{
  const h = makeHarness({ lang: 'en' });
  h.engine.handleEvents([{ type: 'kickoff', team: 0 }], { match: { t: 0 } });
  assert.equal(h.played.length, 1);
  assert.equal(h.played[0].category, 'kickoff');
  h.advance(10);
  h.finish();
  h.advance(10);
  h.engine.handleEvents([{ type: 'kickoff', team: 1 }], { match: { t: 45 } });
  assert.equal(h.played.length, 1, 'post-goal kickoff restart does not replay match-start line');
  h.engine.resetMatch();
  h.advance(10);
  h.engine.handleEvents([{ type: 'kickoff', team: 0 }], { match: { t: 0 } });
  assert.equal(h.played.length, 2, 'rematch opening kickoff plays again');
}

// 6. Kit-based goal lines, Local 2P neutral full-time, vs-AI & online win/loss/draw.
{
  // Team 0 wearing BLUE kit, Team 1 wearing GOLD kit -> Team 0 goal must pick goal_blue_*!
  const swappedTeams = [{ id: 'blue' }, { id: 'gold' }];
  const h = makeHarness({ lang: 'en', random: () => 0.1 }); // < 0.65 -> chooses kit-specific line
  h.engine.handleEvents([{ type: 'goal', team: 0 }], { teams: swappedTeams });
  assert.ok(h.played[0].clipId.startsWith('goal_blue_'), `expected goal_blue for blue kit, got ${h.played[0].clipId}`);
  h.advance(2); h.finish(); h.advance(2);
  h.engine.handleEvents([{ type: 'goal', team: 1 }], { teams: swappedTeams });
  assert.ok(h.played[1].clipId.startsWith('goal_gold_'), `expected goal_gold for gold kit, got ${h.played[1].clipId}`);
  h.advance(2); h.finish(); h.advance(2);

  // vs AI win (team 0 ahead, localTeam 0)
  h.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [3, 1] }, localTeam: 0, isLocal2P: false });
  assert.ok(h.played[2].clipId.startsWith('fulltime_win_'));
  h.advance(6); h.finish(); h.advance(6);

  // Online guest win (team 1 ahead, localTeam 1)
  h.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [1, 2] }, localTeam: 1, isLocal2P: false });
  assert.ok(h.played[3].clipId.startsWith('fulltime_win_'));
  h.advance(6); h.finish(); h.advance(6);

  // Online guest loss (team 0 ahead, localTeam 1)
  h.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [2, 0] }, localTeam: 1, isLocal2P: false });
  assert.ok(h.played[4].clipId.startsWith('fulltime_loss_'));
  h.advance(6); h.finish(); h.advance(6);

  // Local 2P non-draw -> neutral line
  h.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [4, 2] }, localTeam: 0, isLocal2P: true });
  assert.ok(h.played[5].clipId.startsWith('fulltime_neutral_'));
  h.advance(6); h.finish(); h.advance(6);

  // Draw -> draw line in any mode
  h.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [2, 2] }, localTeam: 0, isLocal2P: true });
  assert.ok(h.played[6].clipId.startsWith('fulltime_draw_'));
}

// 7. Off = completely silent; switching Off mid-clip stops playback and restores ducking.
{
  const off = makeHarness({ lang: 'off' });
  off.engine.handleEvents([
    { type: 'kickoff', team: 0 },
    { type: 'goal', team: 0 },
    { type: 'clash', attacker: 0, defender: 1 },
    { type: 'fulltime' },
  ], { match: { score: [1, 0], t: 0 }, teams: [{ id: 'gold' }, { id: 'blue' }] });
  assert.equal(off.played.length, 0, 'Off plays zero clips');
  assert.equal(off.duckLog.length, 0, 'Off never ducks SFX');

  const live = makeHarness({ lang: 'el' });
  live.engine.handleEvents([{ type: 'goal', team: 0, jesus: true }], {});
  assert.equal(live.played.length, 1);
  assert.equal(live.played[0].lang, 'el');
  assert.equal(live.ducked, true);
  live.engine.setLang('off');
  assert.equal(live.activeCount, 0, 'switching to Off stops active clip');
  assert.equal(live.ducked, false, 'switching to Off restores ducking');
  live.advance(5);
  live.engine.handleEvents([{ type: 'clash', attacker: 0, defender: 1 }], {});
  assert.equal(live.played.length, 1, 'no clips play after switching to Off');
}

// 8. Observed events (last_30s, long_shot, near_miss) and priest call-out drop-in hook.
{
  const h = makeHarness({ lang: 'en' });
  const pitch = { length: 73, width: 44, goalWidth: 7.32, goalHeight: 2.44 };
  const match = { t: 10, clock: 29.5, phase: 'play', size: 5, pitch, ball: { pos: { x: 0, y: 0.3, z: 0 }, vel: { x: 0, y: 0, z: 0 }, owner: null } };
  h.engine.observeMatch(match);
  assert.equal(h.played[0]?.category, 'last_30s');
  h.advance(6); h.finish(); h.advance(6);
  // Repeating at 28 s does not re-trigger last_30s.
  match.clock = 28.0;
  h.engine.observeMatch(match);
  assert.equal(h.played.length, 1);

  // Long-range shot (distance >= 22 m from goal at x=36.5)
  match.t = 25;
  match.ball.pos = { x: 8, y: 0.3, z: 0 };
  h.engine.handleEvents([{ type: 'kick', team: 0, kind: 'shot' }], { match });
  assert.equal(h.played[1]?.category, 'long_shot');
  h.advance(6); h.finish(); h.advance(6);

  // Near miss: shot near goal frame bouncing wide without scoring
  match.t = 40;
  match.ball.pos = { x: 25, y: 0.4, z: 0 };
  h.engine.handleEvents([{ type: 'kick', team: 0, kind: 'shot' }], { match });
  match.t = 40.5;
  match.ball.pos = { x: 36.2, y: 1.5, z: 4.1 };
  match.ball.vel = { x: -3.0, y: 0, z: 2.0 };
  h.engine.observeMatch(match);
  assert.equal(h.played[2]?.category, 'near_miss');

  // 9. Post-goal scorer call-out, own-goal skip, unknown-scorer skip, queue priority drop, ~1/3 save call-out, & sim scorer tagging.
  {
    const teams = [{ id: 'gold' }, { id: 'blue' }];

    // Goal by Nikolai queues goal_* then priest_nikolai (EN & EL).
    for (const lang of ['en', 'el']) {
      const g = makeHarness({ lang, random: () => 0.1 });
      g.engine.handleEvents([{ type: 'goal', team: 0, scorer: 'nikolai' }], { teams });
      assert.equal(g.played.length, 1);
      assert.ok(g.played[0].clipId.startsWith('goal_'), `${lang}: expected goal_* first, got ${g.played[0].clipId}`);
      assert.equal(g.engine.pending?.clipId, 'priest_nikolai', `${lang}: priest_nikolai queued behind goal_*`);
      g.advance(2.6); // longer than PENDING_MAX_AGE_S (2.2s): follow-up still fires cleanly once goal ends
      g.finish();
      assert.equal(g.played.length, 2, `${lang}: priest_nikolai plays right after goal_*`);
      assert.equal(g.played[1].clipId, 'priest_nikolai');
      assert.equal(g.played[1].category, 'priest');
      assert.equal(g.maxConcurrent, 1);
      g.advance(1.2);
      g.finish();
      assert.equal(g.ducked, false);
    }

    // Own goal gets NO priest call-out, even if scorer field were somehow set.
    const og = makeHarness({ lang: 'en', random: () => 0.1 });
    og.engine.handleEvents([{ type: 'goal', team: 0, ownGoal: true, scorer: 'nikolai' }], { teams });
    assert.equal(og.played.length, 1);
    assert.ok(og.played[0].clipId.startsWith('goal_'));
    assert.equal(og.engine.pending, null, 'own goal must not queue a priest call-out');
    og.advance(2.0);
    og.finish();
    assert.equal(og.played.length, 1, 'own goal plays no follow-up call-out');

    // Unknown scorer gets NO priest call-out.
    const unk = makeHarness({ lang: 'en', random: () => 0.1 });
    unk.engine.handleEvents([{ type: 'goal', team: 0 }], { teams });
    assert.equal(unk.engine.pending, null);
    unk.advance(2.0);
    unk.finish();
    assert.equal(unk.played.length, 1, 'unknown scorer plays no follow-up call-out');

    // Higher-priority event (>= goal, e.g. fulltime prio 5) arriving during goal line drops priest call-out cleanly.
    const dropFt = makeHarness({ lang: 'en', random: () => 0.1 });
    dropFt.engine.handleEvents([{ type: 'goal', team: 0, scorer: 'nikolai' }], { teams });
    assert.equal(dropFt.engine.pending?.clipId, 'priest_nikolai');
    dropFt.advance(0.4);
    dropFt.engine.handleEvents([{ type: 'fulltime' }], { match: { score: [1, 0] }, localTeam: 0 });
    assert.equal(dropFt.engine.pending?.category, 'fulltime');
    dropFt.advance(0.6);
    dropFt.finish();
    assert.equal(dropFt.played.length, 2);
    assert.equal(dropFt.played[1].category, 'fulltime', 'fulltime plays instead of priest call-out');
    dropFt.advance(1.0);
    dropFt.finish();
    assert.equal(dropFt.played.length, 2, 'dropped priest call-out never plays after fulltime');

    // Prayer (prio 6) preempting a goal drops its priest call-out immediately.
    const dropPr = makeHarness({ lang: 'en', random: () => 0.1 });
    dropPr.engine.handleEvents([{ type: 'goal', team: 0, scorer: 'giorgis' }], { teams });
    dropPr.advance(0.3);
    dropPr.engine.handleEvents([{ type: 'prayer', team: 1, kind: 'mary' }], { teams });
    assert.equal(dropPr.played.length, 2);
    assert.equal(dropPr.played[1].category, 'prayer');
    dropPr.advance(1.0);
    dropPr.finish();
    assert.equal(dropPr.played.length, 2, 'preempted goal call-out does not play after prayer');

    // Optional ~1/3 save keeper call-out: triggers when random < 1/3, skipped when random >= 1/3.
    const saveHit = makeHarness({ lang: 'en', random: () => 0.1 });
    saveHit.engine.handleEvents([{ type: 'parry', team: 1, keeper: 'luka' }], { teams });
    assert.equal(saveHit.played[0].category, 'save');
    saveHit.advance(1.2);
    saveHit.finish();
    assert.equal(saveHit.played[1]?.clipId, 'priest_luka', '1-in-3 save calls keeper name');

    const saveSkip = makeHarness({ lang: 'en', random: () => 0.8 });
    saveSkip.engine.handleEvents([{ type: 'parry', team: 1, keeper: 'luka' }], { teams });
    assert.equal(saveSkip.played[0].category, 'save');
    saveSkip.advance(1.2);
    saveSkip.finish();
    assert.equal(saveSkip.played.length, 1, 'remaining 2/3 saves skip keeper call-out');

    // Pass reception does not spam priest call-outs.
    const recv = makeHarness({ lang: 'en' });
    recv.engine.handleEvents([{ type: 'receive', team: 0 }], { match: { ball: { owner: { info: { id: 'nikolai' } } } } });
    assert.equal(recv.played.length, 0);

    // Sim integration: shot by Nikolai records scorer='nikolai' (not ownGoal); defender-touched ball into own net records ownGoal=true.
    const m = createMatch(1, { size: 5, level: 'normal', humans: [true, false] });
    const nikolai = m.players.find((p) => p.team === 0 && p.info.id === 'nikolai');
    assert.ok(nikolai, 'team 0 has nikolai');
    nikolai.pos = { x: 30, z: 0 }; nikolai.vel = { x: 0, z: 0 }; nikolai.facing = 0;
    for (const p of m.players) if (p !== nikolai) p.pos = { x: -20, z: p.pos.z };
    m.ball.owner = nikolai; m.ball.pos = { x: 30.7, y: 0.3, z: 0 }; m.ball.vel = { x: 0, y: 0, z: 0 };
    shoot(m, nikolai, 0.7, 0);
    let goalEv = null;
    for (let i = 0; i < 90 && !goalEv; i++) {
      step(m, [{ move: { x: 0, z: 0 } }], 1 / 60);
      goalEv = m.events.find((ev) => ev.type === 'goal');
    }
    assert.ok(goalEv, 'Nikolai shot scored');
    assert.equal(goalEv.scorer, 'nikolai');
    assert.equal(Boolean(goalEv.ownGoal), false);

    // Own goal via defender lastTouch rolling into own goal.
    const m2 = createMatch(2, { size: 5, level: 'normal', humans: [true, false] });
    const def = m2.players.find((p) => p.team === 1 && !p.isGK);
    for (const p of m2.players) p.pos = { x: -20, z: p.pos.z };
    m2.ball.owner = null; m2.ball.shot = null; m2.ball.lastTouch = def;
    m2.ball.pos = { x: 36.2, y: 0.3, z: 0 }; m2.ball.vel = { x: 8, y: 0, z: 0 };
    let ogEv = null;
    for (let i = 0; i < 30 && !ogEv; i++) {
      step(m2, [{ move: { x: 0, z: 0 } }], 1 / 60);
      ogEv = m2.events.find((ev) => ev.type === 'goal');
    }
    assert.ok(ogEv, 'own goal scored');
    assert.equal(ogEv.team, 0);
    assert.equal(ogEv.ownGoal, true);
    assert.equal(ogEv.scorer, undefined);
  }
}

console.log('All narration queue, priority, cooldown, ducking, kit/mode, Off, call-out, caption, and inventory tests passed.');
