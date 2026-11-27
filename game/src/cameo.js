// Browser 3D TV picture-in-picture cameo overlay & WebAudio AnalyserNode runtime lip-sync (Task G).
// Pure deterministic trigger/hash logic lives in cameo-core.js so Node unit tests import it without Three.js.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  CAMEO_ENTER_S, CAMEO_EXIT_S, CAMEO_PROB, CAMEO_SPECS,
  cameoAudioLang, cameoForEvent, cameoHash01, createCameoEngine, isStrongCatchEvent,
} from './cameo-core.js';
import { getAudioContext, getCameoBus, setCameoDuck, soundEnabled, startAudio } from './audio.js';
import { narrationLang } from './narration.js';

export { CAMEO_PROB, CAMEO_SPECS, cameoAudioLang, cameoForEvent, cameoHash01, createCameoEngine, isStrongCatchEvent };

const STUDIO_THEMES = {
  // Moody late-night bar / cinema dark charcoal-amber spotlight (#1).
  petsokopses: { inner: '#332922', mid: '#1c181a', outer: '#0e0d11', sheen: 'rgba(255,214,158,0.08)' },
  // Late-night sports TV dark navy-indigo studio spotlight (#2).
  ante_geia: { inner: '#1f3b68', mid: '#122240', outer: '#091124', sheen: 'rgba(130,195,255,0.09)' },
  // Dramatic warm 1970s cinema inquiry spotlight (#4).
  karvouno: { inner: '#422c1f', mid: '#261812', outer: '#110a08', sheen: 'rgba(255,204,142,0.10)' },
};

function createStudioTexture(theme) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  const rad = g.createRadialGradient(64, 46, 8, 64, 60, 88);
  rad.addColorStop(0, theme.inner);
  rad.addColorStop(0.55, theme.mid);
  rad.addColorStop(1, theme.outer);
  g.fillStyle = rad;
  g.fillRect(0, 0, 128, 128);
  // Subtle top studio key sheen + gentle lower framing vignette so the waist sits naturally inside the TV inset.
  const sheen = g.createLinearGradient(0, 0, 0, 128);
  sheen.addColorStop(0, theme.sheen);
  sheen.addColorStop(0.35, 'rgba(0,0,0,0)');
  sheen.addColorStop(0.78, 'rgba(0,0,0,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = sheen;
  g.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Build a normalized [-1, 1] x [-1, 1] rounded rectangle ShapeGeometry matching CSS border-radius.
function buildRoundedRectGeometry(rx, ry, segments = 8) {
  const s = new THREE.Shape();
  const x0 = -1, y0 = -1, x1 = 1, y1 = 1;
  const crx = Math.min(0.45, Math.max(0.01, rx));
  const cry = Math.min(0.45, Math.max(0.01, ry));
  s.moveTo(x0 + crx, y0);
  s.lineTo(x1 - crx, y0);
  s.absellipse(x1 - crx, y0 + cry, crx, cry, -Math.PI / 2, 0, false, 0);
  s.lineTo(x1, y1 - cry);
  s.absellipse(x1 - crx, y1 - cry, crx, cry, 0, Math.PI / 2, false, 0);
  s.lineTo(x0 + crx, y1);
  s.absellipse(x0 + crx, y1 - cry, crx, cry, Math.PI / 2, Math.PI, false, 0);
  s.lineTo(x0, y0 + cry);
  s.absellipse(x0 + crx, y0 + cry, crx, cry, Math.PI, Math.PI * 1.5, false, 0);
  return new THREE.ShapeGeometry(s, segments);
}

function applyStencilClip(mat) {
  mat.stencilWrite = true;
  mat.stencilRef = 1;
  mat.stencilFunc = THREE.EqualStencilFunc;
  mat.stencilFail = THREE.KeepStencilOp;
  mat.stencilZFail = THREE.KeepStencilOp;
  mat.stencilZPass = THREE.KeepStencilOp;
}

function sampleBufferRms(buf, timeSec) {
  if (!buf || !buf.length || timeSec < 0 || timeSec >= buf.duration) return 0;
  const sr = buf.sampleRate;
  const data = buf.getChannelData(0);
  const center = Math.floor(timeSec * sr);
  const half = Math.floor(sr * 0.025);
  const i0 = Math.max(0, center - half);
  const i1 = Math.min(data.length, center + half);
  if (i1 <= i0) return 0;
  let sum = 0;
  const stride = Math.max(1, Math.floor((i1 - i0) / 128));
  let n = 0;
  for (let i = i0; i < i1; i += stride) {
    const s = data[i];
    sum += s * s;
    n++;
  }
  return n > 0 ? Math.sqrt(sum / n) : 0;
}

export function createCameoOverlay(root, { isGuest = false } = {}) {
  let layer = root.querySelector('#cameo-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'cameo-layer';
    layer.setAttribute('aria-hidden', 'true');
    root.append(layer);
  }
  layer.innerHTML = '';

  const slots = [0, 1].map((team) => {
    const el = document.createElement('div');
    el.id = `cameo-slot-${team}`;
    el.className = 'cameo-slot';
    el.dataset.team = String(team);
    el.hidden = true;
    layer.append(el);
    return el;
  });

  // 1) Stencil-mask pass + opaque studio backdrop pass (clips both backdrop and 3D character cleanly to the rounded TV PiP!).
  const maskCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  maskCam.position.z = 1;
  const maskScene = new THREE.Scene();
  const maskMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    colorWrite: false,
    depthWrite: false,
    depthTest: false,
    stencilWrite: true,
    stencilRef: 1,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.ReplaceStencilOp,
    stencilZFail: THREE.ReplaceStencilOp,
    stencilZPass: THREE.ReplaceStencilOp,
  });
  let maskKey = '';
  const maskMesh = new THREE.Mesh(buildRoundedRectGeometry(0.14, 0.14), maskMat);
  maskScene.add(maskMesh);

  const bgScene = new THREE.Scene();
  const studioTextures = {
    petsokopses: createStudioTexture(STUDIO_THEMES.petsokopses),
    ante_geia: createStudioTexture(STUDIO_THEMES.ante_geia),
    karvouno: createStudioTexture(STUDIO_THEMES.karvouno),
  };
  const bgMat = new THREE.MeshBasicMaterial({
    map: studioTextures.petsokopses,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  applyStencilClip(bgMat);
  const bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bgScene.add(bgQuad);

  // 2) Dedicated lightweight 3D character scene rendered only when a cameo is active (zero idle cost!).
  const cameoScene = new THREE.Scene();
  const hemi = new THREE.HemisphereLight(0xfffaf0, 0x3b4d3e, 1.55);
  const key = new THREE.DirectionalLight(0xfff5e4, 1.65);
  key.position.set(1.2, 2.2, 2.6);
  const fill = new THREE.DirectionalLight(0xd8e8ff, 0.72);
  fill.position.set(-1.6, 1.4, 2.0);
  const rim = new THREE.DirectionalLight(0xffe9c2, 1.05);
  rim.position.set(0.0, 2.0, -2.4);
  cameoScene.add(hemi, key, fill, rim);

  const cameoCamera = new THREE.PerspectiveCamera(38, 1, 0.1, 20);
  const loader = new GLTFLoader();

  const models = new Map();
  const modelPromises = new Map();
  const audioRawCache = new Map();
  const audioBufCache = new Map();

  let preloaded = false;
  let audioSource = null;
  let analyser = null;
  let timeDomainBuf = null;
  let activeAudioBuffer = null;
  let audioStartedAt = 0;
  let audioPlayedCount = 0;
  let lastAudioUrl = null;
  let smoothedMouth = 0;
  let renderFrames = 0;
  let activeEntry = null;

  function loadModel(id) {
    if (modelPromises.has(id)) return modelPromises.get(id);
    const spec = CAMEO_SPECS[id];
    if (!spec) return Promise.resolve(null);
    const p = loader.loadAsync(spec.glb).then((gltf) => {
      const group = new THREE.Group();
      group.name = `cameo_${id}`;
      group.visible = false;
      const model = gltf.scene;
      const mouthMeshes = [];
      model.traverse((o) => {
        if (!o.isMesh) return;
        if (o.isSkinnedMesh) o.frustumCulled = false;
        const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of mats) {
          m.toneMapped = false;
          applyStencilClip(m);
          m.needsUpdate = true;
        }
        if (o.morphTargetDictionary && o.morphTargetInfluences) {
          const mIdx = o.morphTargetDictionary.mouthOpen;
          const bIdx = o.morphTargetDictionary.browFrown;
          if (mIdx !== undefined || bIdx !== undefined) {
            mouthMeshes.push({ mesh: o, mouthIdx: mIdx, browIdx: bIdx });
          }
        }
      });
      group.add(model);
      cameoScene.add(group);
      const mixer = new THREE.AnimationMixer(model);
      const clip = gltf.animations.find((c) => c.name === 'cameo') || gltf.animations[0] || null;
      const action = clip ? mixer.clipAction(clip) : null;
      if (action) action.setLoop(THREE.LoopRepeat, Infinity);
      const rec = { group, model, mixer, action, mouthMeshes, spec };
      models.set(id, rec);
      if (activeEntry && activeEntry.id === id) activateModelVisual(rec);
      return rec;
    }).catch(() => null);
    modelPromises.set(id, p);
    return p;
  }

  function fetchAudioBytes(url) {
    if (audioRawCache.has(url)) return audioRawCache.get(url);
    const p = fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
    audioRawCache.set(url, p);
    return p;
  }

  function preload() {
    if (preloaded) return;
    preloaded = true;
    const lang = cameoAudioLang(narrationLang());
    for (const spec of Object.values(CAMEO_SPECS)) {
      loadModel(spec.id);
      fetchAudioBytes(spec.audio[lang]);
    }
  }

  function stopAudio() {
    if (audioSource) {
      try { audioSource.onended = null; audioSource.stop(); } catch {}
      try { audioSource.disconnect(); } catch {}
      audioSource = null;
    }
    if (analyser) {
      try { analyser.disconnect(); } catch {}
      analyser = null;
    }
    activeAudioBuffer = null;
    setCameoDuck(false);
  }

  function activateModelVisual(rec) {
    for (const m of models.values()) m.group.visible = false;
    rec.group.visible = true;
    rec.group.position.set(0, 0, 0);
    rec.group.scale.setScalar(1);
    if (rec.action) {
      rec.action.reset();
      rec.action.play();
    }
    rec.mixer.update(0);
  }

  function startPlaybackAudio(entry) {
    stopAudio();
    const spec = CAMEO_SPECS[entry.id];
    const url = spec?.audio?.[entry.lang] ?? spec?.audio?.el;
    if (!url) return;
    lastAudioUrl = url;
    audioStartedAt = performance.now() / 1000;

    startAudio();
    const ctx = getAudioContext();
    const bus = getCameoBus();
    const token = entry;

    fetchAudioBytes(url).then(async (raw) => {
      if (!raw || activeEntry !== token || !ctx) return;
      let buf = audioBufCache.get(url);
      if (!buf) {
        try {
          buf = await ctx.decodeAudioData(raw.slice(0));
          audioBufCache.set(url, buf);
        } catch {
          return;
        }
      }
      if (activeEntry !== token) return;
      activeAudioBuffer = buf;
      engine.notifyAudioDuration(buf.duration);

      if (!soundEnabled() || !bus) return;
      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch {}
      }
      if (activeEntry !== token || !soundEnabled()) return;

      const src = ctx.createBufferSource();
      src.buffer = buf;
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.55;
      timeDomainBuf = new Uint8Array(an.fftSize);
      src.connect(an);
      an.connect(bus);
      audioSource = src;
      analyser = an;
      audioStartedAt = performance.now() / 1000;
      audioPlayedCount++;
      setCameoDuck(true);
      src.onended = () => {
        if (audioSource === src) {
          audioSource = null;
          setCameoDuck(false);
        }
      };
      try { src.start(0); } catch {
        setCameoDuck(false);
      }
    });
  }

  function clearSlotStyles(el) {
    el.style.top = '';
    el.style.width = '';
    el.style.height = '';
    el.style.transform = '';
    el.style.opacity = '';
  }

  const engine = createCameoEngine({
    isGuest,
    getLang: () => narrationLang(),
    onStart(entry) {
      activeEntry = entry;
      smoothedMouth = 0;
      const slot = slots[entry.team];
      const other = slots[1 - entry.team];
      other.hidden = true;
      clearSlotStyles(other);
      delete other.dataset.active;
      clearSlotStyles(slot);
      slot.hidden = false;
      slot.dataset.active = 'true';
      slot.dataset.cameo = entry.id;
      slot.dataset.lang = entry.lang;

      const cached = models.get(entry.id);
      if (cached) activateModelVisual(cached);
      else loadModel(entry.id);

      startPlaybackAudio(entry);
    },
    onStop() {
      activeEntry = null;
      smoothedMouth = 0;
      stopAudio();
      for (const m of models.values()) m.group.visible = false;
      for (const el of slots) {
        el.hidden = true;
        clearSlotStyles(el);
        delete el.dataset.active;
        delete el.dataset.cameo;
        delete el.dataset.lang;
      }
    },
  });

  function readLiveMouthLevel(ageSec) {
    let rms = 0;
    if (analyser && timeDomainBuf && audioSource && soundEnabled()) {
      analyser.getByteTimeDomainData(timeDomainBuf);
      let sum = 0;
      for (let i = 0; i < timeDomainBuf.length; i++) {
        const v = (timeDomainBuf[i] - 128) / 128;
        sum += v * v;
      }
      rms = Math.sqrt(sum / timeDomainBuf.length);
    } else if (activeAudioBuffer) {
      rms = sampleBufferRms(activeAudioBuffer, Math.max(0, performance.now() / 1000 - audioStartedAt));
    } else if (ageSec < 2.2) {
      rms = 0.06 + 0.08 * Math.max(0, Math.sin(ageSec * 16) * Math.sin(ageSec * 5.3));
    }
    const target = THREE.MathUtils.clamp((rms - 0.015) / 0.145, 0, 1);
    const rate = target > smoothedMouth ? 0.55 : 0.28;
    smoothedMouth += (target - smoothedMouth) * rate;
    return smoothedMouth;
  }

  // Compute safe PiP layout rect below team's prayer widget & above touch controls, then apply unified pop/slide transform.
  function computeViewportRect(team, slidePx, popScale) {
    const slot = slots[team];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    slot.style.top = '';
    slot.style.width = '';
    slot.style.height = '';
    slot.style.transform = '';
    const r = slot.getBoundingClientRect();
    let top = r.top;
    let height = Math.max(64, r.height || 140);
    let width = Math.max(64, r.width || 140);
    let left = r.left;

    let minTop = 4;
    let maxBottom = vh - 4;
    const prayerEl = document.getElementById(`prayer-${team}`);
    if (prayerEl && !prayerEl.hidden && getComputedStyle(prayerEl).display !== 'none') {
      const pr = prayerEl.getBoundingClientRect();
      if (pr.height > 1) minTop = Math.max(minTop, pr.bottom + 6);
    }
    const touchEl = document.getElementById('touch-controls');
    if (touchEl && !touchEl.hidden && getComputedStyle(touchEl).display !== 'none') {
      const tr = touchEl.getBoundingClientRect();
      if (tr.height > 1) maxBottom = Math.min(maxBottom, tr.top - 6);
    }
    const availH = Math.max(64, maxBottom - minTop);
    if (height > availH) {
      const s = Math.floor(availH);
      height = s;
      width = Math.min(width, s);
      slot.style.width = `${width}px`;
      slot.style.height = `${height}px`;
      if (team === 1) left = vw - width - (vw - r.right);
    }
    if (top < minTop) top = minTop;
    if (top + height > maxBottom) top = Math.max(minTop, maxBottom - height);
    left = Math.max(4, Math.min(vw - width - 4, left));
    if (Math.abs(top - r.top) > 1.5) slot.style.top = `${Math.round(top)}px`;

    // Apply unified pop + slide-in/out transform to the CSS bezel and read its exact transformed screen rect for WebGL!
    if (Math.abs(slidePx) > 0.25 || Math.abs(popScale - 1) > 0.003) {
      slot.style.transform = `translate3d(${slidePx.toFixed(1)}px, 0, 0) scale(${popScale.toFixed(3)})`;
    }
    const tr = slot.getBoundingClientRect();
    const cs = getComputedStyle(slot);
    const borderPx = parseFloat(cs.borderTopWidth) || 2.5;
    const radiusPx = parseFloat(cs.borderTopLeftRadius) || 12;
    // Inset WebGL viewport 1px inside the border so the crisp anti-aliased CSS bezel wraps flush over the edge!
    const inset = Math.max(1, borderPx * 0.5);
    return {
      left: tr.left + inset,
      top: tr.top + inset,
      width: Math.max(2, tr.width - inset * 2),
      height: Math.max(2, tr.height - inset * 2),
      radiusPx: Math.max(2, radiusPx - inset),
      vw,
      vh,
    };
  }

  function renderOn(renderer, dt, hidden = false) {
    if (typeof window !== 'undefined' && window.__papifaCameoForceProb !== undefined) {
      engine.setForceProb(window.__papifaCameoForceProb);
    }

    const cur = engine.tick();
    if (!cur || hidden) {
      if (hidden) {
        for (const el of slots) el.hidden = true;
      }
      return;
    }

    const slot = slots[cur.team];
    if (slot.hidden) slot.hidden = false;

    const rec = models.get(cur.id);
    if (!rec) return;

    const age = Math.max(0, performance.now() / 1000 - cur.startedAt);
    const rem = Math.max(0, cur.duration - age);

    // Unified pop + gentle slide-in/out (keeps PiP cleanly on-screen throughout enter/exit!).
    let pop = 1;
    let slidePx = 0;
    let alpha = 1;
    const dir = cur.team === 0 ? -1 : 1;
    const maxSlide = window.innerWidth <= 540 ? 4 : 10;
    if (age < CAMEO_ENTER_S) {
      const u = age / CAMEO_ENTER_S;
      const e = 1 - (1 - u) ** 3;
      pop = 0.78 + 0.22 * e;
      slidePx = (1 - e) * maxSlide * dir;
      alpha = 0.2 + 0.8 * e;
    } else if (rem < CAMEO_EXIT_S) {
      const u = rem / CAMEO_EXIT_S;
      const e = u * u * u;
      pop = 0.80 + 0.20 * e;
      slidePx = (1 - e) * maxSlide * dir;
      alpha = e;
    }
    slot.style.opacity = alpha < 0.999 ? alpha.toFixed(3) : '';

    rec.group.position.set(0, 0, 0);
    rec.group.scale.setScalar(1);
    rec.group.rotation.y = cur.team === 0 ? 0.14 : -0.14;

    if (dt > 0) rec.mixer.update(Math.min(0.05, dt));

    const mouth = readLiveMouthLevel(age);
    for (const mm of rec.mouthMeshes) {
      if (mm.mouthIdx !== undefined) mm.mesh.morphTargetInfluences[mm.mouthIdx] = mouth;
      if (mm.browIdx !== undefined) mm.mesh.morphTargetInfluences[mm.browIdx] = 0.48 + 0.35 * mouth;
    }

    const rect = computeViewportRect(cur.team, slidePx, pop);
    const spec = rec.spec;

    // Update rounded-rect stencil mask geometry only if viewport size or corner radius changed.
    const rx = (2 * rect.radiusPx) / rect.width;
    const ry = (2 * rect.radiusPx) / rect.height;
    const nextMaskKey = `${rx.toFixed(3)}:${ry.toFixed(3)}`;
    if (nextMaskKey !== maskKey) {
      maskKey = nextMaskKey;
      maskMesh.geometry.dispose();
      maskMesh.geometry = buildRoundedRectGeometry(rx, ry, 8);
    }

    // Select studio backdrop theme matching the character.
    const tex = studioTextures[cur.id] || studioTextures.petsokopses;
    if (bgMat.map !== tex) {
      bgMat.map = tex;
      bgMat.needsUpdate = true;
    }

    cameoCamera.aspect = rect.width / Math.max(1, rect.height);
    cameoCamera.fov = spec.fov;
    cameoCamera.position.set(cur.team === 0 ? -spec.camX : spec.camX, spec.camY, spec.camZ);
    cameoCamera.lookAt(0, spec.targetY, 0);
    cameoCamera.updateProjectionMatrix();

    // Render opaque rounded TV PiP (stencil mask -> dark studio gradient -> waist-up 3D character) inside existing WebGLRenderer.
    const prevAutoClear = renderer.autoClear;
    const yGL = rect.vh - rect.top - rect.height;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(rect.left, yGL, rect.width, rect.height);
    renderer.setScissor(rect.left, yGL, rect.width, rect.height);
    renderer.clearDepth();
    renderer.clearStencil();
    renderer.render(maskScene, maskCam);
    renderer.render(bgScene, maskCam);
    renderer.render(cameoScene, cameoCamera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, rect.vw, rect.vh);
    renderer.autoClear = prevAutoClear;
    renderFrames++;
  }

  function handleEvents(events, match) {
    if (typeof window !== 'undefined' && window.__papifaCameoForceProb !== undefined) {
      engine.setForceProb(window.__papifaCameoForceProb);
    }
    return engine.handleEvents(events, match);
  }

  function reset(seed = 0) {
    for (const el of slots) clearSlotStyles(el);
    engine.resetMatch(seed);
  }

  function getState() {
    const cur = engine.getActive();
    return {
      preloaded,
      loadedModels: [...models.keys()],
      active: cur ? { id: cur.id, team: cur.team, lang: cur.lang, eventType: cur.eventType, duration: cur.duration } : null,
      mouth: smoothedMouth,
      audioPlayedCount,
      lastAudioUrl,
      renderFrames,
    };
  }

  const api = {
    preload,
    handleEvents,
    renderOn,
    stop: () => engine.stop(),
    reset,
    setForceProb: (p) => engine.setForceProb(p),
    isActive: () => engine.getActive() !== null,
    getState,
  };

  if (typeof window !== 'undefined') window.__papifaCameo = api;
  return api;
}
