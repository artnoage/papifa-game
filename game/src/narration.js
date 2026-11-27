// Match narration playback: priority queue, cooldowns, SFX ducking, lazy per-language MP3 loading,
// kit-based goal lines, neutral Local 2P wrap-ups, vs-AI/online win-loss lines, and optional priest call-out hook.
import { readPreference, savePreference } from './preferences.js';
import { getAudioContext, getNarrationBus, narrationVolume, onAudioChange, setNarrationDuck, soundEnabled, startAudio } from './audio.js';

export const NARRATION_LANGS = ['el', 'en', 'off'];
export const LANG_LABELS = { el: 'Ελληνικά', en: 'English', off: 'Off' };

// Priority order: clash > prayer_with_* (on choosing) > goal/fulltime > mary_block > save > shot/tackle > ambient.
export const PRIORITY = {
  clash: 7,
  prayer: 6,
  fulltime: 5,
  goal: 5,
  mary_block: 4,
  save: 3,
  near_miss: 2,
  long_shot: 2,
  slide_tackle: 2,
  steal: 2,
  kickoff: 1,
  last_30s: 1,
  priest: 1,
};

// Per-category cooldowns in seconds so commentary stays natural and never spams.
export const COOLDOWNS = {
  clash: 1.0,
  fulltime: 5.0,
  goal: 1.0,
  prayer: 0.5,
  mary_block: 3.0,
  save: 5.0,
  near_miss: 6.0,
  long_shot: 7.0,
  slide_tackle: 8.0,
  steal: 9.0,
  kickoff: 4.0,
  last_30s: 45.0,
  priest: 11.0,
};

export const LOW_PRIORITY_GAP_S = 4.5;
export const PENDING_MAX_AGE_S = 2.2;

// Map roster priest ids to clip ids for scorer & save call-outs.
export const PRIEST_CLIP_MAP = {
  luka: 'priest_luka',
  giorgis: 'priest_giorgis',
  seraphim: 'priest_seraphim',
  ioannis: 'priest_ioannis',
  nikolai: 'priest_nikolai',
};

// Approved shipped MP3 catalog per language (all 68 EN + 68 EL clips).
const SHARED_BUCKETS = {
  kickoff: ['kickoff_1', 'kickoff_2', 'kickoff_3'],
  prayer_jesus: ['prayer_with_jesus', 'prayer_jesus_1', 'prayer_jesus_2', 'prayer_jesus_3'],
  prayer_mary: ['prayer_with_mary', 'prayer_mary_1', 'prayer_mary_2', 'prayer_mary_3'],
  goal_gold: ['goal_gold_1', 'goal_gold_2', 'goal_gold_3'],
  goal_blue: ['goal_blue_1', 'goal_blue_2', 'goal_blue_3'],
  goal_generic: ['goal_generic_1', 'goal_generic_2', 'goal_generic_3', 'goal_generic_4'],
  goal_jesus: ['goal_jesus_1', 'goal_jesus_2', 'goal_jesus_3', 'goal_jesus_4'],
  save: ['save_1', 'save_2', 'save_3', 'save_4'],
  near_miss: ['near_miss_1', 'near_miss_2', 'near_miss_3', 'near_miss_4'],
  slide_tackle: ['slide_tackle_1', 'slide_tackle_2', 'slide_tackle_3'],
  steal: ['steal_1', 'steal_2', 'steal_3'],
  long_shot: ['long_shot_1', 'long_shot_2', 'long_shot_3'],
  mary_block: ['mary_block_1', 'mary_block_2', 'mary_block_3', 'mary_block_4'],
  clash: ['clash_1', 'clash_2'],
  last_30s: ['last_30s_1', 'last_30s_2', 'last_30s_3'],
  fulltime_win: ['fulltime_win_1', 'fulltime_win_2', 'fulltime_win_3'],
  fulltime_draw: ['fulltime_draw_1', 'fulltime_draw_2', 'fulltime_draw_3'],
  fulltime_loss: ['fulltime_loss_1', 'fulltime_loss_2', 'fulltime_loss_3'],
  fulltime_neutral: ['fulltime_neutral_1', 'fulltime_neutral_2', 'fulltime_neutral_3'],
  priest: PRIEST_CLIP_MAP,
};

export const NARRATION_CLIPS = {
  en: { ...SHARED_BUCKETS },
  el: { ...SHARED_BUCKETS },
};

const PREFETCH_BUCKET_ORDER = [
  'prayer_jesus', 'prayer_mary', 'kickoff', 'clash',
  'goal_gold', 'goal_blue', 'goal_generic', 'goal_jesus',
  'mary_block', 'save', 'near_miss', 'long_shot', 'slide_tackle', 'steal',
  'last_30s', 'fulltime_win', 'fulltime_draw', 'fulltime_loss', 'fulltime_neutral',
];

const langListeners = new Set();

export function resolveNarrationLang(saved) {
  if (saved === 'en' || saved === 'el' || saved === 'off') return saved;
  return 'el';
}

export function narrationLang() {
  return resolveNarrationLang(readPreference('narration.v2'));
}

export function setNarrationLang(lang) {
  if (!NARRATION_LANGS.includes(lang)) return;
  savePreference('narration.v2', lang);
  for (const fn of langListeners) fn(lang);
}

export function onNarrationLangChange(fn) {
  langListeners.add(fn);
  return () => langListeners.delete(fn);
}

export function narrationLangLabel(lang = narrationLang()) {
  return LANG_LABELS[lang] ?? LANG_LABELS.el;
}

export function clipUrl(lang, clipId) {
  return `assets/narration/${lang}/${clipId}.mp3`;
}

// Pure, deterministic narration queue engine (injectable timers/playback for unit tests and browser runtime).
export function createNarrationEngine({
  lang = 'el',
  getEnabled = () => true,
  now = () => performance.now() / 1000,
  random = Math.random,
  playClip = () => null,
  stopClip = () => {},
  onDuck = () => {},
  catalog = NARRATION_CLIPS,
} = {}) {
  let currentLang = NARRATION_LANGS.includes(lang) ? lang : 'el';
  let active = null;       // { lang, clipId, category, priority, handle, token }
  let pending = null;      // { category, bucket, clipId, priority, queuedAt }
  let playToken = 0;
  let lastFinishAt = -Infinity;
  const lastCategoryAt = new Map();
  const lastVariant = new Map();
  let sawKickoff = false;
  let announcedLast30s = false;
  let pendingShot = null;

  function pickClip(l, bucket, explicitId = null) {
    if (l === 'off') return null;
    const langCat = catalog[l];
    if (!langCat) return null;
    if (explicitId) {
      const allowed = langCat.priest?.[explicitId];
      return allowed || null;
    }
    const list = langCat[bucket];
    if (!Array.isArray(list) || list.length === 0) return null;
    if (list.length === 1) return list[0];
    const prev = lastVariant.get(`${l}:${bucket}`);
    const choices = list.filter((id) => id !== prev);
    const chosen = choices[Math.floor(random() * choices.length) % choices.length];
    lastVariant.set(`${l}:${bucket}`, chosen);
    return chosen;
  }

  function resolveFollowUp(priestId, bypassCooldown = false) {
    if (!priestId || currentLang === 'off') return null;
    const clipId = pickClip(currentLang, 'priest', priestId);
    if (!clipId) return null;
    return { priestId, clipId, bypassCooldown };
  }

  function startFollowUp(followUp) {
    if (active || !followUp || currentLang === 'off' || !getEnabled()) return false;
    const clipId = pickClip(currentLang, 'priest', followUp.priestId);
    if (!clipId) return false;
    if (!followUp.bypassCooldown) {
      const t = now();
      const last = lastCategoryAt.get('priest') ?? -Infinity;
      if (t - last < COOLDOWNS.priest) return false;
    }
    return startItem({
      category: 'priest',
      bucket: 'priest',
      clipId,
      priestId: followUp.priestId,
      priority: PRIORITY.priest,
      queuedAt: now(),
      followUp: null,
    });
  }

  function finishActive(token) {
    if (!active || active.token !== token) return;
    const finished = active;
    active = null;
    lastFinishAt = now();
    onDuck(false);
    const highWaiting = Boolean(pending && pending.priority >= PRIORITY.goal);
    if (flushPending()) return;
    if (!highWaiting && finished.followUp) {
      startFollowUp(finished.followUp);
    }
  }

  function startItem(item) {
    if (currentLang === 'off' || !getEnabled()) {
      pending = null;
      return false;
    }
    const t = now();
    const token = ++playToken;
    const clipId = item.clipId ?? pickClip(currentLang, item.bucket, item.priestId);
    if (!clipId) return false;
    lastCategoryAt.set(item.category, t);
    active = {
      lang: currentLang,
      clipId,
      category: item.category,
      priority: item.priority,
      token,
      handle: null,
      followUp: item.followUp ?? null,
    };
    onDuck(true);
    const done = () => finishActive(token);
    const handle = playClip(currentLang, clipId, done, { category: item.category, priority: item.priority });
    if (active && active.token === token) active.handle = handle;
    return true;
  }

  function flushPending() {
    if (active || !pending) return false;
    const item = pending;
    pending = null;
    if (currentLang === 'off' || !getEnabled()) return false;
    const t = now();
    if (t - item.queuedAt > PENDING_MAX_AGE_S) return false;
    const cd = COOLDOWNS[item.category] ?? 3.0;
    const last = lastCategoryAt.get(item.category) ?? -Infinity;
    if (t - last < cd) return false;
    return startItem(item);
  }

  function enqueue(category, bucket, {
    priestId = null,
    forcePriority = null,
    followUpPriestId = null,
    followUpBypassCooldown = false,
  } = {}) {
    if (currentLang === 'off' || !getEnabled()) return false;
    const priority = forcePriority ?? (PRIORITY[category] ?? 1);
    const t = now();
    const cd = COOLDOWNS[category] ?? 3.0;
    const last = lastCategoryAt.get(category) ?? -Infinity;
    if (t - last < cd) return false;

    // Quiet gap after any finished line before low-priority chatter speaks again.
    if (!active && priority <= 2 && t - lastFinishAt < LOW_PRIORITY_GAP_S) return false;

    // Verify a clip actually exists for this language before displacing anything.
    const clipId = pickClip(currentLang, bucket, priestId);
    if (!clipId) return false;

    const followUp = resolveFollowUp(followUpPriestId, followUpBypassCooldown);
    const item = { category, bucket, clipId, priestId, priority, queuedAt: t, followUp };

    if (!active) {
      return startItem(item);
    }

    // Strict no-overlap: top-tier moments (clash/prayer/fulltime/goal) cleanly cut off lower-priority speech.
    if (priority >= 5 && priority > active.priority) {
      const prev = active;
      active = null;
      playToken++;
      stopClip(prev.handle);
      onDuck(false);
      pending = null;
      return startItem(item);
    }

    // Otherwise hold at most one pending clip, keeping the strictly higher-priority one.
    if (!pending || priority > pending.priority) {
      pending = item;
      if (priority >= PRIORITY.goal && active.followUp) active.followUp = null;
      return true;
    }
    return false;
  }

  function stop() {
    pending = null;
    if (active) {
      const prev = active;
      active = null;
      playToken++;
      stopClip(prev.handle);
      onDuck(false);
    }
  }

  function setLang(nextLang) {
    if (!NARRATION_LANGS.includes(nextLang)) return;
    currentLang = nextLang;
    if (currentLang === 'off') stop();
  }

  function resetMatch() {
    sawKickoff = false;
    announcedLast30s = false;
    pendingShot = null;
    pending = null;
  }

  function triggerPriestCallout(priestId) {
    if (!priestId) return false;
    return enqueue('priest', 'priest', { priestId });
  }

  function handleEvents(events, { match, teams, localTeam = 0, isLocal2P = false } = {}) {
    if (!events?.length) return;
    for (const e of events) {
      if (e.type === 'clash') {
        pendingShot = null;
        enqueue('clash', 'clash');
      } else if (e.type === 'fulltime') {
        pendingShot = null;
        const s0 = match?.score?.[0] ?? 0;
        const s1 = match?.score?.[1] ?? 0;
        let bucket = 'fulltime_draw';
        if (s0 !== s1) {
          if (isLocal2P) bucket = 'fulltime_neutral';
          else bucket = (localTeam === 0 ? s0 > s1 : s1 > s0) ? 'fulltime_win' : 'fulltime_loss';
        }
        enqueue('fulltime', bucket);
      } else if (e.type === 'goal') {
        pendingShot = null;
        const scorerId = e.ownGoal
          ? null
          : (typeof e.scorer === 'string' ? e.scorer : (e.scorer?.info?.id ?? null));
        const callOut = scorerId ? { followUpPriestId: scorerId, followUpBypassCooldown: true } : {};
        if (e.jesus) {
          enqueue('goal', 'goal_jesus', callOut);
        } else {
          const kitId = teams?.[e.team]?.id;
          const kitBucket = kitId === 'gold' ? 'goal_gold' : kitId === 'blue' ? 'goal_blue' : 'goal_generic';
          const useKit = kitBucket !== 'goal_generic' && random() < 0.65;
          enqueue('goal', useKit ? kitBucket : 'goal_generic', callOut);
        }
      } else if (e.type === 'prayer') {
        if (e.kind === 'jesus' || e.kind === 'mary') {
          enqueue('prayer', e.kind === 'mary' ? 'prayer_mary' : 'prayer_jesus');
        }
      } else if (e.type === 'maryBlock') {
        pendingShot = null;
        enqueue('mary_block', 'mary_block');
      } else if (e.type === 'parry' || e.type === 'catch') {
        pendingShot = null;
        const keeperId = typeof e.keeper === 'string'
          ? e.keeper
          : (match?.players?.find((p) => p.isGK && p.team === e.team)?.info?.id ?? null);
        const callKeeper = keeperId && random() < (1 / 3);
        enqueue('save', 'save', callKeeper ? { followUpPriestId: keeperId } : {});
      } else if (e.type === 'tackle' && e.kind === 'slide') {
        enqueue('slide_tackle', 'slide_tackle');
      } else if (e.type === 'steal') {
        if (e.kind === 'slide') enqueue('slide_tackle', 'slide_tackle');
        else enqueue('steal', 'steal');
      } else if (e.type === 'kick') {
        if (!e.jesus && e.kind !== 'clear' && match?.pitch && match?.ball) {
          const hl = match.pitch.length / 2;
          const goalX = (e.team === 0 ? 1 : -1) * hl;
          const dist = Math.abs(goalX - match.ball.pos.x);
          const minLong = match.size === 3 ? 18 : 22;
          pendingShot = { team: e.team, at: match.t, goalX };
          if (dist >= minLong) enqueue('long_shot', 'long_shot');
        }
      } else if (e.type === 'kickoff') {
        pendingShot = null;
        const opening = !sawKickoff || (match && match.t < 2);
        sawKickoff = true;
        if (opening) enqueue('kickoff', 'kickoff');
      }
    }
  }

  function observeMatch(match) {
    if (!match || match.phase !== 'play') return;
    if (!announcedLast30s && match.clock <= 30 && match.clock > 20) {
      announcedLast30s = true;
      enqueue('last_30s', 'last_30s');
    }
    if (pendingShot) {
      const age = match.t - pendingShot.at;
      const b = match.ball;
      if (age > 2.2 || !b || b.owner) {
        pendingShot = null;
      } else {
        const hl = match.pitch.length / 2;
        const gw = match.pitch.goalWidth / 2;
        const gh = match.pitch.goalHeight;
        const dir = pendingShot.team === 0 ? 1 : -1;
        const nearGoalLine = Math.abs(b.pos.x - pendingShot.goalX) <= 2.4;
        const nearFrameZ = Math.abs(b.pos.z) <= gw + 2.6;
        const nearFrameY = b.pos.y <= gh + 1.8;
        const movingAwayOrPast = b.vel.x * dir <= 0.5 || Math.abs(b.pos.x) >= hl - 0.6;
        if (nearGoalLine && nearFrameZ && nearFrameY && movingAwayOrPast && age > 0.15) {
          pendingShot = null;
          enqueue('near_miss', 'near_miss');
        }
      }
    }
  }

  return {
    get lang() { return currentLang; },
    get active() { return active ? { lang: active.lang, clipId: active.clipId, category: active.category, priority: active.priority } : null; },
    get pending() {
      if (pending) return { category: pending.category, clipId: pending.clipId, priority: pending.priority };
      if (active?.followUp) return { category: 'priest', clipId: active.followUp.clipId, priority: PRIORITY.priest };
      return null;
    },
    setLang,
    enqueue,
    handleEvents,
    observeMatch,
    triggerPriestCallout,
    resetMatch,
    stop,
    finishActive,
  };
}

let lastBrowserNarration = null;
export function getNarrationDebug() {
  return lastBrowserNarration ? lastBrowserNarration.getStats() : null;
}

// Browser runtime wrapper: Web Audio decoding, lazy per-language fetch after kickoff, and SFX ducking.
export function createMatchNarration({ teams, localTeam = 0, isLocal2P = false } = {}) {
  const buffers = new Map();     // `${lang}/${clipId}` -> AudioBuffer
  const inflight = new Map();    // `${lang}/${clipId}` -> Promise<AudioBuffer|null>
  const fetchedUrls = new Set();
  const playedHistory = [];
  const prefetchedLangs = new Set();
  let matchStarted = false;
  let prefetchRunId = 0;

  async function loadBuffer(lang, clipId) {
    if (lang === 'off') return null;
    const key = `${lang}/${clipId}`;
    if (buffers.has(key)) return buffers.get(key);
    if (inflight.has(key)) return inflight.get(key);
    const url = clipUrl(lang, clipId);
    const p = (async () => {
      try {
        startAudio();
        const ctx = getAudioContext();
        if (!ctx) return null;
        fetchedUrls.add(url);
        const res = await fetch(url);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(ab);
        buffers.set(key, buf);
        return buf;
      } catch {
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  async function prefetchLanguage(lang) {
    if (!matchStarted || lang === 'off' || prefetchedLangs.has(lang)) return;
    const cat = NARRATION_CLIPS[lang];
    if (!cat) return;
    prefetchedLangs.add(lang);
    const myRun = ++prefetchRunId;
    const ids = [];
    for (const bucket of PREFETCH_BUCKET_ORDER) {
      const list = cat[bucket];
      if (Array.isArray(list)) ids.push(...list);
    }
    if (cat.priest && typeof cat.priest === 'object') {
      ids.push(...Object.values(cat.priest));
    }
    // Lazy low-concurrency fetch waves so kickoff and frame pacing stay smooth.
    const WAVE = 3;
    for (let i = 0; i < ids.length; i += WAVE) {
      if (myRun !== prefetchRunId || engine.lang !== lang) {
        prefetchedLangs.delete(lang);
        return;
      }
      await Promise.all(ids.slice(i, i + WAVE).map((id) => loadBuffer(lang, id)));
    }
  }

  function playClip(lang, clipId, onDone) {
    const handle = { stopped: false, source: null };
    const startWithBuffer = (buf) => {
      if (handle.stopped) return;
      const ctx = getAudioContext();
      const bus = getNarrationBus();
      if (!buf || !ctx || !bus || !soundEnabled() || engine.lang === 'off' || narrationVolume() <= 0) {
        onDone();
        return;
      }
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(bus);
      src.onended = () => {
        if (!handle.stopped) onDone();
      };
      handle.source = src;
      playedHistory.push({ lang, clipId, at: performance.now() });
      try {
        src.start();
      } catch {
        onDone();
      }
    };

    const cached = buffers.get(`${lang}/${clipId}`);
    if (cached) {
      startWithBuffer(cached);
    } else {
      loadBuffer(lang, clipId).then(startWithBuffer);
    }
    return handle;
  }

  function stopClip(handle) {
    if (!handle) return;
    handle.stopped = true;
    if (handle.source) {
      try { handle.source.stop(); } catch {}
      handle.source = null;
    }
  }

  const engine = createNarrationEngine({
    lang: narrationLang(),
    getEnabled: () => soundEnabled() && narrationVolume() > 0,
    playClip,
    stopClip,
    onDuck: setNarrationDuck,
  });

  const unsubLang = onNarrationLangChange((next) => {
    engine.setLang(next);
    if (matchStarted && next !== 'off') prefetchLanguage(next);
  });
  const unsubAudio = onAudioChange(({ enabled, narrationVolume: vol }) => {
    if (!enabled || vol <= 0) engine.stop();
  });

  const api = {
    beginMatch() {
      if (matchStarted) return;
      matchStarted = true;
      if (engine.lang !== 'off') prefetchLanguage(engine.lang);
    },
    handleEvents(events, match) {
      if (!matchStarted && events?.some((e) => e.type === 'kickoff')) api.beginMatch();
      engine.handleEvents(events, { match, teams, localTeam, isLocal2P });
    },
    observeMatch(match) {
      if (!matchStarted) return;
      engine.observeMatch(match);
    },
    resetMatch() {
      engine.resetMatch();
    },
    stop() {
      engine.stop();
    },
    dispose() {
      engine.stop();
      prefetchRunId++;
      unsubLang();
      unsubAudio();
    },
    getStats() {
      return {
        lang: engine.lang,
        matchStarted,
        loadedCount: buffers.size,
        fetchedCount: fetchedUrls.size,
        fetchedUrls: [...fetchedUrls],
        played: playedHistory.slice(),
        active: engine.active,
      };
    },
  };
  lastBrowserNarration = api;
  return api;
}
