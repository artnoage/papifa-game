// Pure deterministic cameo selection, hashing, and lifecycle engine (zero Three.js / DOM dependencies).
// Importable in both Node unit tests and browser runtime (`cameo.js`).
import { STRONG_CATCH_SPEED } from './sim.js';

// Chance that a trigger shows its cameo: ordinary goal 1 in 3; 4th+ goal (#4) & strong held catch (#2) every time.
export const CAMEO_PROB = { petsokopses: 1 / 3, ante_geia: 1, karvouno: 1 };
export const CAMEO_MIN_S = 3.15;
export const CAMEO_MAX_S = 4.2;
export const CAMEO_ENTER_S = 0.22;
export const CAMEO_EXIT_S = 0.24;

export const CAMEO_SPECS = {
  petsokopses: {
    id: 'petsokopses',
    glb: 'assets/cameos/petsokopses.glb',
    audio: {
      el: 'assets/cameos/audio/petsokopses_el.mp3',
      en: 'assets/cameos/audio/petsokopses_en.mp3',
    },
    camX: 0.12,
    camY: 1.24,
    camZ: 1.84,
    targetY: 1.19,
    fov: 38,
  },
  ante_geia: {
    id: 'ante_geia',
    glb: 'assets/cameos/ante_geia.glb',
    audio: {
      el: 'assets/cameos/audio/ante_geia_el.mp3',
      en: 'assets/cameos/audio/ante_geia_en.mp3',
    },
    camX: 0.09,
    camY: 1.26,
    camZ: 2.24,
    targetY: 1.19,
    fov: 38,
  },
  karvouno: {
    id: 'karvouno',
    glb: 'assets/cameos/karvouno.glb',
    audio: {
      el: 'assets/cameos/audio/karvouno_el.mp3',
      en: 'assets/cameos/audio/karvouno_en.mp3',
    },
    camX: 0.08,
    camY: 1.24,
    camZ: 1.88,
    targetY: 1.18,
    fov: 38,
  },
};

// Language rule: narration set to English -> English line; Greek or Off -> Greek line.
export function cameoAudioLang(langPref = 'el') {
  return langPref === 'en' ? 'en' : 'el';
}

// Pure deterministic 32-bit hash in [0, 1) from match seed + event tick + event index + cameo id.
// Never touches sim's m.rand() or Math.random().
export function cameoHash01(seed, tick, eventIndex, cameoId = '') {
  let h = 2166136261 >>> 0;
  const mix = (v) => {
    h ^= (v | 0) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  };
  mix(seed | 0);
  mix(tick | 0);
  mix(eventIndex | 0);
  for (let i = 0; i < cameoId.length; i++) mix(cameoId.charCodeAt(i));
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function isStrongCatchEvent(e) {
  if (!e || e.type !== 'catch') return false;
  if (e.kind === 'strong' || e.kind === 'strong_cameo') return true;
  return typeof e.speed === 'number' && Number.isFinite(e.speed) && e.speed >= STRONG_CATCH_SPEED;
}

export function cameoForEvent(e, match = null) {
  if (!e || (e.team !== 0 && e.team !== 1)) return null;
  if (e.type === 'goal') {
    // Priority #1: 4th, 5th, and later goals by a team -> #4 in the CONCEDING team's corner, every time.
    if (e.kind === 'karvouno' || (match?.score?.[e.team] ?? 0) > 3) {
      return { id: 'karvouno', team: 1 - e.team };
    }
    return { id: 'petsokopses', team: e.team };
  }
  if (isStrongCatchEvent(e)) return { id: 'ante_geia', team: e.team };
  return null;
}

export function createCameoEngine({
  prob = CAMEO_PROB,
  now = () => performance.now() / 1000,
  getLang = () => 'el',
  isGuest = false,
  onStart = () => {},
  onStop = () => {},
} = {}) {
  let active = null;
  let forceProb = null;
  let eventCounter = 0;
  let lastSeed = 0;

  function effectiveProb(id) {
    if (typeof forceProb === 'number' && Number.isFinite(forceProb)) {
      return Math.max(0, Math.min(1, forceProb));
    }
    return typeof prob === 'number' ? prob : (prob[id] ?? 0);
  }

  function resetMatch(seed = 0) {
    lastSeed = seed | 0;
    eventCounter = 0;
    stop();
  }

  function stop() {
    if (!active) return;
    const prev = active;
    active = null;
    onStop(prev);
  }

  function tick() {
    if (!active) return null;
    const age = now() - active.startedAt;
    if (age >= active.duration) {
      stop();
      return null;
    }
    return active;
  }

  function notifyAudioDuration(sec) {
    if (!active || !Number.isFinite(sec) || sec <= 0) return;
    active.duration = Math.max(CAMEO_MIN_S, Math.min(CAMEO_MAX_S, sec + 0.55));
  }

  function handleEvents(events, match) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const seed = match?.seed ?? lastSeed;
    if (match && typeof match.seed === 'number' && match.seed !== lastSeed) {
      lastSeed = match.seed | 0;
    }
    const tickNum = Math.round((match?.t ?? 0) * 60);
    const triggered = [];

    tick();

    for (const e of events) {
      const candidate = cameoForEvent(e, match);
      if (!candidate) continue;
      const idx = eventCounter++;
      if (active) continue;

      let shouldFire = false;
      if (isGuest) {
        shouldFire = (e.type === 'goal' && (e.kind === 'cameo' || e.kind === 'karvouno'))
          || (e.type === 'catch' && e.kind === 'strong_cameo');
      } else {
        const p = effectiveProb(candidate.id);
        const u = cameoHash01(seed, tickNum, idx, candidate.id);
        shouldFire = p >= 1 ? true : p <= 0 ? false : u < p;
      }

      if (!shouldFire) continue;

      if (!isGuest) {
        if (e.type === 'goal') e.kind = candidate.id === 'karvouno' ? 'karvouno' : 'cameo';
        else if (e.type === 'catch') e.kind = 'strong_cameo';
      }

      const lang = cameoAudioLang(getLang());
      active = {
        id: candidate.id,
        team: candidate.team,
        lang,
        startedAt: now(),
        duration: 3.25,
        eventType: e.type,
      };
      onStart(active);
      triggered.push(active);
    }
    return triggered;
  }

  return {
    handleEvents,
    tick,
    stop,
    resetMatch,
    notifyAudioDuration,
    setForceProb(p) {
      forceProb = (p === null || p === undefined) ? null : Math.max(0, Math.min(1, Number(p)));
    },
    getForceProb: () => forceProb,
    getActive: () => active,
  };
}
