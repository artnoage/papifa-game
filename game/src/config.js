// Tunables. Units are metres and seconds. The pitch is small on purpose (arcade).
// PITCH is the 3 v 3 pitch and the base the formations are written for; 5 v 5 plays on a pitch 30% longer
// and wider (73 x 44). Goals and boxes keep their size. Use the match's own m.pitch, never PITCH, for sizes.
export const PITCH = { length: 56, width: 34, goalWidth: 7.3, goalHeight: 2.44, goalDepth: 2.2, boxDepth: 9, boxWidth: 18 };
export const SIZES = [3, 5];
export const pitchFor = (size) => (size === 5 ? { ...PITCH, length: 73, width: 44 } : { ...PITCH });
// Which roster slots play in each mode (slot numbers keep their roles: 0 keeper, 1 defender, 4 striker).
export const SQUADS = { 3: [0, 1, 4], 5: [0, 1, 2, 3, 4] };
// visualScale enlarges the drawn priests only (the sim's sizes and speeds are unchanged).
export const PLAYER = { radius: 0.5, speed: 6.0, sprint: 8.4, accel: 28, turnRate: 10, dribbleOffset: 0.75, visualScale: 1.15 };
// Stamina (0..1, per priest): sprinting drains it (~9 s from full), running refills it in ~7 s, standing
// faster. Below 'tired' the sprint fades towards running pace; empty, there's no sprint at all.
export const STAMINA = { drain: 1 / 9, regenRun: 1 / 7, regenIdle: 1 / 3.5, tired: 0.35, knock: 0.12, slide: 0.1, aiReserve: 0.25, attackRuns: false };
// visualRadius is the drawn ball; radius is the sim's (balance is tuned on it).
export const BALL = { radius: 0.3, visualRadius: 0.22, rollFriction: 1.0, airDrag: 0.15, gravity: 20, bounce: 0.5, wallBounce: 0.65, pickupRadius: 0.95 };
export const MATCH = { seconds: 180, celebrate: 2.2 };
// Prayers (v4 + Task H): 2 per team per match (any mix of Jesus, Mary, and St George), 2.0 s charge, 0.5 s drain, 15 s active.
export const PRAYER = {
  maxPerMatch: 2,
  // Prayer slots each blessing uses up: Jesus is strong enough to take both.
  cost: { jesus: 2, mary: 1, george: 1 },
  chargeTime: 2.0,
  drainTime: 0.5,
  duration: 15,
  clashHold: 0.6,
  maryRebound: 0.4,
  jesusSpeed: 34,
  georgeSpeedBoost: 1.30,
  ai: {
    veryEasy: { maxUses: 1, startDelay: 48, cooldown: 100, checkInterval: 3.0, jesusRate: 0.12, georgeRate: 0.12, maryRate: 0.004, poorTiming: true },
    easy:     { startDelay: 32, cooldown: 70,  checkInterval: 2.2, jesusRate: 0.09, georgeRate: 0.09, maryRate: 0.11,  jesusX: 0.08, maryThreat: 25 },
    normal:   { startDelay: 22, cooldown: 58,  checkInterval: 1.8, jesusRate: 0.16, georgeRate: 0.16, maryRate: 0.18,  jesusX: 0.20, maryThreat: 22 },
    hard:     { startDelay: 10, cooldown: 32,  checkInterval: 0.6, jesusRate: 0.85, georgeRate: 0.85, maryRate: 0.85,  jesusX: 0.33, maryThreat: 18 },
  },
};
// AI difficulty. createMatch(seed, { level: 'veryEasy' | 'easy' | 'normal' | 'hard' | 'veryHard', ai: [{...}, {...}] })
// picks a level for both teams; `ai` overrides single knobs per team (e.g. a weaker CPU side against a human).
export const AI_LEVELS = {
  //          decision interval (s), utility noise, pressing, sweeper, man-marking, cover man, through balls, shot threshold,
  //          keeper care (how much room he insists on before releasing; your own keeper always plays at hard),
  //          plus optional handicaps (defaulting to neutral for Hard): slide, speed, tackle, gkSave, boxRoom.
  veryEasy: { reaction: 0.9,  noise: 0.6,  press: 0.08, sweep: 0, mark: 0, cover: 0, through: 0, chip: 0, shotMin: 0.38, gkCare: 0.1, slide: 0.12, speed: 0.66, tackle: 0.38, gkSave: 0.35, boxRoom: 2.8, shotSkill: 0.85, pray: 'veryEasy' },
  easy:     { reaction: 0.5,  noise: 0.4,  press: 0.3,  sweep: 0, mark: 0, cover: 0, through: 0, shotMin: 0.3,  gkCare: 0.2, speed: 0.90, pray: 'easy' },
  normal:   { reaction: 0.5,  noise: 0.35, press: 0.3,  sweep: 1, mark: 0, cover: 0, through: 1, shotMin: 0.33, gkCare: 0.35, speed: 0.95, pray: 'normal' },
  hard:     { reaction: 0.22, noise: 0.1,  press: 1,    sweep: 1, mark: 1, cover: 1, through: 1, shotMin: 0.18, gkCare: 1, speed: 1, pray: 'hard' },
  veryHard: { reaction: 0.15, noise: 0.05, press: 1,    sweep: 1, mark: 1, cover: 1, through: 1, shotMin: 0.18, gkCare: 1, speed: 1.05, tackle: 1.15, gkSave: 1.15, pray: 'hard' },
};
export const AI = AI_LEVELS.hard;

// Normalize case and separators (e.g. ?level=veryEasy, ?level=veryeasy, ?level=HARD) to a canonical AI_LEVELS key.
export function resolveLevel(value, fallback = 'normal') {
  if (typeof value !== 'string') return fallback;
  if (Object.hasOwn(AI_LEVELS, value)) return value;
  const norm = value.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return Object.keys(AI_LEVELS).find((k) => k.toLowerCase() === norm) ?? fallback;
}

// Clip names the game asks for; the Blender rig must export clips with these names (see docs/rig-spec.md).
export const CLIPS = ['idle', 'run', 'sprint', 'pass', 'kick', 'tackle', 'stunned', 'dive', 'celebrate'];
// Fallback ground speeds (m/s) the run/sprint clips were authored at; a GLB overrides them per clip via animation extras.refSpeed.
export const CLIP_REF_SPEED = { run: 4.5, sprint: 7.5 };

// Roster v1 (see the roster plan). Stats are multipliers. Order matches FORMATION slots.
export const ROSTER = [
  { id: 'luka',     name: 'Father Luka',      role: 'GK', speed: 0.85, power: 1.0, tackle: 1.0, look: { hat: 'kamilavka', hatColor: 0x5b2a6e, beard: 0.6, girth: 1.35, height: 1.0,  cross: 0.55 } },
  { id: 'giorgis',  name: 'Papa Giorgis',     role: 'DF', speed: 0.9,  power: 1.15, tackle: 1.35, look: { hat: 'kalimavkion', hatColor: 0x151515, beard: 1.0, girth: 1.15, height: 1.02, cross: 0.7 } },
  { id: 'seraphim', name: 'Brother Seraphim', role: 'ML', speed: 1.0,  power: 1.0, tackle: 1.0, look: { hat: 'koukoulion', hatColor: 0x0c0c0c, beard: 0.55, girth: 0.82, height: 1.15, cross: 0.4 } },
  { id: 'ioannis',  name: 'Vladyka Ioannis',  role: 'MR', speed: 0.95, power: 1.1, tackle: 0.9, look: { hat: 'mitre', hatColor: 0xd9a92b, beard: 0.7, girth: 1.0, height: 1.0, cross: 0.6 } },
  { id: 'nikolai',  name: 'Diakon Nikolai',   role: 'FW', speed: 1.12, power: 1.05, tackle: 0.85, look: { hat: 'skufia', hatColor: 0x1a1a1a, beard: 0.15, girth: 0.9, height: 1.05, cross: 0.35 } },
];

export const REFEREE = {
  id: 'patriarch', name: 'The Patriarch',
  look: { hat: 'kalimavkion', hatColor: 0xf6f1df, robe: 0xeee8d6, trim: 0x753a48, beard: 1.0, girth: 0.9, height: 1.05, cross: 0.65 },
};

// Base positions for a team attacking +x (x along the pitch, z across), on the 56 x 34 base pitch; the sim
// scales them to the match's pitch. FORMATION is the 5 v 5 shape; FORMATIONS[3] the 3 v 3 one, by slot.
export const FORMATION = [
  { x: -25.5, z: 0 },   // GK
  { x: -15,   z: 0 },   // DF
  { x: -6,    z: -9 },  // ML
  { x: -6,    z: 9 },   // MR
  { x: 3,     z: 0 },   // FW
];
export const FORMATIONS = {
  5: FORMATION,
  3: { 0: FORMATION[0], 1: { x: -12, z: -5 }, 4: { x: 0, z: 5 } },
};

export const TEAMS = [
  { id: 'gold', kit: 'home', name: 'Gold Cross', robe: 0x16161a, trim: 0xd9a92b, ring: 0xffc83d },
  { id: 'blue', kit: 'away', name: 'Blue Dome',  robe: 0xe9e2d0, trim: 0x2f6fb0, ring: 0x3d9bff, kitHue: Math.PI },
];

// Array positions always refer to simulation sides. Kit choice only changes their appearance.
export function teamsForKit(value) {
  return ['blue', 'away', 'blue-dome'].includes(value?.toLowerCase()) ? [TEAMS[1], TEAMS[0]] : TEAMS;
}
