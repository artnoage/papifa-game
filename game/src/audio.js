// Procedural sound effects + narration audio bus with ducking. Start the audio context on a user gesture.
import { readPreference, savePreference } from './preferences.js';
let ctx = null, master = null, sfxBus = null, narrationBus = null, worldBus = null, cameoBus = null;
let cameoDucked = false;
const CAMEO_DUCK = 0.1;   // while a cameo speaks, every other sound plays at 10%
let enabled = readPreference('sound.v2') !== 'off';
let ducked = false;
let narrVol = (() => {
  // A missing preference is null, and Number(null) is 0: check for it first, or new players start silent.
  const saved = readPreference('narrationVol.v2');
  const raw = saved === null || saved === '' ? NaN : Number(saved);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0.85;
})();
const listeners = new Set();

export function soundEnabled() { return enabled; }
export function setSoundEnabled(value) {
  enabled = Boolean(value);
  if (master) master.gain.value = enabled ? 0.5 : 0;
  savePreference('sound.v2', enabled ? 'on' : 'off');
  for (const fn of listeners) fn({ enabled, narrationVolume: narrVol });
}

export function narrationVolume() { return narrVol; }
export function setNarrationVolume(value) {
  const clamped = Math.max(0, Math.min(1, Number(value)));
  if (!Number.isFinite(clamped)) return;
  narrVol = Math.round(clamped * 100) / 100;
  if (narrationBus) narrationBus.gain.value = narrVol * 1.6;
  if (cameoBus) cameoBus.gain.value = narrVol * 1.6;
  savePreference('narrationVol.v2', String(narrVol));
  for (const fn of listeners) fn({ enabled, narrationVolume: narrVol });
}

export function onAudioChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAudioContext() { return ctx; }
export function getNarrationBus() { return narrationBus; }
// Cameo voice lines bypass the world bus, so they stay at full voice volume while everything else is ducked.
export function getCameoBus() { return cameoBus; }

export function setCameoDuck(active) {
  const next = Boolean(active);
  if (cameoDucked === next) return;
  cameoDucked = next;
  if (!ctx || !worldBus) return;
  const target = cameoDucked ? CAMEO_DUCK : 1.0;
  try {
    worldBus.gain.setTargetAtTime(target, ctx.currentTime, cameoDucked ? 0.03 : 0.2);
  } catch {
    worldBus.gain.value = target;
  }
}

export function setNarrationDuck(active) {
  const next = Boolean(active);
  if (ducked === next) return;
  ducked = next;
  if (!ctx || !sfxBus) return;
  const target = ducked ? 0.42 : 1.0;
  const tc = ducked ? 0.05 : 0.14;
  try {
    sfxBus.gain.setTargetAtTime(target, ctx.currentTime, tc);
  } catch {
    sfxBus.gain.value = target;
  }
}

export function startAudio() {
  const Audio = window.AudioContext || window.webkitAudioContext;
  if (!Audio) return;
  if (!ctx) {
    try { ctx = new Audio(); } catch { return; }
    master = ctx.createGain();
    master.gain.value = enabled ? 0.5 : 0;
    master.connect(ctx.destination);
    worldBus = ctx.createGain();
    worldBus.gain.value = cameoDucked ? CAMEO_DUCK : 1.0;
    worldBus.connect(master);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = ducked ? 0.42 : 1.0;
    sfxBus.connect(worldBus);
    narrationBus = ctx.createGain();
    narrationBus.gain.value = narrVol * 1.6;
    narrationBus.connect(worldBus);
    cameoBus = ctx.createGain();
    cameoBus.gain.value = narrVol * 1.6;
    cameoBus.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function initAudio() {
  addEventListener('keydown', startAudio, { once: true });
  addEventListener('pointerdown', startAudio, { once: true });
  addEventListener('keydown', (e) => { if (e.code === 'KeyM' && !e.repeat) setSoundEnabled(!enabled); });
}

function noise(seconds) {
  const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function env(node, t, peak, attack, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  node.connect(g);
  return g;
}

// Leather thump: a low sine drop plus a short filtered click. `power` 0..1.
function kick(power = 0.6, volume = 1) {
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  o.frequency.setValueAtTime(140 + 60 * power, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
  env(o, t, (0.5 + 0.5 * power) * volume, 0.003, 0.14).connect(sfxBus);
  o.start(t); o.stop(t + 0.2);
  const n = noise(0.05), f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 1800; n.connect(f);
  env(f, t, (0.25 * power + 0.1) * volume, 0.001, 0.04).connect(sfxBus);
  n.start(t);
}

// Referee whistle: two-tone trill. `blasts` short blasts (3 = full time).
function whistle(blasts = 1) {
  for (let i = 0; i < blasts; i++) {
    const t = ctx.currentTime + i * 0.38, len = blasts > 1 && i === blasts - 1 ? 0.7 : 0.28;
    const o = ctx.createOscillator(), lfo = ctx.createOscillator(), lg = ctx.createGain();
    o.type = 'square'; o.frequency.value = 2900;
    lfo.frequency.value = 32; lg.gain.value = 140; lfo.connect(lg); lg.connect(o.frequency);
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 2900; f.Q.value = 6; o.connect(f);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.02);
    g.gain.setValueAtTime(0.18, t + len - 0.04); g.gain.linearRampToValueAtTime(0, t + len);
    f.connect(g); g.connect(sfxBus);
    o.start(t); lfo.start(t); o.stop(t + len); lfo.stop(t + len);
  }
}

// Crowd: band-passed noise swelling and fading. `size` 0..1.
function crowd(size = 1, seconds = 2.5) {
  const t = ctx.currentTime, n = noise(seconds), f = ctx.createBiquadFilter();
  f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.7; n.connect(f);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.35 * size, t + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  f.connect(g); g.connect(sfxBus);
  n.start(t);
}

// Prayer chimes: warm ascending golden triad (Jesus), serene celestial fifth (Mary), crystalline deflect, clash swell.
function chime(freqs, peak = 0.16, decay = 0.9, stagger = 0.06, type = 'triangle') {
  const now = ctx.currentTime;
  freqs.forEach((freq, i) => {
    const t = now + i * stagger;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    env(o, t, peak, 0.02, decay).connect(sfxBus);
    o.start(t); o.stop(t + decay + 0.05);
  });
}

// Map simulation events to sounds.
export function playEvents(events) {
  if (!ctx) return;
  for (const e of events) {
    if (e.type === 'kick') kick(e.jesus ? 1.0 : 0.9);
    else if (e.type === 'pass') kick(0.4);
    else if (e.type === 'knock') kick(0.12, 0.32);
    else if (e.type === 'steal') kick(0.25);
    else if (e.type === 'catch' || e.type === 'parry') { kick(0.5); crowd(0.35, 1.2); }
    else if (e.type === 'goal') { crowd(1, 3); whistle(1); if (e.jesus) chime([523.25, 659.25, 783.99, 1046.5], 0.14, 1.1, 0.045); }
    else if (e.type === 'kickoff') whistle(1);
    else if (e.type === 'fulltime') whistle(3);
    else if (e.type === 'prayer') {
      if (e.kind === 'jesus') chime([440, 554.37, 659.25, 880], 0.15, 0.95, 0.055, 'triangle');
      else if (e.kind === 'george') chime([392, 523.25, 659.25, 783.99, 1046.5], 0.14, 0.85, 0.045, 'sawtooth');
      else chime([392, 587.33, 783.99, 987.77], 0.13, 1.15, 0.07, 'sine');
    } else if (e.type === 'maryBlock') {
      chime([880, 1174.66, 1567.98], 0.16, 0.75, 0.025, 'sine');
      crowd(0.3, 1.0);
    } else if (e.type === 'clash') {
      chime([392, 493.88, 587.33, 783.99, 987.77], 0.18, 1.4, 0.04, 'triangle');
      crowd(0.6, 2.0);
    }
  }
}
