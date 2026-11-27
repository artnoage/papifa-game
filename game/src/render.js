// Three.js view of the match. Each priest is a PriestView: a GLB with named clips when one exists
// (assets/models/<id>.glb, clips named as in CLIPS), otherwise a procedural placeholder.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { PLAYER, BALL, TEAMS, CLIP_REF_SPEED } from './config.js';
import { addCourtyard } from './courtyard.js';
import { createPitchTarget } from './pitch-target.js';
import { createPlayerIndicator } from './player-indicator.js';
import { createSlideSpray } from './slide-spray.js';
import { createPrayerEffects } from './prayer-fx.js';

export function createRenderer(container, teams = TEAMS, opts = {}) {
  const springsParam = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('springs') : null;
  let springsEnabled = opts.springs !== undefined ? Boolean(opts.springs) : springsParam !== '0';
  const springTiming = { enabled: springsEnabled, lastMs: 0, maxMs: 0, totalMs: 0, frames: 0, actors: 0, bones: 0, ring: new Float64Array(120), ringLen: 0, ringIdx: 0 };
  const lowQuality = new URLSearchParams(location.search).get('quality')?.toLowerCase() === 'low';
  const handheld = matchMedia('(pointer: coarse)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: !handheld && !lowQuality });
  renderer.setPixelRatio(Math.min(devicePixelRatio, lowQuality ? 1.15 : handheld ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const spray = lowQuality ? null : createSlideSpray(scene);
  const prayerFx = createPrayerEffects(scene);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
  const pitchTarget = createPitchTarget(renderer.domElement, camera, scene, teams[0]?.ring ?? 0xffc83d);
  const indicatePlayer = createPlayerIndicator(container, opts.touchTeam);
  const buildVenue = opts.buildVenue ?? addCourtyard;
  let venue;

  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(BALL.visualRadius ?? BALL.radius, 2), new THREE.MeshStandardMaterial({ map: ballTexture(), roughness: 0.5 }));
  ball.castShadow = true;
  scene.add(ball);

  // Each human-controlled priest gets a ground ring and bobbing overhead marker in their team's colour.
  // Team 0 is added first so single-player tests searching for the first ring/cone continue to find team 0.
  const humanIndicators = teams.map((team, i) => {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: team.ring, transparent: true, opacity: 0.95, depthWrite: false }),
    );
    ring.name = `Human ring ${i}`;
    ring.rotation.x = -Math.PI / 2;
    ring.visible = false;
    scene.add(ring);
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.22, 0.4, 3),
      new THREE.MeshBasicMaterial({ color: team.ring }),
    );
    marker.name = `Human marker ${i}`;
    marker.rotation.x = Math.PI;                    // point down at the priest
    marker.visible = false;
    scene.add(marker);
    // Flat ground arrow just outside the ring: where the next pass or shot goes. White while LT autopilot runs.
    const shape = new THREE.Shape();
    shape.moveTo(1.08, -0.08); shape.lineTo(1.68, -0.08); shape.lineTo(1.68, -0.28); shape.lineTo(2.18, 0);
    shape.lineTo(1.68, 0.28); shape.lineTo(1.68, 0.08); shape.lineTo(1.08, 0.08); shape.closePath();
    const arrowGeo = new THREE.ShapeGeometry(shape);
    arrowGeo.rotateX(-Math.PI / 2);
    const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: team.ring, transparent: true, opacity: 0.9, depthWrite: false }));
    arrow.name = `Human arrow ${i}`;
    arrow.visible = false;
    scene.add(arrow);
    return { ring, marker, arrow, ringColor: new THREE.Color(team.ring) };
  });
  const arrowWhite = new THREE.Color(0xffffff);
  let controlArrows = [null, null];
  // The venues tone-map lit surfaces. Unlit overlays (rings, markers, reticle, prayer effects, nets,
  // banners) keep their authored colours, so they stay exactly as readable as before. New objects
  // are flagged before their first draw: rescan whenever the scene's top-level children change.
  let overlayScan = '';
  function keepOverlayColours() {
    const last = scene.children[scene.children.length - 1];
    const key = scene.children.length + ':' + (last?.id ?? 0);
    if (key === overlayScan) return;
    overlayScan = key;
    scene.traverse((o) => {
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) {
        if ((m.isMeshBasicMaterial || m.isPointsMaterial || m.isSpriteMaterial) && m.toneMapped) {
          m.toneMapped = false;
          m.needsUpdate = true;
        }
      }
    });
  }
  function humansOf(m) {
    if (Array.isArray(m?.humans)) return [m.humans[0] ?? null, m.humans[1] ?? null];
    return [m?.human ?? null, null];
  }

  const views = [];                              // fixed roster slots, reused on replay
  const glbCache = new Map();
  const kitTexCache = new Map();
  const loader = new GLTFLoader();
  const texLoader = new THREE.TextureLoader();
  // Preload St George's white horse GLB once so summoning the prayer mounts with zero pop-in.
  const HORSE_GLB_URL = 'assets/models/st_george_horse.glb';
  glbCache.resolved = new Map();
  glbCache.set(HORSE_GLB_URL, loader.loadAsync(HORSE_GLB_URL).then((g) => { glbCache.resolved.set(HORSE_GLB_URL, g); return g; }).catch(() => null));
  const isRidingSlot = (m, slot) => !!(
    m?.prayersEnabled && slot >= 0 && slot < (m.players?.length ?? 0)
    && m.prayers?.[m.players[slot].team]?.active === 'george'
    && m.prayers[m.players[slot].team].riderSlot === slot
  );

  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.fov = w / h < 1 ? 60 : 42;            // portrait phones need a wider view
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);
  let zoom = 0.8;                                 // mouse wheel / pinch-free zoom: closer shows the motion, farther shows the play
  addEventListener('wheel', (e) => { zoom = THREE.MathUtils.clamp(zoom * (e.deltaY > 0 ? 1.08 : 1 / 1.08), 0.5, 1.5); }, { passive: true });
  // V cycles camera presets (C is chip shot): broadcast, close (shows the priests' motion), wide (shows the whole play)
  const ZOOMS = [0.8, 0.5, 1.15];
  let zoomIdx = 0;
  addEventListener('keydown', (e) => { if (e.code === 'KeyV' && !e.repeat) { zoomIdx = (zoomIdx + 1) % ZOOMS.length; zoom = ZOOMS[zoomIdx]; } });
  resize();

  const camPos = new THREE.Vector3(0, 30, 30), camLook = new THREE.Vector3();

  // ---------- broadcast camera ----------
  // Side-on. It frames the ball together with the priest you control, leads the play along the ball's
  // flight, tracks the ball across the pitch's width (the old one followed only 35% of it, so the near
  // touchline fell off the bottom of the screen), and pulls back while either would leave a safe frame
  // that keeps clear of the score bar and the hint bar.
  const _focus = new THREE.Vector3(), _want = new THREE.Vector3(), _ndc = new THREE.Vector3();
  const SAFE = { x: 0.8, top: 0.7, bottom: 0.6 };   // NDC margins
  let autoZoom = 1;
  function updateBroadcastCamera(m, dt, cut = false) {
    const HL = m.pitch.length / 2, HW = m.pitch.width / 2;
    const clamp = THREE.MathUtils.clamp, b = m.ball;
    const activeHumans = m.phase !== 'over' ? humansOf(m).filter(Boolean) : [];
    const sp = Math.hypot(b.vel.x, b.vel.z), lead = sp > 0.1 ? Math.min(0.35, 6 / sp) : 0;   // at most 6 m ahead
    const bx = b.pos.x + b.vel.x * lead, bz = b.pos.z + b.vel.z * lead;
    let fx = bx, fz = bz;
    if (activeHumans.length === 1) {
      fx = bx * 0.7 + activeHumans[0].pos.x * 0.3;
      fz = bz * 0.7 + activeHumans[0].pos.z * 0.3;
    } else if (activeHumans.length >= 2) {
      // Frame the ball + both controlled priests: use their bounding-box midpoint as they spread apart
      // so the full viewport width frames all three without unnecessary zoom-out.
      const h0 = activeHumans[0].pos, h1 = activeHumans[1].pos;
      const minX = Math.min(bx, h0.x, h1.x), maxX = Math.max(bx, h0.x, h1.x);
      const minZ = Math.min(bz, h0.z, h1.z), maxZ = Math.max(bz, h0.z, h1.z);
      const boxX = (minX + maxX) * 0.5, boxZ = (minZ + maxZ) * 0.5;
      const spread = clamp((Math.max(maxX - minX, maxZ - minZ) - 6) / 14, 0, 1);
      const closeX = bx * 0.6 + (h0.x + h1.x) * 0.2;
      const closeZ = bz * 0.6 + (h0.z + h1.z) * 0.2;
      fx = closeX + (boxX - closeX) * spread;
      fz = closeZ + (boxZ - closeZ) * spread;
    }
    _focus.set(clamp(fx, -HL + 6, HL - 6), 0, clamp(fz, -HW + 2, HW - 2) * 0.8 + 1.5);
    camLook.lerp(_focus, cut ? 1 : 1 - Math.exp(-(3.5 + Math.min(4, sp / 6)) * dt));   // quicker on long balls
    const portrait = innerWidth < innerHeight, z = zoom * autoZoom;
    // 36° down on desktop (was 41.8°): a band of the far side shows above the far touchline in ordinary play.
    _want.set(camLook.x, (portrait ? 30 : 15) * z, camLook.z + (portrait ? 24 : 20.6) * z);
    camPos.lerp(_want, cut ? 1 : 1 - Math.exp(-3.5 * dt));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    camera.updateMatrixWorld();
    let worst = 0;                                   // how far the ball or any controlled priest sits towards the frame edge (1 = on it)
    const framed = [b.pos, ...activeHumans.map((h) => h.pos)];
    for (const p of framed) {
      _ndc.set(p.x, p.y ?? 0, p.z).project(camera);
      worst = Math.max(worst, Math.abs(_ndc.x) / SAFE.x, _ndc.y > 0 ? _ndc.y / SAFE.top : -_ndc.y / SAFE.bottom);
    }
    const twoHumans = activeHumans.length >= 2;
    const maxAuto = twoHumans ? (portrait ? 2.25 : 2.05) : (portrait ? 1.9 : 1.55);
    const desiredScale = worst > 1
      ? (twoHumans ? Math.max(1.15, worst * 1.06) : 1.15)
      : worst < 0.7 ? 0.97 : 1;
    const target = clamp(autoZoom * desiredScale, 1, maxAuto);   // portrait: the pitch runs across a narrow screen
    const rate = twoHumans && target > autoZoom ? 5.0 : 2.5;
    autoZoom += (target - autoZoom) * (1 - Math.exp(-rate * dt));
  }

  // ---------- opening venue shot ----------
  let opening = null;
  function startOpening(m) {
    indicatePlayer(null);
    venue ??= buildVenue(scene, renderer, teams, m.pitch, lowQuality, handheld);
    autoZoom = 1;
    updateBroadcastCamera(m, 0, true);
    opening = null;
    if (!venue.landmark || matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
    const focus = venue.landmark.clone();
    const intoPitch = new THREE.Vector3(-focus.x, 0, -focus.z).normalize();
    const from = focus.clone().addScaledVector(intoPitch, handheld ? 29 : 23);
    from.add(new THREE.Vector3(-intoPitch.z * 5, 6, intoPitch.x * 5));
    // Give a cold venue GLB a brief head start, and keep the opening bounded on a slow connection.
    const shot = { from, focus, start: performance.now() + (venue.ready ? 800 : 0) };
    opening = shot;
    const begin = () => { shot.start = Math.min(shot.start, performance.now()); };
    if (venue.ready) Promise.resolve(venue.ready).then(begin, begin);
    return true;
  }
  function openingCamera() {
    const t = THREE.MathUtils.clamp((performance.now() - opening.start) / 3000, 0, 1);
    const ease = t * t * (3 - 2 * t);
    camera.position.lerpVectors(opening.from, camPos, ease);
    camera.position.y += 3 * Math.sin(Math.PI * ease);
    camera.lookAt(_focus.lerpVectors(opening.focus, camLook, ease));
    if (t === 1) opening = null;
  }

  // ---------- goal replay ----------
  // Every live frame is recorded (last HISTORY_S seconds of match time). A replay plays a window of that
  // history back in slow motion from a low, slowly orbiting camera while main.js holds the simulation.
  const HISTORY_S = 6, REPLAY_RATE = 0.45;
  const history = [];
  let replay = null;
  let wasReplaying = false;
  const snap = (p, riding = false) => ({ team: p.team, info: p.info, isGK: p.isGK, pos: { ...p.pos }, vel: { ...p.vel }, facing: p.facing, anim: p.anim, moveKind: p.moveKind ?? null, knockT: p.knockT ?? -9, recvT: p.recvT ?? p.receiveT ?? -9, speed: p.speed || 0, riding });
  let recordedMatch = null;
  function record(m) {
    // a new match (Space after full time / Rematch) restarts the clock: drop the old match's frames & held-ball blend
    if (m !== recordedMatch || (history.length && m.t < history[history.length - 1].t)) {
      history.length = 0;
      replay = null;
      _ballHoldBlend = 0;
      recordedMatch = m;
      for (const v of views) v?.springs?.reset();
    }
    if (history.length && history[history.length - 1].t === m.t) return;
    const actors = [...m.players, m.referee].map((p, slot) => snap(p, isRidingSlot(m, slot)));
    history.push({ t: m.t, phase: m.phase, actors, ball: { pos: { ...m.ball.pos }, vel: { ...m.ball.vel }, ownerSlot: m.players.indexOf(m.ball.owner) } });
    while (history.length && history[0].t < m.t - HISTORY_S) history.shift();
    return actors;
  }
  function startReplay(fromT, toT) {
    const frames = history.filter((f) => f.t >= fromT && f.t <= toT);
    if (frames.length < 10) return false;
    pitchTarget.hide();
    const f0 = frames[0], b = frames[frames.length - 1].ball.pos;
    replay = { frames, t: f0.t, end: frames[frames.length - 1].t, i: 0, orbit: Math.atan2(b.z, -Math.sign(b.x || 1) * 6) };
    // Save live mixer & pose state before cutting to replay frame 0 so return/skip resumes seamlessly.
    f0.actors.forEach((pa, slot) => {
      views[slot]?.saveLiveState();
      views[slot]?.resetPose(pa, f0.ball, f0.phase, f0.t + slot * 0.37, f0.t);
    });
    wasReplaying = true;
    camLook.set(f0.ball.pos.x, 0.9, f0.ball.pos.z);
    camPos.set(camLook.x + Math.cos(replay.orbit) * 7, 1.7, Math.min(camLook.z + Math.sin(replay.orbit) * 7, recordedMatch.pitch.width / 2 + 6));  // cut, don't swoop
    return true;
  }
  const lerpAngle = (a, b, k) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * k;
  // Visually cradle the ball between the keeper's posed hands while owning the ball in `catch`,
  // then smoothly blend back to the simulation ball position on release/punt (live + replay!).
  const _handMid = new THREE.Vector3();
  const _simBallPos = new THREE.Vector3();
  const _lastHeldPos = new THREE.Vector3();
  let _ballHoldBlend = 0;
  let _ballHoldWasReplay = false;
  function placeVisualBall(simPos, ownerSlot, ownerActor, dt, isReplay) {
    // The drawn ball is smaller than the sim's: lower it so it still rests on the grass.
    _simBallPos.set(simPos.x, simPos.y - (BALL.radius - (BALL.visualRadius ?? BALL.radius)), simPos.z);
    if (isReplay !== _ballHoldWasReplay) {
      _ballHoldBlend = 0;
      _ballHoldWasReplay = isReplay;
    }
    const v = ownerSlot >= 0 ? views[ownerSlot] : null;
    const isCatching = !!(
      v && ownerActor && ownerActor.isGK
      && (v.currentName === 'catch' || ownerActor.anim === 'catch' || (ownerActor.anim === 'dive' && ownerActor.moveKind === 'catch'))
    );
    let targetBlend = 0;
    if (isCatching && v.getCatchBallPos(_handMid)) {
      const act = v.actions?.catch;
      const dur = act?.getClip()?.duration || 0.73;
      const u = act ? THREE.MathUtils.clamp(act.time / dur, 0, 1) : 0.4;
      // Hold squarely between the hands throughout catch & chest cradle, then ease gently down near recovery.
      targetBlend = u < 0.80 ? 1.0 : THREE.MathUtils.clamp((0.96 - u) / 0.16, 0, 1);
      _lastHeldPos.copy(_handMid);
      if (_ballHoldBlend < 0.01 && (dt <= 0 || (isReplay && replay && replay.i === 0))) _ballHoldBlend = targetBlend;
    }
    if (dt > 0) {
      const rate = targetBlend > _ballHoldBlend ? 45 : 14;
      _ballHoldBlend += (targetBlend - _ballHoldBlend) * (1 - Math.exp(-rate * dt));
      if (_ballHoldBlend < 0.005) _ballHoldBlend = 0;
    } else {
      _ballHoldBlend = targetBlend;
    }
    if (_ballHoldBlend > 0.005) {
      ball.position.lerpVectors(_simBallPos, _lastHeldPos, _ballHoldBlend);
      return true;
    }
    ball.position.copy(_simBallPos);
    return false;
  }
  let postRenderHook = null;
  function setPostRender(fn) { postRenderHook = typeof fn === 'function' ? fn : null; }

  function renderReplay(dt) {
    indicatePlayer(null);
    const r = replay;
    r.t += dt * REPLAY_RATE;
    while (r.i < r.frames.length - 2 && r.frames[r.i + 1].t <= r.t) r.i++;
    const a = r.frames[r.i], c = r.frames[Math.min(r.i + 1, r.frames.length - 1)];
    const k = c.t > a.t ? THREE.MathUtils.clamp((r.t - a.t) / (c.t - a.t), 0, 1) : 0;
    const bp = { x: a.ball.pos.x + (c.ball.pos.x - a.ball.pos.x) * k, y: a.ball.pos.y + (c.ball.pos.y - a.ball.pos.y) * k, z: a.ball.pos.z + (c.ball.pos.z - a.ball.pos.z) * k };
    const bv = { x: a.ball.vel.x + (c.ball.vel.x - a.ball.vel.x) * k, y: a.ball.vel.y + (c.ball.vel.y - a.ball.vel.y) * k, z: a.ball.vel.z + (c.ball.vel.z - a.ball.vel.z) * k };
    const ballProxy = { pos: bp, vel: bv, ownerSlot: a.ball.ownerSlot };
    a.actors.forEach((pa, slot) => {
      const pc = c.actors[slot];
      const proxy = {
        ...pa,
        pos: { x: pa.pos.x + (pc.pos.x - pa.pos.x) * k, z: pa.pos.z + (pc.pos.z - pa.pos.z) * k },
        vel: { x: pa.vel.x + (pc.vel.x - pa.vel.x) * k, z: pa.vel.z + (pc.vel.z - pa.vel.z) * k },
        speed: pa.speed + (pc.speed - pa.speed) * k,
        facing: lerpAngle(pa.facing, pc.facing, k),
      };
      views[slot]?.update(proxy, dt * REPLAY_RATE, ballProxy, a.phase, slot, r.t, Boolean(pa.riding));
    });
    spray?.draw(r.t, recordedMatch.field);
    prayerFx.draw(r.t, recordedMatch.pitch, null);
    const tSprR = performance.now();
    if (springsEnabled) {
      for (let slot = 0; slot < a.actors.length; slot++) views[slot]?.updateSprings(dt * REPLAY_RATE);
    }
    recordSpringTiming(springTiming, views, springsEnabled, springsEnabled ? performance.now() - tSprR : 0);
    const held = placeVisualBall(bp, a.ball.ownerSlot, a.ball.ownerSlot >= 0 ? a.actors[a.ball.ownerSlot] : null, dt * REPLAY_RATE, true);
    const sp = Math.hypot(bv.x, bv.z);
    if (!held && sp > 0.05) ball.rotateOnWorldAxis(new THREE.Vector3(bv.z, 0, -bv.x).normalize(), (sp * dt * REPLAY_RATE) / (BALL.visualRadius ?? BALL.radius));
    for (const ind of humanIndicators) ind.ring.visible = ind.marker.visible = ind.arrow.visible = false;
    // low cinematic camera: 7 m from the ball at chest height, orbiting slowly
    r.orbit += dt * 0.12;
    camLook.lerp(new THREE.Vector3(bp.x, 0.9, bp.z), 1 - Math.exp(-5 * dt));
    const want = new THREE.Vector3(camLook.x + Math.cos(r.orbit) * 7, 1.7, camLook.z + Math.sin(r.orbit) * 7);
    want.z = Math.min(want.z, recordedMatch.pitch.width / 2 + 6);
    camPos.lerp(want, 1 - Math.exp(-2.5 * dt));
    camera.position.copy(camPos);
    camera.lookAt(camLook);
    keepOverlayColours();
    renderer.render(scene, camera);
    postRenderHook?.(renderer, dt);
    if (r.t >= r.end) replay = null;
  }

  function render(m, dt) {
    venue ??= buildVenue(scene, renderer, teams, m.pitch, lowQuality, handheld);
    venue.update?.(dt);
    if (replay) { renderReplay(dt); return; }
    if (m !== recordedMatch) {
      _ballHoldBlend = 0;
      for (const v of views) v?.springs?.reset();
    }
    const actors = [...m.players, m.referee];
    const ballProxy = { pos: m.ball.pos, vel: m.ball.vel, ownerSlot: m.players.indexOf(m.ball.owner) };
    if (wasReplaying) {
      actors.forEach((p, slot) => views[slot]?.restoreLiveState(p, ballProxy, m.phase, m.t + slot * 0.37, m.t));
      wasReplaying = false;
    }
    const snapshots = dt > 0 && (m.phase === 'play' || m.phase === 'goal') ? record(m) : null;
    spray?.record(m, m.t - HISTORY_S);
    if (dt > 0 && (m.phase === 'play' || m.phase === 'goal')) prayerFx.record(m);
    for (const [slot, p] of actors.entries()) {
      let v = views[slot];
      if (!v) { v = views[slot] = new PriestView(p, loader, glbCache, texLoader, kitTexCache, teams[p.team]); scene.add(v.root); }
      v.update(p, dt, ballProxy, m.phase, slot, m.t, isRidingSlot(m, slot));
      // A replay can open mid-slide. Save the clip time actually drawn alongside the turf contact.
      if (snapshots && v.currentName === 'slide') snapshots[slot].slideClipTime = v.current.time;
    }
    spray?.draw(opening || m.phase === 'over' ? null : m.t, m.field);
    prayerFx.draw(opening || m.phase === 'over' ? null : m.t, m.pitch, m);
    const tSpr0 = performance.now();
    if (springsEnabled) {
      for (let slot = 0; slot < actors.length; slot++) views[slot]?.updateSprings(dt);
    }
    recordSpringTiming(springTiming, views, springsEnabled, springsEnabled ? performance.now() - tSpr0 : 0);
    const b = m.ball;
    const held = placeVisualBall(b.pos, ballProxy.ownerSlot, m.ball.owner, dt, false);
    const sp = Math.hypot(b.vel.x, b.vel.z);
    if (!held && sp > 0.05) ball.rotateOnWorldAxis(new THREE.Vector3(b.vel.z, 0, -b.vel.x).normalize(), (sp * dt) / (BALL.visualRadius ?? BALL.radius));

    const humans = humansOf(m);
    const bob = 0.12 * Math.sin(performance.now() / 180);
    for (let i = 0; i < humanIndicators.length; i++) {
      const h = humans[i], ind = humanIndicators[i];
      if (h && m.phase !== 'over') {
        const hSlot = m.players.indexOf(h);
        const hRiding = isRidingSlot(m, hSlot);
        ind.ring.position.set(h.pos.x, 0.02, h.pos.z);
        ind.marker.position.set(h.pos.x, (hRiding ? 3.45 : 2.75) + bob, h.pos.z);
        ind.marker.rotation.y += dt * 2;
        ind.ring.visible = ind.marker.visible = true;
        const a = controlArrows[i];
        const ax = a ? a.x : Math.cos(h.facing ?? 0), az = a ? a.z : Math.sin(h.facing ?? 0);
        ind.arrow.position.set(h.pos.x, 0.025, h.pos.z);
        ind.arrow.rotation.y = Math.atan2(-az, ax);
        ind.arrow.material.color.copy(a?.auto ? arrowWhite : ind.ringColor);
        ind.arrow.visible = m.phase === 'play';
      } else {
        ind.ring.visible = ind.marker.visible = ind.arrow.visible = false;
      }
    }

    if (opening) openingCamera();
    else {
      updateBroadcastCamera(m, dt);
      indicatePlayer(m.phase === 'play' ? humans : null, camera);
    }
    if (!opening && m.phase === 'play' && dt > 0) pitchTarget.redraw();
    else pitchTarget.hide();
    keepOverlayColours();
    renderer.render(scene, camera);
    postRenderHook?.(renderer, dt);
  }
  function setSpringsEnabled(on) {
    springsEnabled = Boolean(on);
    springTiming.enabled = springsEnabled;
    if (!springsEnabled) for (const v of views) v?.springs?.reset();
  }
  function getSpringStats() {
    const n = springTiming.ringLen;
    let p95 = 0;
    if (n > 0) {
      const sorted = Array.from(springTiming.ring.subarray(0, n)).sort((a, b) => a - b);
      p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
    }
    return {
      enabled: springsEnabled,
      actors: springTiming.actors,
      bones: springTiming.bones,
      lastMs: springTiming.lastMs,
      avgMs: springTiming.frames ? springTiming.totalMs / springTiming.frames : 0,
      p95Ms: p95,
      maxMs: springTiming.maxMs,
      frames: springTiming.frames,
    };
  }
  return {
    render, pitchTarget, startOpening, opening: () => opening !== null, skipOpening: () => { opening = null; },
    startReplay, replaying: () => replay !== null, replayTime: () => replay ? replay.t : null, skipReplay: () => { replay = null; },
    recordPrayerEvents: (m, events) => prayerFx.recordEvents(m, events),
    setPostRender,
    setSpringsEnabled, getSpringStats,
    // Per team: { x, z, auto } unit direction for the controlled priest's arrow, or null to follow his facing.
    setControlArrows: (arrows) => { controlArrows = arrows ?? [null, null]; },
  };
}

// ---------- priests ----------
const ONE_SHOT = new Set(['pass', 'kick', 'chip', 'punt', 'knock', 'header', 'chest', 'tackle', 'slide', 'dive', 'dive_R', 'catch', 'parry', 'parry_R', 'whistle']);
const TRANSITION_FADE = {
  'run>sprint': 0.18, 'sprint>run': 0.18,
  'run>kick': 0.13,   'sprint>kick': 0.13,  'idle>kick': 0.11,
  'run>chip': 0.11,   'sprint>chip': 0.11,  'idle>chip': 0.10,
  'run>punt': 0.12,   'sprint>punt': 0.12,  'idle>punt': 0.10,
  'run>pass': 0.12,   'sprint>pass': 0.12,  'idle>pass': 0.10,
  'run>knock': 0.08,  'sprint>knock': 0.08, 'idle>knock': 0.09,
  'knock>run': 0.10,  'knock>sprint': 0.10, 'knock>idle': 0.14,
  'run>header': 0.10, 'sprint>header': 0.10,'idle>header': 0.10,
  'header>run': 0.16, 'header>sprint': 0.16,'header>idle': 0.16,
  'run>chest': 0.10,  'sprint>chest': 0.10, 'idle>chest': 0.10,
  'chest>run': 0.16,  'chest>sprint': 0.16, 'chest>idle': 0.16,
  'run>tackle': 0.14, 'sprint>tackle': 0.14, 'idle>tackle': 0.12,
  'tackle>run': 0.24, 'tackle>sprint': 0.24, 'tackle>idle': 0.24,
  'kick>run': 0.18,   'kick>sprint': 0.18,  'kick>idle': 0.18,
  'chip>run': 0.18,   'chip>sprint': 0.18,  'chip>idle': 0.18,
  'punt>run': 0.18,   'punt>sprint': 0.18,  'punt>idle': 0.18,
  'pass>run': 0.16,   'pass>sprint': 0.16,  'pass>idle': 0.16,
  'dive>idle': 0.28,  'dive>run': 0.28,     'dive>sprint': 0.28,
  'dive_R>idle': 0.28,'dive_R>run': 0.28,   'dive_R>sprint': 0.28,
  'idle>catch': 0.09, 'run>catch': 0.11,    'dive>catch': 0.12, 'dive_R>catch': 0.12,
  'catch>idle': 0.22, 'catch>run': 0.20,    'catch>punt': 0.14,
  'idle>parry': 0.08, 'run>parry': 0.10,    'parry>idle': 0.22, 'parry>run': 0.20,
  'idle>parry_R': 0.08,'run>parry_R': 0.10, 'parry_R>idle': 0.22,'parry_R>run': 0.20,
  'stunned>run': 0.22, 'stunned>sprint': 0.22, 'stunned>idle': 0.22,
  'idle>run': 0.20,   'idle>sprint': 0.18,  'run>idle': 0.22, 'sprint>idle': 0.24,
};
// Skip dead pre-windup frames on instant-release arcade actions so boot contact & lunge align cleanly in slow motion.
const CLIP_START_FRAC = { kick: 0.32, chip: 0.16, punt: 0.12, pass: 0.30, header: 0.14, chest: 0.10, catch: 0.08, parry: 0.08, parry_R: 0.08, tackle: 0.06 };
const KEEP_LOCAL_ATTACH = new Set(['epigonation', 'stole_01', 'stole_02', 'stole_03']);
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function mirrorBoneName(name) {
  if (name.endsWith('.L')) return name.slice(0, -2) + '.R';
  if (name.endsWith('.R')) return name.slice(0, -2) + '.L';
  if (/[a-z0-9_]L$/.test(name)) return name.slice(0, -1) + 'R';
  if (/[a-z0-9_]R$/.test(name)) return name.slice(0, -1) + 'L';
  if (name.includes('_fl_')) return name.replace('_fl_', '_fr_');
  if (name.includes('_fr_')) return name.replace('_fr_', '_fl_');
  if (name.includes('_bl_')) return name.replace('_bl_', '_br_');
  if (name.includes('_br_')) return name.replace('_br_', '_bl_');
  if (name.includes('_l_')) return name.replace('_l_', '_r_');
  if (name.includes('_r_')) return name.replace('_r_', '_l_');
  return name;
}

// Reflect a pure rotation Matrix4 across sagittal plane X=0: S * R * S (det = +1).
function mirrorRotMat4(m4) {
  const out = m4.clone();
  const e = m4.elements, o = out.elements;
  o[1] = -e[1]; o[2] = -e[2];
  o[4] = -e[4]; o[8] = -e[8];
  o[12] = 0; o[13] = 0; o[14] = 0; o[15] = 1;
  return out;
}

// Build an exact skeletal X-mirrored AnimationClip (dive -> dive_R) using bind-pose world conjugation.
// Eliminates whole-mesh scale.x = -1 mirroring so asymmetric vestments (e.g. Luka's epigonation) stay
// on their true hip and dive_R blends cleanly with idle/run with zero wrist or garment jump.
export function buildMirroredClip(srcScene, srcClip, newName) {
  const tmp = SkeletonUtils.clone(srcScene);
  tmp.updateMatrixWorld(true);
  const bones = [];
  const byName = new Map();
  tmp.traverse((o) => {
    if (o.isBone) { bones.push(o); byName.set(o.name, o); }
  });
  if (!bones.length) return srcClip.clone();

  const _pos = new THREE.Vector3(), _quat = new THREE.Quaternion(), _scl = new THREE.Vector3();
  const restRot = new Map();
  const restLocal = new Map();
  for (const b of bones) {
    b.matrixWorld.decompose(_pos, _quat, _scl);
    restRot.set(b.name, new THREE.Matrix4().makeRotationFromQuaternion(_quat));
    restLocal.set(b.name, { pos: b.position.clone(), quat: b.quaternion.clone() });
  }
  const partnerOf = new Map();
  const corrOf = new Map();
  for (const b of bones) {
    const pName = mirrorBoneName(b.name);
    const srcName = byName.has(pName) ? pName : b.name;
    partnerOf.set(b.name, srcName);
    const mRest = mirrorRotMat4(restRot.get(srcName)).transpose();
    corrOf.set(b.name, mRest.multiply(restRot.get(b.name)));
  }

  // Use source clip's unique keyframe times (fallback to 30fps uniform sampling).
  let times = null;
  for (const tr of srcClip.tracks) {
    if (!times || tr.times.length > times.length) times = tr.times;
  }
  if (!times || times.length < 2) {
    const n = Math.max(2, Math.round(srcClip.duration * 30) + 1);
    times = Float32Array.from({ length: n }, (_, i) => (i / (n - 1)) * srcClip.duration);
  }
  const nF = times.length;
  const posArr = new Map(), quatArr = new Map(), prevQ = new Map();
  for (const b of bones) {
    posArr.set(b.name, new Float32Array(nF * 3));
    quatArr.set(b.name, new Float32Array(nF * 4));
  }

  const mixer = new THREE.AnimationMixer(tmp);
  const act = mixer.clipAction(srcClip);
  act.setLoop(THREE.LoopOnce).play();
  act.clampWhenFinished = true;

  const srcWorldPos = new Map(), srcWorldRot = new Map();
  const mirWorldMat = new Map(), mirWorldRot = new Map();
  const _invM = new THREE.Matrix4(), _locRot = new THREE.Matrix4(), _qLoc = new THREE.Quaternion(), _pLoc = new THREE.Vector3();

  for (let fi = 0; fi < nF; fi++) {
    mixer.setTime(times[fi]);
    tmp.updateMatrixWorld(true);
    for (const b of bones) {
      b.matrixWorld.decompose(_pos, _quat, _scl);
      srcWorldPos.set(b.name, _pos.clone());
      srcWorldRot.set(b.name, new THREE.Matrix4().makeRotationFromQuaternion(_quat));
    }
    for (const b of bones) {
      const name = b.name;
      if (KEEP_LOCAL_ATTACH.has(name)) {
        // Keep asymmetric hip vestments anchored to their own hip with gentle local rest orientation.
        const rl = restLocal.get(name);
        const pa = posArr.get(name), qa = quatArr.get(name);
        pa[fi * 3] = rl.pos.x; pa[fi * 3 + 1] = rl.pos.y; pa[fi * 3 + 2] = rl.pos.z;
        qa[fi * 4] = rl.quat.x; qa[fi * 4 + 1] = rl.quat.y; qa[fi * 4 + 2] = rl.quat.z; qa[fi * 4 + 3] = rl.quat.w;
        const pMat = (b.parent && mirWorldMat.get(b.parent.name)) || (b.parent ? b.parent.matrixWorld : new THREE.Matrix4());
        const lMat = new THREE.Matrix4().compose(rl.pos, rl.quat, new THREE.Vector3(1, 1, 1));
        const wMat = pMat.clone().multiply(lMat);
        mirWorldMat.set(name, wMat);
        wMat.decompose(_pos, _quat, _scl);
        mirWorldRot.set(name, new THREE.Matrix4().makeRotationFromQuaternion(_quat));
        continue;
      }
      const srcName = partnerOf.get(name);
      const sp = srcWorldPos.get(srcName);
      const mp = new THREE.Vector3(-sp.x, sp.y, sp.z);
      const mr = mirrorRotMat4(srcWorldRot.get(srcName)).multiply(corrOf.get(name));
      const mWorld = mr.clone().setPosition(mp);
      mirWorldMat.set(name, mWorld);
      mirWorldRot.set(name, mr);

      const par = b.parent;
      let pMat, pRot;
      if (par && mirWorldMat.has(par.name)) {
        pMat = mirWorldMat.get(par.name);
        pRot = mirWorldRot.get(par.name);
      } else if (par) {
        pMat = par.matrixWorld;
        par.matrixWorld.decompose(_pos, _quat, _scl);
        pRot = new THREE.Matrix4().makeRotationFromQuaternion(_quat);
      } else {
        pMat = new THREE.Matrix4();
        pRot = new THREE.Matrix4();
      }
      _invM.copy(pMat).invert();
      _pLoc.copy(mp).applyMatrix4(_invM);
      _locRot.copy(pRot).transpose().multiply(mr);
      _qLoc.setFromRotationMatrix(_locRot).normalize();
      const pq = prevQ.get(name);
      if (pq && pq.dot(_qLoc) < 0) _qLoc.set(-_qLoc.x, -_qLoc.y, -_qLoc.z, -_qLoc.w);
      prevQ.set(name, _qLoc.clone());

      const pa = posArr.get(name), qa = quatArr.get(name);
      pa[fi * 3] = _pLoc.x; pa[fi * 3 + 1] = _pLoc.y; pa[fi * 3 + 2] = _pLoc.z;
      qa[fi * 4] = _qLoc.x; qa[fi * 4 + 1] = _qLoc.y; qa[fi * 4 + 2] = _qLoc.z; qa[fi * 4 + 3] = _qLoc.w;
    }
  }

  const tracks = [];
  for (const b of bones) {
    tracks.push(new THREE.VectorKeyframeTrack(`${b.name}.position`, times, posArr.get(b.name)));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quatArr.get(b.name)));
  }
  return new THREE.AnimationClip(newName, srcClip.duration, tracks);
}

class PriestView {
  constructor(p, loader, cache, texLoader, kitTexCache, kit) {
    this.root = new THREE.Group();
    this.root.name = p.info.id;
    this.bodyPivot = new THREE.Group();
    this.bodyPivot.scale.setScalar(PLAYER.visualScale ?? 1);   // drawn bigger than the sim body
    this.root.add(this.bodyPivot);
    this.phase = Math.random() * 10;
    this.proc = buildPlaceholder(p, kit);
    this.bodyPivot.add(this.proc.group);
    if (p.team !== null) {
      // team marker: stays flat on turf under root while bodyPivot banks
      const disc = new THREE.Group();
      disc.add(new THREE.Mesh(new THREE.RingGeometry(0.46, 0.64, 32), new THREE.MeshBasicMaterial({ color: kit.ring, transparent: true, opacity: 0.95, depthWrite: false })));
      disc.add(new THREE.Mesh(new THREE.CircleGeometry(0.46, 32), new THREE.MeshBasicMaterial({ color: kit.ring, transparent: true, opacity: 0.3, depthWrite: false })));
      disc.rotation.x = -Math.PI / 2; disc.position.y = 0.015;
      this.root.add(disc);
    }
    this.mixer = null; this.actions = null; this.current = null; this.currentName = null;
    this.lastAnim = null;
    this.smoothFacing = p.facing;
    this.actionFacing = null;
    this.diveFacing = null;
    this.diveClipName = 'dive';
    this.lastSpeed = 0;
    this.bankRoll = 0;
    this.accelPitch = 0;
    this.savedLive = null;
    this.handBoneL = null;
    this.handBoneR = null;
    this.priestId = p.info.id;
    this.springs = null;
    this._sprPosX = p.pos.x;
    this._sprPosZ = p.pos.z;
    this._sprVelX = p.vel?.x || 0;
    this._sprVelZ = p.vel?.z || 0;
    this._sprClip = 'idle';
    this._glbCache = cache;
    this._loader = loader;
    this.riding = false;
    this.horse = null;
    this.ridePoseBones = null;
    this.tryGLB(p, loader, cache, texLoader, kitTexCache, kit);
  }

  tryGLB(p, loader, cache, texLoader, kitTexCache, kit) {
    const url = `assets/models/${p.info.id}.glb`;
    if (!cache.has(url)) cache.set(url, loader.loadAsync(url).catch(() => null));
    let kitPromise = Promise.resolve(null);
    if (kit && texLoader && kitTexCache) {
      const texUrl = `assets/textures/${p.info.id}_${kit.kit}.webp`;
      if (!kitTexCache.has(texUrl)) {
        kitTexCache.set(texUrl, texLoader.loadAsync(texUrl).then((t) => {
          t.colorSpace = THREE.SRGBColorSpace;
          t.flipY = false;
          return t;
        }).catch(() => null));
      }
      kitPromise = kitTexCache.get(texUrl);
    }
    Promise.all([cache.get(url), kitPromise]).then(([gltf, kitTex]) => {
      if (!gltf) return;
      // Build and cache exact skeletal right-dive and right-parry clips once per unique GLB (zero scale.x = -1 hack!).
      if (!gltf.userData.diveRClip) {
        const diveClip = gltf.animations.find((c) => c.name === 'dive');
        if (diveClip) gltf.userData.diveRClip = buildMirroredClip(gltf.scene, diveClip, 'dive_R');
      }
      if (!gltf.userData.parryRClip) {
        const parryClip = gltf.animations.find((c) => c.name === 'parry');
        if (parryClip) gltf.userData.parryRClip = buildMirroredClip(gltf.scene, parryClip, 'parry_R');
      }
      const model = SkeletonUtils.clone(gltf.scene);
      model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true;
        // skinned bounds are the bind pose: a diving keeper or a reaching hand can leave them and get culled in close shots
        if (o.isSkinnedMesh) o.frustumCulled = false;
        // The team albedos share the original UVs and material properties.
        const name = o.material?.name;
        if (kitTex && (name === 'Mat_Body' || name === 'Mat_VestmentPrimary')) {
          o.material = o.material.clone();
          o.material.map = kitTex;
          o.material.needsUpdate = true;
        } else if (kit?.kitHue && name === 'Mat_VestmentPrimary') {
          o.material = hueShifted(o.material, kit.kitHue);
        }
        // Priests stay out of the venue tone mapping, like the turf: the roll-off dimmed the white
        // Away robes below the kit-contrast floor, and team colours must read exactly as authored.
        if (o.material) o.material.toneMapped = false;
      });
      this.bodyPivot.remove(this.proc.group);
      this.bodyPivot.add(model);
      // Cache posed knuckle/hand bones (prefer middle_01 so ball sits cleanly between cupped palms during `catch`).
      this.handBoneL = model.getObjectByName('middle_01L') || model.getObjectByName('middle_01.L') || model.getObjectByName('handL') || model.getObjectByName('hand.L');
      this.handBoneR = model.getObjectByName('middle_01R') || model.getObjectByName('middle_01.R') || model.getObjectByName('handR') || model.getObjectByName('hand.R');
      this.mixer = new THREE.AnimationMixer(model);
      this.actions = Object.fromEntries(gltf.animations.map((c) => [c.name, this.mixer.clipAction(c)]));
      if (gltf.userData.diveRClip) this.actions.dive_R = this.mixer.clipAction(gltf.userData.diveRClip);
      if (gltf.userData.parryRClip) this.actions.parry_R = this.mixer.clipAction(gltf.userData.parryRClip);
      // per-clip reference ground speed from glTF animation extras ({"refSpeed": m/s}); config defaults otherwise
      this.refSpeed = { ...CLIP_REF_SPEED };
      for (const a of gltf.parser?.json?.animations ?? []) if (a.name && a.extras?.refSpeed > 0) this.refSpeed[a.name] = a.extras.refSpeed;
      this.ridePoseBones = buildRidePoseTable(model);
      this.springs = new SecondarySpringRig(model, this.priestId);
    });
  }

  ensureHorse() {
    if (this.horse) return this.horse;
    this.horse = new HorseView(this._loader, this._glbCache);
    this.root.add(this.horse.root);
    return this.horse;
  }

  getCatchBallPos(out) {
    if (!this.handBoneL || !this.handBoneR) return false;
    this.root.updateMatrixWorld(true);
    const pL = new THREE.Vector3();
    const pR = new THREE.Vector3();
    this.handBoneL.getWorldPosition(pL);
    this.handBoneR.getWorldPosition(pR);
    out.copy(pL).add(pR).multiplyScalar(0.5);
    // Nudge slightly forward (+3 cm along facing) so the 22 cm ball nestles cleanly inside his cupped palms.
    out.x += Math.cos(this.smoothFacing) * 0.03;
    out.z += Math.sin(this.smoothFacing) * 0.03;
    out.y = Math.max(out.y, BALL.radius);
    return true;
  }

  clipNameFor(p, matchT = 0) {
    if (p.anim === 'slide') return this.actions?.slide ? 'slide' : 'tackle';   // until every priest ships a slide clip
    if (p.anim === 'catch' || (p.anim === 'dive' && p.moveKind === 'catch')) {
      return this.actions?.catch ? 'catch' : (this.diveClipName && this.actions?.[this.diveClipName] ? this.diveClipName : 'dive');
    }
    if (p.anim === 'parry' || (p.anim === 'dive' && p.moveKind === 'parry')) {
      const parryClip = this.diveClipName === 'dive_R' ? 'parry_R' : 'parry';
      if (this.actions?.[parryClip]) return parryClip;
      return this.actions?.parry ? 'parry' : (this.diveClipName && this.actions?.[this.diveClipName] ? this.diveClipName : 'dive');
    }
    if (p.anim === 'dive') return this.diveClipName && this.actions?.[this.diveClipName] ? this.diveClipName : 'dive';
    if (p.anim === 'kick' && p.moveKind === 'chip') return this.actions?.chip ? 'chip' : 'kick';
    if (p.anim === 'pass' && (p.moveKind === 'clear' || (p.isGK && p.moveKind === 'lofted'))) return this.actions?.punt ? 'punt' : 'pass';
    if (
      p.moveKind === 'knock'
      && p.knockT != null
      && matchT >= p.knockT
      && matchT - p.knockT < 0.34
      && (p.anim === 'run' || p.anim === 'sprint' || p.anim === 'idle')
    ) {
      return this.actions?.knock ? 'knock' : p.anim;
    }
    const recvT = p.recvT ?? p.receiveT;
    if (
      (p.moveKind === 'head' || p.moveKind === 'chest')
      && (p.anim === 'header' || p.anim === 'chest' || (
        recvT != null
        && matchT >= recvT
        && matchT - recvT < 0.48
        && (p.anim === 'run' || p.anim === 'sprint' || p.anim === 'idle')
      ))
    ) {
      const target = p.moveKind === 'head' ? 'header' : 'chest';
      return this.actions?.[target] ? target : (p.anim === 'header' || p.anim === 'chest' ? 'idle' : p.anim);
    }
    return p.team === null && p.anim === 'celebrate' && this.actions?.whistle ? 'whistle' : p.anim;
  }

  computeDiveSetup(p, ball) {
    const outFacing = p.team === 0 ? 0 : Math.PI;
    let diveFacing = outFacing;
    if (ball) {
      const toBall = Math.atan2(ball.pos.z - p.pos.z, ball.pos.x - p.pos.x);
      diveFacing = outFacing + wrapAngle(toBall - outFacing) * 0.25;
    }
    // Predict goal-line intercept so the dive always launches straight toward the shot's corner.
    let bx = ball ? ball.pos.x : p.pos.x + p.vel.x;
    let bz = ball ? ball.pos.z : p.pos.z + p.vel.z;
    if (ball) {
      if ((p.anim === 'parry' || p.moveKind === 'parry') && Math.abs(ball.vel.z) > 0.5) {
        // After a parry deflects the ball toward a flank, punch/tip directly toward ball.vel.z's flank!
        const lateralV = ball.vel.x * Math.sin(diveFacing) - ball.vel.z * Math.cos(diveFacing);
        return { diveFacing, clipName: lateralV < 0 ? 'dive_R' : 'dive' };
      }
      const towardGoal = p.team === 0 ? -ball.vel.x : ball.vel.x;
      if (towardGoal > 1.0 && Math.abs(ball.vel.x) > 0.5) {
        const tHit = THREE.MathUtils.clamp((p.pos.x - ball.pos.x) / ball.vel.x, 0, 0.75);
        bx = ball.pos.x + ball.vel.x * tHit;
        bz = ball.pos.z + ball.vel.z * tHit;
      }
    }
    const lateral = (bx - p.pos.x) * Math.sin(diveFacing) - (bz - p.pos.z) * Math.cos(diveFacing);
    return { diveFacing, clipName: lateral < 0 ? 'dive_R' : 'dive' };
  }

  saveLiveState() {
    const acts = {};
    if (this.actions) {
      for (const [name, act] of Object.entries(this.actions)) {
        const w = act.getEffectiveWeight();
        // never-played actions report weight 1 by default: only snapshot actions the mixer actually scheduled
        if (act.isScheduled() && (act.isRunning() || w > 1e-4)) {
          acts[name] = {
            time: act.time,
            timeScale: act.timeScale,
            weight: w,
            paused: act.paused,
            enabled: act.enabled,
            loop: act.loop,
            clamp: act.clampWhenFinished,
          };
        }
      }
    }
    this.savedLive = {
      acts,
      currentName: this.currentName,
      lastAnim: this.lastAnim,
      smoothFacing: this.smoothFacing,
      actionFacing: this.actionFacing,
      diveFacing: this.diveFacing,
      diveClipName: this.diveClipName,
      lastSpeed: this.lastSpeed,
      bankRoll: this.bankRoll,
      accelPitch: this.accelPitch,
    };
  }

  restoreLiveState(p, ball, phase, phaseSeed = 0, matchT = 0) {
    const s = this.savedLive;
    this.savedLive = null;
    if (!s || !this.mixer || !this.actions) {
      this.resetPose(p, ball, phase, phaseSeed, matchT);
      return;
    }
    this.lastAnim = s.lastAnim;
    this.smoothFacing = s.smoothFacing;
    this.actionFacing = s.actionFacing;
    this.diveFacing = s.diveFacing;
    this.diveClipName = s.diveClipName;
    this.lastSpeed = s.lastSpeed;
    this.bankRoll = s.bankRoll;
    this.accelPitch = s.accelPitch;
    this.root.position.set(p.pos.x, 0, p.pos.z);
    this.root.rotation.y = -this.smoothFacing + Math.PI / 2;
    this.bodyPivot.rotation.set(this.accelPitch, 0, this.bankRoll);
    this.mixer.stopAllAction();
    for (const [name, st] of Object.entries(s.acts)) {
      const act = this.actions[name];
      if (!act) continue;
      act.reset().setLoop(st.loop).play();
      act.clampWhenFinished = st.clamp;
      act.enabled = st.enabled;
      act.paused = st.paused;
      act.setEffectiveWeight(st.weight);
      act.timeScale = st.timeScale;
      act.time = st.time;
    }
    this.currentName = s.currentName;
    this.current = s.currentName ? (this.actions[s.currentName] || null) : null;
    this.springs?.restoreAnimQuats();
    this.mixer.update(0);
    this.springs?.reset(this.root, p.pos, p.vel, this.smoothFacing);
  }

  resetPose(p, ball, phase, phaseSeed = 0, matchT = 0) {
    this.lastAnim = p.anim;
    this.actionFacing = null;
    this.diveFacing = null;
    this.diveClipName = 'dive';
    this.bankRoll = 0;
    this.accelPitch = 0;
    this.lastSpeed = p.speed || 0;
    const isSaveAnim = p.anim === 'dive' || p.anim === 'parry' || p.anim === 'catch';
    if (isSaveAnim) {
      const d = this.computeDiveSetup(p, ball);
      this.diveFacing = d.diveFacing;
      this.diveClipName = d.clipName;
      this.smoothFacing = d.diveFacing;
    } else if (p.isGK && ball) {
      this.smoothFacing = Math.atan2(ball.pos.z - p.pos.z, ball.pos.x - p.pos.x);
    } else {
      this.smoothFacing = p.facing;
    }
    this.bodyPivot.rotation.set(0, 0, 0);
    this.root.position.set(p.pos.x, 0, p.pos.z);
    this.root.rotation.y = -this.smoothFacing + Math.PI / 2;
    if (!this.mixer || !this.actions) {
      this.springs?.reset();
      return;
    }
    this.mixer.stopAllAction();
    const name = this.clipNameFor(p, matchT);
    const act = this.actions[name] || this.actions.run || this.actions.idle;
    if (!act) return;
    const oneShot = ONE_SHOT.has(name);
    const dur = act.getClip().duration || 1;
    act.reset().setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat).setEffectiveWeight(1).play();
    act.clampWhenFinished = oneShot;
    act.timeScale = 1;
    act.time = p.slideClipTime ?? (oneShot ? (CLIP_START_FRAC[name] || 0) * dur : ((phaseSeed * 1.4) % dur));
    this.current = act;
    this.currentName = name;
    this.springs?.restoreAnimQuats();
    this.mixer.update(0);
    this.springs?.reset(this.root, p.pos, p.vel, this.smoothFacing);
  }

  play(name) {
    if (!this.actions) return;
    const next = this.actions[name] || this.actions.run || this.actions.idle;
    if (!next || next === this.current) return;
    const prevName = this.currentName;
    const oneShot = ONE_SHOT.has(name);
    const pairKey = prevName ? `${prevName}>${name}` : '';
    const fade = TRANSITION_FADE[pairKey] ?? (name === 'celebrate' ? 0.22 : name === 'stunned' ? 0.16 : oneShot ? 0.12 : 0.18);
    const prev = this.current;
    const prevPhase = (prev && prev.getClip().duration > 0) ? (prev.time / prev.getClip().duration) % 1 : 0;
    const nextDur = next.getClip().duration || 1;

    next.reset().setLoop(oneShot ? THREE.LoopOnce : THREE.LoopRepeat).setEffectiveWeight(1).fadeIn(fade).play();
    next.clampWhenFinished = oneShot;
    next.timeScale = 1;
    // Phase-sync run <-> sprint so left/right legs stay in lockstep with zero scissor-crossing.
    if ((prevName === 'run' && name === 'sprint') || (prevName === 'sprint' && name === 'run')) {
      next.time = prevPhase * nextDur;
    } else if (CLIP_START_FRAC[name]) {
      next.time = CLIP_START_FRAC[name] * nextDur;
    }
    if (prev) prev.fadeOut(fade);
    this.current = next;
    this.currentName = name;
  }

  update(p, dt, ball = null, phase = 'play', slot = -1, matchT = 0, riding = false) {
    this.root.position.set(p.pos.x, 0, p.pos.z);

    // Determine target visual facing:
    //  - Defending goalkeeper always squares up to the ball instead of staring at his own net.
    //  - Dive locks out-of-goal facing and selects left (`dive`) or skeletal right (`dive_R`) clip.
    //  - Kick/pass aims along the ball's launch trajectory so the boot swings straight through the shot.
    const isSaveAnim = p.anim === 'dive' || p.anim === 'parry' || p.anim === 'catch';
    const wasSaveAnim = this.lastAnim === 'dive' || this.lastAnim === 'parry' || this.lastAnim === 'catch';
    let targetFacing = p.facing;
    if (isSaveAnim) {
      if (!wasSaveAnim || this.diveFacing === null) {
        const d = this.computeDiveSetup(p, ball);
        this.diveFacing = d.diveFacing;
        this.diveClipName = d.clipName;
      }
      targetFacing = this.diveFacing;
    } else {
      this.diveFacing = null;
      if (p.anim === 'kick' || p.anim === 'pass') {
        if (this.lastAnim !== p.anim && ball) {
          const bDist = Math.hypot(ball.pos.x - p.pos.x, ball.pos.z - p.pos.z);
          const bSp = Math.hypot(ball.vel.x, ball.vel.z);
          this.actionFacing = (bDist < 3.0 && bSp > 3.5) ? Math.atan2(ball.vel.z, ball.vel.x) : p.facing;
        }
        targetFacing = this.actionFacing ?? p.facing;
      } else {
        this.actionFacing = null;
        if (p.isGK && ball && ball.ownerSlot !== slot) {
          targetFacing = Math.atan2(ball.pos.z - p.pos.z, ball.pos.x - p.pos.x);
        }
      }
    }

    const prevFacing = this.smoothFacing;
    if (dt > 0) {
      const turnK = 1 - Math.exp(-(p.anim === 'dive' ? 28 : 18) * dt);
      this.smoothFacing = prevFacing + wrapAngle(targetFacing - prevFacing) * turnK;
    } else {
      this.smoothFacing = targetFacing;
    }
    this.root.rotation.y = -this.smoothFacing + Math.PI / 2;   // model faces +z in its own space

    // Subtle procedural inward turn-bank roll and acceleration pitch during locomotion.
    const sp = p.speed || 0;
    const isLoco = p.anim === 'run' || p.anim === 'sprint';
    let wantRoll = 0, wantPitch = 0;
    if (isLoco && dt > 1e-4) {
      const angVel = THREE.MathUtils.clamp(wrapAngle(this.smoothFacing - prevFacing) / dt, -7, 7);
      wantRoll = THREE.MathUtils.clamp(angVel * sp * 0.011, -0.18, 0.18);
      const accel = THREE.MathUtils.clamp((sp - this.lastSpeed) / dt, -14, 14);
      wantPitch = THREE.MathUtils.clamp(accel * 0.008, -0.06, 0.09);
    }
    if (dt > 0) {
      const leanK = 1 - Math.exp(-10 * dt);
      this.bankRoll += (wantRoll - this.bankRoll) * leanK;
      this.accelPitch += (wantPitch - this.accelPitch) * leanK;
    }
    this.lastSpeed = sp;
    this.bodyPivot.rotation.set(riding ? this.accelPitch * 0.6 : this.accelPitch, 0, riding ? this.bankRoll * 0.75 : this.bankRoll);
    this.lastAnim = p.anim;

    const wasRiding = this.riding;
    this.riding = Boolean(riding);
    if (this.riding) {
      const hv = this.ensureHorse();
      hv.root.visible = true;
      hv.update(sp, dt);
      const saddle = hv.getSaddleLocal();
      const sc = PLAYER.visualScale ?? 1;
      this.bodyPivot.position.set(saddle.x, saddle.y - 0.907 * sc + 0.01, saddle.z + 0.01);
      if (this.proc?.group) this.proc.group.visible = !this.mixer;
    } else {
      if (this.horse) this.horse.root.visible = false;
      if (wasRiding) this.bodyPivot.position.set(0, 0, 0);
    }

    if (this.mixer) {
      const clipName = this.riding && (p.anim === 'run' || p.anim === 'sprint') ? 'idle' : this.clipNameFor(p, matchT);
      this.play(clipName);
      if (this.current) {
        if (clipName === 'run') this.current.timeScale = THREE.MathUtils.clamp(sp / (this.refSpeed.run * (PLAYER.visualScale ?? 1)), 0.12, 1.3);   // follows ground speed so planted boots never slide
        else if (clipName === 'sprint') this.current.timeScale = THREE.MathUtils.clamp(sp / (this.refSpeed.sprint * (PLAYER.visualScale ?? 1)), 0.45, 1.3);
        else if (clipName === 'dive' || clipName === 'dive_R') {
          const dur = this.current.getClip().duration || 0.8;
          const u = this.current.time / dur;
          // Hold on the turf in defeat after conceding a goal; otherwise recover with heavy, realistic weight.
          if (phase === 'goal' && u >= 0.72) this.current.timeScale = 0;
          else if (u >= 0.74) this.current.timeScale = 0.50;
          else this.current.timeScale = 1.0;
        } else {
          this.current.timeScale = 1.0;
        }
      }
      this.springs?.restoreAnimQuats();
      this.mixer.update(dt);
      if (this.riding && this.ridePoseBones) {
        const keepArms = clipName === 'kick' || clipName === 'pass' || clipName === 'chip' || clipName === 'tackle' || clipName === 'celebrate';
        applySeatedRidePose(this.ridePoseBones, !keepArms, sp);
      }
      if (this.riding !== wasRiding) {
        this.springs?.reset(this.root, p.pos, p.vel, this.smoothFacing);
      }
      this._sprPosX = p.pos.x;
      this._sprPosZ = p.pos.z;
      this._sprVelX = p.vel ? (p.vel.x || 0) : 0;
      this._sprVelZ = p.vel ? (p.vel.z || 0) : 0;
      this._sprClip = this.riding ? (sp > 1.2 ? 'sprint' : 'idle') : clipName;
      return;
    }
    animatePlaceholder(this.proc, p, dt, this);
  }

  updateSprings(dt) {
    if (this.springs && this.mixer) {
      this.springs.update(dt, this.root, this._sprPosX, this._sprPosZ, this._sprVelX, this._sprVelZ, this.smoothFacing, this._sprClip, this.riding);
    }
  }
}

// ---------- St George white charger & seated priest pose (Task H) ----------
const RIDE_POSE_DEG = [
  // Real seated riding pose (model space: +X left, +Y up, +Z forward):
  //   - Upward spine (+Y): +rx leans heroically FORWARD (+Z) into the gallop!
  //   - Downward thighs (-Y): -rx swings FORWARD (+Z) along the barrel & ±rz splays outside the saddlecloth
  //   - Knees sharply BENT (+rx) so shins tuck straight down into the gold stirrups at the bottom of the barrel
  //   - Hands lowered comfortably forward onto the leather reins over the pommel
  //   - Cassock skirt draped forward & down over the bent thighs and outside the crimson saddlecloth
  { names: ['spine'],               rx: +14, ry: 0, rz: 0,   upper: true },
  { names: ['spine1'],              rx: +8,  ry: 0, rz: 0,   upper: true },
  { names: ['thighL', 'thigh.L'],   rx: -60, ry: 0, rz: +30, upper: false },
  { names: ['thighR', 'thigh.R'],   rx: -60, ry: 0, rz: -30, upper: false },
  { names: ['shinL', 'shin.L'],     rx: +72, ry: 0, rz: -16, upper: false },
  { names: ['shinR', 'shin.R'],     rx: +72, ry: 0, rz: +16, upper: false },
  // A-pose arms swung forward & slightly down onto the leather reins over the pommel
  { names: ['upper_armL', 'upper_arm.L'], rx: -24, ry: -22, rz: -26, arm: true },
  { names: ['upper_armR', 'upper_arm.R'], rx: -24, ry: +22, rz: +26, arm: true },
  { names: ['forearmL', 'forearm.L'],     rx: -12, ry: -18, rz: +10, arm: true },
  { names: ['forearmR', 'forearm.R'],     rx: -12, ry: +18, rz: -10, arm: true },
  // Draped cassock skirt following the forward thighs, bending over knees & flaring outside saddlecloth
  { names: ['skirt_f_01'],  rx: -66, ry: 0, rz: 0,   upper: false },
  { names: ['skirt_f_02'],  rx: +48, ry: 0, rz: 0,   upper: false },
  { names: ['skirt_fl_01'], rx: -56, ry: 0, rz: +36, upper: false },
  { names: ['skirt_fl_02'], rx: +42, ry: 0, rz: -18, upper: false },
  { names: ['skirt_fr_01'], rx: -56, ry: 0, rz: -36, upper: false },
  { names: ['skirt_fr_02'], rx: +42, ry: 0, rz: +18, upper: false },
  { names: ['skirt_l_01'],  rx: -16, ry: 0, rz: +46, upper: false },
  { names: ['skirt_l_02'],  rx: +14, ry: 0, rz: -26, upper: false },
  { names: ['skirt_l_03'],  rx:  +8, ry: 0, rz: -12, upper: false },
  { names: ['skirt_r_01'],  rx: -16, ry: 0, rz: -46, upper: false },
  { names: ['skirt_r_02'],  rx: +14, ry: 0, rz: +26, upper: false },
  { names: ['skirt_r_03'],  rx:  +8, ry: 0, rz: +12, upper: false },
  { names: ['skirt_bl_01'], rx: +26, ry: 0, rz: +34, upper: false },
  { names: ['skirt_bl_02'], rx: -12, ry: 0, rz: -16, upper: false },
  { names: ['skirt_br_01'], rx: +26, ry: 0, rz: -34, upper: false },
  { names: ['skirt_br_02'], rx: -12, ry: 0, rz: +16, upper: false },
  { names: ['skirt_b_01'],  rx: +46, ry: 0, rz: 0,   upper: false },
  { names: ['skirt_b_02'],  rx: -20, ry: 0, rz: 0,   upper: false },
];

function buildRidePoseTable(model) {
  const table = [];
  const restModelQ = new THREE.Quaternion();
  const invQ = new THREE.Quaternion(), charQ = new THREE.Quaternion(), euler = new THREE.Euler(0, 0, 0, 'XYZ');
  for (const spec of RIDE_POSE_DEG) {
    let bone = null;
    for (const nm of spec.names) {
      bone = model.getObjectByName(nm);
      if (bone) break;
    }
    if (!bone) continue;
    // Compose bone rest orientation strictly in MODEL space (immune to root.rotation.y facing!).
    const chain = [];
    for (let cur = bone; cur && cur !== model; cur = cur.parent) chain.push(cur);
    restModelQ.identity();
    for (let i = chain.length - 1; i >= 0; i--) restModelQ.multiply(chain[i].quaternion);
    restModelQ.normalize();
    invQ.copy(restModelQ).invert();
    euler.set(THREE.MathUtils.degToRad(spec.rx), THREE.MathUtils.degToRad(spec.ry), THREE.MathUtils.degToRad(spec.rz), 'XYZ');
    charQ.setFromEuler(euler);
    // Exact local target quaternion = restLocal * (inv(restModel) * charQ * restModel)
    const targetQ = bone.quaternion.clone().multiply(invQ.clone().multiply(charQ).multiply(restModelQ)).normalize();
    table.push({ bone, targetQ, arm: Boolean(spec.arm), upper: Boolean(spec.upper) });
  }
  return table;
}

function applySeatedRidePose(table, poseArms = true, speed = 0) {
  for (let i = 0; i < table.length; i++) {
    const e = table[i];
    if (e.arm && !poseArms) continue;
    if (e.upper && !poseArms) continue;
    e.bone.quaternion.copy(e.targetQ);
  }
}

class HorseView {
  constructor(loader, cache) {
    this.root = new THREE.Group();
    this.root.name = 'StGeorgeHorseRoot';
    this.root.visible = false;
    this.model = null;
    this.mixer = null;
    this.actions = null;
    this.current = null;
    this.currentName = '';
    this.refSpeed = 11.2;
    this.saddleBone = null;
    this._saddleLocal = new THREE.Vector3(0, 1.44, 0.02);
    this._tmpW = new THREE.Vector3();

    // Subtle warm crimson-gold St George aura ring beneath the charger's hooves
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(0.76, 1.06, 36),
      new THREE.MeshBasicMaterial({ color: 0xffc45e, transparent: true, opacity: 0.42, depthWrite: false }),
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.022;
    this.root.add(aura);
    this.aura = aura;

    const url = 'assets/models/st_george_horse.glb';
    if (!cache.resolved) cache.resolved = new Map();
    if (!cache.has(url)) cache.set(url, loader.loadAsync(url).then((g) => { cache.resolved.set(url, g); return g; }).catch(() => null));
    if (cache.resolved.has(url)) {
      this._attachGltf(cache.resolved.get(url));
    } else {
      cache.get(url).then((gltf) => this._attachGltf(gltf));
    }
  }

  _attachGltf(gltf) {
    if (!gltf || this.model) return;
    const model = SkeletonUtils.clone(gltf.scene);
    model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true;
      if (o.isSkinnedMesh) o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
      for (const m of mats) m.toneMapped = false;
    });
    this.model = model;
    this.root.add(model);
    this.saddleBone = model.getObjectByName('saddle_mount') || null;
    this.mixer = new THREE.AnimationMixer(model);
    this.actions = Object.fromEntries(gltf.animations.map((c) => [c.name, this.mixer.clipAction(c)]));
    for (const a of gltf.parser?.json?.animations ?? []) {
      if (a.name === 'gallop' && a.extras?.refSpeed > 0) this.refSpeed = a.extras.refSpeed;
    }
    this.play('idle');
  }

  play(name) {
    if (!this.actions) return;
    const next = this.actions[name] || this.actions.gallop || this.actions.idle;
    if (!next || next === this.current) return;
    next.reset().setLoop(THREE.LoopRepeat).setEffectiveWeight(1).fadeIn(0.16).play();
    if (this.current) this.current.fadeOut(0.16);
    this.current = next;
    this.currentName = name;
  }

  update(speed, dt) {
    if (!this.mixer) return;
    const moving = speed > 0.55;
    this.play(moving ? 'gallop' : 'idle');
    if (this.current) {
      this.current.timeScale = moving ? THREE.MathUtils.clamp(speed / this.refSpeed, 0.35, 1.55) : 1.0;
    }
    this.mixer.update(dt);
    if (this.saddleBone) {
      this.root.updateMatrixWorld(true);
      this.saddleBone.getWorldPosition(this._tmpW);
      this.root.worldToLocal(this._tmpW);
      this._saddleLocal.copy(this._tmpW);
    }
  }

  getSaddleLocal() {
    return this._saddleLocal;
  }
}

// ---------- runtime secondary cloth & beard springs ----------
// Layered post-mixer damped spring chains driven by root world acceleration and turn rate.
// Pure scalar substep integration with zero per-frame allocations, leg/torso hull clearance,
// cone-angle clamps, and automatic reset on teleports, replay cuts and Rematch.
const SPRING_SECTOR_DIR = {
  f:  [ 1, 0],
  fl: [ 0.70710678,  0.70710678],
  l:  [ 0, 1],
  bl: [-0.70710678,  0.70710678],
  b:  [-1, 0],
  br: [-0.70710678, -0.70710678],
  r:  [ 0, -1],
  fr: [ 0.70710678, -0.70710678],
};
const SKIRT_RING_ORDER = ['f', 'fl', 'l', 'bl', 'b', 'br', 'r', 'fr'];

// F2 #5: Heavy-cloth & real-hair secondary physics (large excursion on sprints/cuts/shots/slides/celebrations,
// heavy critically-damped settling with zero rubbery wobble, quadratic aerodynamic drag + deadzones so idle/jog stay calm).
const SPRING_DEFAULTS = {
  skirt:    { freq: 1.60, zeta: 0.56, accel: 2.85, cent: 3.10, swirl: 2.75, drag: 0.42, lift: 0.34, bounce: 0.52, maxDeg: 44 },
  beard:    { freq: 1.65, zeta: 0.54, accel: 2.45, cent: 2.00, swirl: 2.30, drag: 0.24, lift: 0.22, bounce: 0.58, maxDeg: 35 },
  stole:    { freq: 1.90, zeta: 0.46, accel: 2.95, cent: 2.70, swirl: 2.65, drag: 0.52, lift: 0.38, bounce: 0.68, maxDeg: 56 },
  epig:     { freq: 1.72, zeta: 0.48, accel: 2.90, cent: 2.85, swirl: 2.60, drag: 0.28, lift: 0.22, bounce: 0.60, maxDeg: 48 },
  ponytail: { freq: 2.22, zeta: 0.48, accel: 2.65, cent: 2.35, swirl: 2.35, drag: 0.44, lift: 0.32, bounce: 0.64, maxDeg: 49 },
  veil:     { freq: 1.68, zeta: 0.46, accel: 3.05, cent: 2.80, swirl: 2.65, drag: 0.62, lift: 0.42, bounce: 0.70, maxDeg: 63 },
  cross:    { freq: 1.82, zeta: 0.48, accel: 2.50, cent: 1.85, swirl: 1.95, drag: 0.10, lift: 0.12, bounce: 1.90, maxDeg: 33 },
};

const SPRING_PROFILES = {
  giorgis: {
    rThigh: 0.155, rShin: 0.128, rTorso: 0.22,
    beard: { freq: 1.56, zeta: 0.52, accel: 3.25, cent: 2.45, swirl: 2.80, drag: 0.30, lift: 0.28, bounce: 0.78, maxDeg: 39 },
    skirt: { freq: 1.56, zeta: 0.54, accel: 3.00, cent: 3.25, swirl: 2.85, drag: 0.44, lift: 0.34, bounce: 0.55, maxDeg: 45 },
    cross: { freq: 1.74, zeta: 0.46, accel: 2.85, cent: 2.05, swirl: 2.15, drag: 0.12, lift: 0.15, bounce: 2.20, maxDeg: 36 },
  },
  nikolai: {
    rThigh: 0.135, rShin: 0.116, rTorso: 0.165,
    stole:    { freq: 1.88, zeta: 0.46, accel: 3.10, cent: 2.85, swirl: 2.80, drag: 0.56, lift: 0.40, bounce: 0.75, maxDeg: 58 },
    ponytail: { freq: 2.20, zeta: 0.48, accel: 2.75, cent: 2.45, swirl: 2.45, drag: 0.46, lift: 0.34, bounce: 0.68, maxDeg: 50 },
    skirt:    { freq: 1.88, zeta: 0.50, accel: 3.05, cent: 3.25, swirl: 2.85, drag: 0.46, lift: 0.36, bounce: 0.58, maxDeg: 46 },
    beard:    { freq: 3.80, zeta: 0.78, accel: 0.40, cent: 0.30, swirl: 0.30, drag: 0.03, lift: 0.04, bounce: 0.08, maxDeg: 11 },
    cross:    { freq: 1.92, zeta: 0.50, accel: 2.25, cent: 1.65, swirl: 1.75, drag: 0.08, lift: 0.10, bounce: 1.65, maxDeg: 30 },
  },
  seraphim: {
    rThigh: 0.148, rShin: 0.124, rTorso: 0.20,
    // Heavier, slower ascetic Great Schema & thick wool monastic habit
    skirt: { freq: 1.42, zeta: 0.66, accel: 2.30, cent: 2.40, swirl: 2.15, drag: 0.30, lift: 0.22, bounce: 0.40, maxDeg: 38 },
    beard: { freq: 1.78, zeta: 0.58, accel: 1.95, cent: 1.55, swirl: 1.75, drag: 0.16, lift: 0.14, bounce: 0.44, maxDeg: 28 },
    cross: { freq: 1.94, zeta: 0.54, accel: 1.75, cent: 1.30, swirl: 1.40, drag: 0.07, lift: 0.08, bounce: 1.25, maxDeg: 25 },
  },
  ioannis: {
    rThigh: 0.150, rShin: 0.125, rTorso: 0.21,
    // Heavy embroidered imperial brocade sakkos
    skirt: { freq: 1.52, zeta: 0.61, accel: 2.50, cent: 2.60, swirl: 2.35, drag: 0.34, lift: 0.26, bounce: 0.44, maxDeg: 40 },
    beard: { freq: 1.68, zeta: 0.56, accel: 2.25, cent: 1.80, swirl: 2.05, drag: 0.20, lift: 0.18, bounce: 0.52, maxDeg: 32 },
    cross: { freq: 1.78, zeta: 0.48, accel: 2.50, cent: 1.80, swirl: 1.90, drag: 0.10, lift: 0.12, bounce: 1.85, maxDeg: 33 },
  },
  luka: {
    rThigh: 0.155, rShin: 0.128, rTorso: 0.22,
    epig:  { freq: 1.70, zeta: 0.48, accel: 3.00, cent: 2.95, swirl: 2.70, drag: 0.30, lift: 0.24, bounce: 0.65, maxDeg: 49 },
    skirt: { freq: 1.64, zeta: 0.54, accel: 2.95, cent: 3.15, swirl: 2.75, drag: 0.42, lift: 0.32, bounce: 0.55, maxDeg: 45 },
    beard: { freq: 1.54, zeta: 0.52, accel: 3.05, cent: 2.35, swirl: 2.65, drag: 0.28, lift: 0.26, bounce: 0.72, maxDeg: 38 },
    cross: { freq: 1.80, zeta: 0.48, accel: 2.45, cent: 1.80, swirl: 1.90, drag: 0.10, lift: 0.12, bounce: 1.80, maxDeg: 33 },
  },
  patriarch: {
    rThigh: 0.145, rShin: 0.120, rTorso: 0.195,
    // Longest, most dramatic trailing white silk klobuk veil
    veil:  { freq: 1.64, zeta: 0.46, accel: 3.25, cent: 2.95, swirl: 2.80, drag: 0.68, lift: 0.45, bounce: 0.78, maxDeg: 65 },
    skirt: { freq: 1.62, zeta: 0.56, accel: 2.70, cent: 2.80, swirl: 2.50, drag: 0.38, lift: 0.30, bounce: 0.48, maxDeg: 42 },
    beard: { freq: 1.58, zeta: 0.52, accel: 2.75, cent: 2.15, swirl: 2.45, drag: 0.26, lift: 0.24, bounce: 0.65, maxDeg: 36 },
    cross: { freq: 1.78, zeta: 0.48, accel: 2.55, cent: 1.85, swirl: 1.95, drag: 0.10, lift: 0.12, bounce: 1.90, maxDeg: 34 },
  },
};

const _sprV0 = new THREE.Vector3();
let _capOutX = 0, _capOutY = 0, _capOutZ = 0;

function recordSpringTiming(st, views, enabled, ms) {
  st.enabled = enabled;
  let actors = 0, bones = 0;
  for (const v of views) {
    if (v?.springs) { actors++; bones += v.springs.nodes.length; }
  }
  st.actors = actors;
  st.bones = bones;
  st.lastMs = ms;
  if (!enabled || actors === 0) return;
  st.totalMs += ms;
  st.frames++;
  if (ms > st.maxMs) st.maxMs = ms;
  st.ring[st.ringIdx] = ms;
  st.ringIdx = (st.ringIdx + 1) % st.ring.length;
  if (st.ringLen < st.ring.length) st.ringLen++;
}

function classifySpringBone(name) {
  let m = /^skirt_(fl|fr|bl|br|f|b|l|r)_0([123])$/.exec(name);
  if (m) return { kind: 'skirt', sector: m[1], tier: Number(m[2]) - 1 };
  m = /^beard_0([123])$/.exec(name);
  if (m) return { kind: 'beard', sector: 'f', tier: Number(m[1]) - 1 };
  m = /^stole_0([123])$/.exec(name);
  if (m) return { kind: 'stole', sector: 'b', tier: Number(m[1]) - 1 };
  m = /^veil_0([123])$/.exec(name);
  if (m) return { kind: 'veil', sector: 'b', tier: Number(m[1]) - 1 };
  m = /^ponytail_0([12])$/.exec(name);
  if (m) return { kind: 'ponytail', sector: 'b', tier: Number(m[1]) - 1 };
  if (name === 'epigonation') return { kind: 'epig', sector: 'r', tier: 1 };
  if (name === 'cross_chain') return { kind: 'cross', sector: 'f', tier: 0 };
  if (name === 'cross_pendant') return { kind: 'cross', sector: 'f', tier: 1 };
  return null;
}

function distToSegment(px, py, pz, ax, ay, az, bx, by, bz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-8 ? ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / ab2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t), dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function distToSegPre(px, py, pz, ax, ay, az, abx, aby, abz, invAb2) {
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * invAb2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t), dz = pz - (az + abz * t);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function pushOutCapPre(px, py, pz, ax, ay, az, abx, aby, abz, invAb2, r, r2, biasX, biasZ, pushPad) {
  let t = ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) * invAb2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + abx * t, cy = ay + aby * t, cz = az + abz * t;
  let nx = px - cx, ny = py - cy, nz = pz - cz;
  const d2 = nx * nx + ny * ny + nz * nz;
  if (d2 >= r2) return false;
  let d = Math.sqrt(d2);
  if (d < 1e-5) {
    nx = biasX; ny = 0; nz = biasZ;
    d = Math.sqrt(nx * nx + nz * nz) || 1;
  } else if (biasX !== 0 || biasZ !== 0) {
    if ((nx * biasX + nz * biasZ) / d < -0.25) {
      nx = biasX; ny = 0; nz = biasZ;
      d = Math.sqrt(nx * nx + nz * nz) || 1;
    }
  }
  const inv = (r + pushPad) / d;
  _capOutX = cx + nx * inv;
  _capOutY = cy + ny * inv;
  _capOutZ = cz + nz * inv;
  return true;
}

export class SecondarySpringRig {
  constructor(model, priestId) {
    this.priestId = priestId;
    const prof = SPRING_PROFILES[priestId] || {};
    model.updateMatrixWorld(true);
    const sc = model.getWorldScale(_sprV0).y || 1;
    this.worldScale = sc;
    this.rThigh = (prof.rThigh ?? 0.135) * sc;
    this.rShin = (prof.rShin ?? 0.110) * sc;
    this.rTorso = (prof.rTorso ?? 0.195) * sc;

    const findBone = (a, b) => model.getObjectByName(a) || (b ? model.getObjectByName(b) : null);
    this.thighL = findBone('thighL', 'thigh.L');
    this.shinL = findBone('shinL', 'shin.L');
    this.footL = findBone('footL', 'foot.L');
    this.thighR = findBone('thighR', 'thigh.R');
    this.shinR = findBone('shinR', 'shin.R');
    this.footR = findBone('footR', 'foot.R');
    this.hips = findBone('hips');
    this.chest = findBone('chest');

    // Capsule endpoints in world space (4 leg capsules + 1 torso capsule), stored flat for zero GC.
    this.caps = new Float64Array(5 * 6);
    this.hasCaps = Boolean(this.thighL && this.shinL && this.footL && this.thighR && this.shinR && this.footR && this.hips && this.chest);

    this.nodes = [];
    this.skirtRing = [[], [], []];
    const indexByBone = new Map();
    const tierGain = [0.48, 1.12, 2.00];
    const tierAng = [0.54, 0.96, 1.32];

    if (this.hasCaps) this._readCapsules();

    // Unique non-spring parents of chain roots (typically hips, chest, head — only 3 per priest!).
    // Each tracks 3D bone-attachment inertia so celebration jumps, kicks, dives & head turns drive real bounce!
    this.rootParents = [];
    const rootParentIdxMap = new Map();

    model.traverse((obj) => {
      if (!obj.isBone) return;
      const cls = classifySpringBone(obj.name);
      if (!cls) return;
      const baseCfg = { ...SPRING_DEFAULTS[cls.kind], ...(prof[cls.kind] || {}) };
      const parentIdx = obj.parent && indexByBone.has(obj.parent) ? indexByBone.get(obj.parent) : -1;
      let rootParentIdx = -1;
      if (parentIdx < 0 && obj.parent) {
        if (!rootParentIdxMap.has(obj.parent)) {
          rootParentIdxMap.set(obj.parent, this.rootParents.length);
          this.rootParents.push({
            obj: obj.parent, worldQuat: new THREE.Quaternion(), chainIdx: -1,
            hasPrev: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0,
          });
        }
        rootParentIdx = rootParentIdxMap.get(obj.parent);
      }

      // World-space bone length along local +Y from child offset, parent fallback, or default.
      let len = 0;
      for (const ch of obj.children) {
        if (ch.isBone) {
          const d = ch.position.length() * sc;
          if (d > 0.02) { len = d; break; }
        }
      }
      if (len <= 0.02) {
        len = parentIdx >= 0 ? this.nodes[parentIdx].len : (cls.kind === 'epig' ? 0.26 * sc : 0.16 * sc);
      }

      const tGain = cls.kind === 'epig' ? 1.0 : (cls.kind === 'cross' ? (cls.tier === 0 ? 0.85 : 1.35) : tierGain[Math.min(2, cls.tier)]);
      const tAng = cls.kind === 'epig' ? 1.0 : (cls.kind === 'cross' ? (cls.tier === 0 ? 0.88 : 1.15) : tierAng[Math.min(2, cls.tier)]);
      const omegaN = 2 * Math.PI * baseCfg.freq;
      const hardCap = (cls.kind === 'stole' || cls.kind === 'veil' || cls.kind === 'ponytail') ? 66 : 50;
      const maxRad = THREE.MathUtils.degToRad(Math.min(hardCap, baseCfg.maxDeg * tAng));
      const sDir = SPRING_SECTOR_DIR[cls.sector] || [1, 0];

      // Measure bind-pose clearance to capsules so standing still never artificially inflates tight hems.
      const me = obj.matrixWorld.elements;
      const hx = me[12], hy = me[13], hz = me[14];
      const yLen = Math.hypot(me[4], me[5], me[6]) || 1;
      const adx = me[4] / yLen, ady = me[5] / yLen, adz = me[6] / yLen;
      const tipX = hx + adx * len, tipY = hy + ady * len, tipZ = hz + adz * len;

      let rThighEff = this.rThigh, rShinEff = this.rShin, rTorsoEff = this.rTorso;
      if (this.hasCaps) {
        const c = this.caps;
        if (cls.kind === 'skirt') {
          const dT = Math.min(
            distToSegment(tipX, tipY, tipZ, c[0], c[1], c[2], c[3], c[4], c[5]),
            distToSegment(tipX, tipY, tipZ, c[12], c[13], c[14], c[15], c[16], c[17]),
          );
          const dS = Math.min(
            distToSegment(tipX, tipY, tipZ, c[6], c[7], c[8], c[9], c[10], c[11]),
            distToSegment(tipX, tipY, tipZ, c[18], c[19], c[20], c[21], c[22], c[23]),
          );
          rThighEff = Math.min(this.rThigh, Math.max(0.065 * sc, dT - 0.008 * sc));
          rShinEff = Math.min(this.rShin, Math.max(0.055 * sc, dS - 0.008 * sc));
        } else {
          const dTor = distToSegment(tipX, tipY, tipZ, c[24], c[25], c[26], c[27], c[28], c[29]);
          rTorsoEff = Math.min(this.rTorso, Math.max(0.065 * sc, dTor - 0.008 * sc));
        }
      }

      const idx = this.nodes.length;
      const node = {
        bone: obj,
        parent: obj.parent,
        parentIdx,
        rootParentIdx,
        chainRootParentIdx: parentIdx >= 0 ? this.nodes[parentIdx].chainRootParentIdx : rootParentIdx,
        kind: cls.kind,
        sector: cls.sector,
        tier: cls.tier,
        len,
        k: omegaN * omegaN,
        dampRate: 2 * baseCfg.zeta * omegaN,
        dampH: 1,
        accelGain: baseCfg.accel * tGain,
        centGain: baseCfg.cent * tGain,
        swirlGain: baseCfg.swirl * tGain,
        dragGain: baseCfg.drag * tGain,
        liftGain: (baseCfg.lift || 0) * tGain,
        bounceGain: (baseCfg.bounce || 0) * tGain,
        cosMax: Math.cos(maxRad),
        sinMax: Math.sin(maxRad),
        sFwd: sDir[0],
        sLeft: sDir[1],
        collideLegs: cls.kind === 'skirt',
        collideThigh: cls.kind === 'skirt' && cls.tier <= 1,
        collideShin: cls.kind === 'skirt' && cls.tier >= 1,
        // Short trimmed chin beard on Nikolai sits tight against his jaw (11 deg max cone); skip torso pushout on slide.
        collideTorso: cls.kind !== 'skirt' && !(priestId === 'nikolai' && cls.kind === 'beard'),
        rThigh: rThighEff,
        rThigh2: rThighEff * rThighEff,
        rShin: rShinEff,
        rShin2: rShinEff * rShinEff,
        rTorso: rTorsoEff,
        rTorso2: rTorsoEff * rTorsoEff,
        parentFollow: cls.kind === 'skirt' ? 0.72 : (cls.kind === 'beard' ? 0.58 : (cls.kind === 'cross' ? 0.62 : 0.74)),
        aqx: obj.quaternion.x, aqy: obj.quaternion.y, aqz: obj.quaternion.z, aqw: obj.quaternion.w,
        wqx: 0, wqy: 0, wqz: 0, wqw: 1,
        hasAnimQuat: false,
        baseHx: hx, baseHy: hy, baseHz: hz,
        animDx: adx, animDy: ady, animDz: adz,
        dx: adx, dy: ady, dz: adz,
        tipX, tipY, tipZ,
        vx: 0, vy: 0, vz: 0,
        collided: false,
        ringMoved: false,
        ringL: -1, ringR: -1,
      };
      this.nodes.push(node);
      indexByBone.set(obj, idx);
    });

    // Minimal ancestor chain (~16 spine/leg/root objects instead of ~90 full-rig bones), built lazily on root.
    this.minimalChain = [];
    this.chainRoot = null;

    // Link circumferential skirt neighbors per tier so the hem moves as one continuous woven bell.
    const skirtIdx = new Map();
    for (let i = 0; i < this.nodes.length; i++) {
      const nd = this.nodes[i];
      if (nd.kind === 'skirt') skirtIdx.set(`${nd.sector}_${nd.tier}`, i);
    }
    for (let tier = 0; tier < 3; tier++) {
      for (let s = 0; s < 8; s++) {
        const cur = skirtIdx.get(`${SKIRT_RING_ORDER[s]}_${tier}`);
        if (cur === undefined) continue;
        const left = skirtIdx.get(`${SKIRT_RING_ORDER[(s + 7) % 8]}_${tier}`);
        const right = skirtIdx.get(`${SKIRT_RING_ORDER[(s + 1) % 8]}_${tier}`);
        if (left !== undefined && right !== undefined) {
          this.nodes[cur].ringL = left;
          this.nodes[cur].ringR = right;
          this.skirtRing[tier].push(cur);
        }
      }
    }

    this.initialized = false;
    this.lastH = -1;
    this.lastDt = -1;
    this.alphaA = 0;
    this.alphaW = 0;
    this.alphaAtt = 0;
    this.prevRootX = 0;
    this.prevRootZ = 0;
    this.memVx = 0;
    this.memVz = 0;
    this.memFacing = 0;
  }

  _buildMinimalChain(root) {
    this.chainRoot = root;
    const needSet = new Set();
    const targets = [this.thighL, this.shinL, this.footL, this.thighR, this.shinR, this.footR, this.hips, this.chest];
    for (const rp of this.rootParents) targets.push(rp.obj);
    for (const t of targets) {
      let cur = t;
      while (cur) {
        needSet.add(cur);
        if (cur === root) break;
        cur = cur.parent;
      }
    }
    this.minimalChain.length = 0;
    const idxMap = new Map();
    const collect = (o) => {
      if (!needSet.has(o)) return;
      const pIdx = o === root ? -1 : (idxMap.get(o.parent) ?? -1);
      const idx = this.minimalChain.length;
      idxMap.set(o, idx);
      this.minimalChain.push({ obj: o, pIdx, wx: 0, wy: 0, wz: 0, qx: 0, qy: 0, qz: 0, qw: 1, wsc: 1 });
      for (let i = 0; i < o.children.length; i++) collect(o.children[i]);
    };
    collect(root);
    for (const rp of this.rootParents) rp.chainIdx = idxMap.get(rp.obj) ?? -1;
    this.capChainIdx = [
      idxMap.get(this.thighL) ?? -1, idxMap.get(this.shinL) ?? -1, idxMap.get(this.footL) ?? -1,
      idxMap.get(this.thighR) ?? -1, idxMap.get(this.shinR) ?? -1, idxMap.get(this.footR) ?? -1,
      idxMap.get(this.hips) ?? -1, idxMap.get(this.chest) ?? -1,
    ];
  }

  _updateMinimalWorldTransforms(root) {
    if (this.chainRoot !== root) this._buildMinimalChain(root);
    const chain = this.minimalChain;
    for (let i = 0; i < chain.length; i++) {
      const e = chain[i];
      const o = e.obj;
      const pos = o.position, q = o.quaternion, sc = o.scale.y;
      if (e.pIdx < 0) {
        e.wx = pos.x; e.wy = pos.y; e.wz = pos.z;
        e.qx = q.x; e.qy = q.y; e.qz = q.z; e.qw = q.w;
        e.wsc = sc;
      } else {
        const pe = chain[e.pIdx];
        const px = pos.x * pe.wsc, py = pos.y * pe.wsc, pz = pos.z * pe.wsc;
        const pqx = pe.qx, pqy = pe.qy, pqz = pe.qz, pqw = pe.qw;
        // Rotate scaled local position by parent world quaternion
        const tx = 2 * (pqy * pz - pqz * py);
        const ty = 2 * (pqz * px - pqx * pz);
        const tz = 2 * (pqx * py - pqy * px);
        e.wx = pe.wx + px + pqw * tx + (pqy * tz - pqz * ty);
        e.wy = pe.wy + py + pqw * ty + (pqz * tx - pqx * tz);
        e.wz = pe.wz + pz + pqw * tz + (pqx * ty - pqy * tx);
        // World quat = parentWorldQuat * localQuat
        const lqx = q.x, lqy = q.y, lqz = q.z, lqw = q.w;
        e.qx = pqx * lqw + pqw * lqx + pqy * lqz - pqz * lqy;
        e.qy = pqy * lqw + pqw * lqy + pqz * lqx - pqx * lqz;
        e.qz = pqz * lqw + pqw * lqz + pqx * lqy - pqy * lqx;
        e.qw = pqw * lqw - pqx * lqx - pqy * lqy - pqz * lqz;
        e.wsc = pe.wsc * sc;
      }
    }
    if (this.hasCaps) {
      const c = this.caps, ci = this.capChainIdx, sc = this.worldScale;
      const tL = chain[ci[0]], sL = chain[ci[1]], fL = chain[ci[2]];
      const tR = chain[ci[3]], sR = chain[ci[4]], fR = chain[ci[5]];
      const hi = chain[ci[6]], ch = chain[ci[7]];
      c[0] = tL.wx; c[1] = tL.wy; c[2] = tL.wz; c[3] = sL.wx; c[4] = sL.wy; c[5] = sL.wz;
      c[6] = sL.wx; c[7] = sL.wy; c[8] = sL.wz; c[9] = fL.wx; c[10] = fL.wy; c[11] = fL.wz;
      c[12] = tR.wx; c[13] = tR.wy; c[14] = tR.wz; c[15] = sR.wx; c[16] = sR.wy; c[17] = sR.wz;
      c[18] = sR.wx; c[19] = sR.wy; c[20] = sR.wz; c[21] = fR.wx; c[22] = fR.wy; c[23] = fR.wz;
      c[24] = hi.wx; c[25] = hi.wy + 0.08 * sc; c[26] = hi.wz; c[27] = ch.wx; c[28] = ch.wy + 0.12 * sc; c[29] = ch.wz;
    }
  }

  _readCapsules() {
    const c = this.caps;
    const sc = this.worldScale;
    const tL = this.thighL.matrixWorld.elements, sL = this.shinL.matrixWorld.elements, fL = this.footL.matrixWorld.elements;
    const tR = this.thighR.matrixWorld.elements, sR = this.shinR.matrixWorld.elements, fR = this.footR.matrixWorld.elements;
    const hi = this.hips.matrixWorld.elements, ch = this.chest.matrixWorld.elements;
    // 0: thighL -> shinL
    c[0] = tL[12]; c[1] = tL[13]; c[2] = tL[14]; c[3] = sL[12]; c[4] = sL[13]; c[5] = sL[14];
    // 1: shinL -> footL
    c[6] = sL[12]; c[7] = sL[13]; c[8] = sL[14]; c[9] = fL[12]; c[10] = fL[13]; c[11] = fL[14];
    // 2: thighR -> shinR
    c[12] = tR[12]; c[13] = tR[13]; c[14] = tR[14]; c[15] = sR[12]; c[16] = sR[13]; c[17] = sR[14];
    // 3: shinR -> footR
    c[18] = sR[12]; c[19] = sR[13]; c[20] = sR[14]; c[21] = fR[12]; c[22] = fR[13]; c[23] = fR[14];
    // 4: hips -> chest (shifted slightly upward to cover ribcage)
    c[24] = hi[12]; c[25] = hi[13] + 0.08 * sc; c[26] = hi[14]; c[27] = ch[12]; c[28] = ch[13] + 0.12 * sc; c[29] = ch[14];
  }

  restoreAnimQuats() {
    const nodes = this.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      if (nd.hasAnimQuat) nd.bone.quaternion.set(nd.aqx, nd.aqy, nd.aqz, nd.aqw);
    }
  }

  reset(root = null, pos = null, vel = null, facing = 0) {
    this.initialized = false;
    this.restoreAnimQuats();
    for (let i = 0; i < this.rootParents.length; i++) {
      const rp = this.rootParents[i];
      rp.hasPrev = false;
      rp.vx = rp.vy = rp.vz = 0;
      rp.ax = rp.ay = rp.az = 0;
    }
    if (!root) {
      for (let i = 0; i < this.nodes.length; i++) {
        const nd = this.nodes[i];
        nd.vx = nd.vy = nd.vz = 0;
      }
      return;
    }
    root.updateMatrixWorld(true);
    for (let i = 0; i < this.nodes.length; i++) {
      const nd = this.nodes[i];
      const bq = nd.bone.quaternion;
      nd.aqx = bq.x; nd.aqy = bq.y; nd.aqz = bq.z; nd.aqw = bq.w;
      nd.hasAnimQuat = true;
      const me = nd.bone.matrixWorld.elements;
      nd.baseHx = me[12]; nd.baseHy = me[13]; nd.baseHz = me[14];
      const yL = Math.hypot(me[4], me[5], me[6]) || 1;
      nd.animDx = nd.dx = me[4] / yL;
      nd.animDy = nd.dy = me[5] / yL;
      nd.animDz = nd.dz = me[6] / yL;
      nd.tipX = nd.baseHx + nd.dx * nd.len;
      nd.tipY = nd.baseHy + nd.dy * nd.len;
      nd.tipZ = nd.baseHz + nd.dz * nd.len;
      nd.vx = nd.vy = nd.vz = 0;
    }
    this.prevRootX = pos ? pos.x : root.position.x;
    this.prevRootZ = pos ? pos.z : root.position.z;
    this.memVx = vel ? (vel.x || 0) : 0;
    this.memVz = vel ? (vel.z || 0) : 0;
    this.memFacing = facing;
    this.initialized = true;
  }

  update(dt, root, a, b, cArg, dArg, eArg, fArg, gArg = false) {
    const nodes = this.nodes;
    const nNodes = nodes.length;
    if (!nNodes) return;

    let rx, rz, tvx, tvz, facing, clipName, riding = false;
    if (typeof a === 'number') {
      rx = a; rz = b; tvx = cArg; tvz = dArg; facing = eArg; clipName = fArg; riding = Boolean(gArg);
    } else {
      const p = a;
      rx = p.pos ? p.pos.x : root.position.x;
      rz = p.pos ? p.pos.z : root.position.z;
      tvx = p.vel ? (p.vel.x || 0) : (dt > 1e-4 ? (rx - this.prevRootX) / dt : 0);
      tvz = p.vel ? (p.vel.z || 0) : (dt > 1e-4 ? (rz - this.prevRootZ) / dt : 0);
      facing = b; clipName = cArg; riding = Boolean(dArg);
    }

    // Snap cleanly on first frame, pause, large hitch, or teleport (kickoff/replay cut/Rematch).
    const jx = rx - this.prevRootX, jz = rz - this.prevRootZ;
    if (!this.initialized || dt <= 1e-5 || dt > 0.12 || jx * jx + jz * jz > 2.25) {
      this.reset(root, { x: rx, z: rz }, { x: tvx, z: tvz }, facing);
      return;
    }

    // 1) Pure scalar (pos, quat) propagation on the ~16 minimal spine/leg nodes (zero Matrix4 calls!).
    this._updateMinimalWorldTransforms(root);

    const chain = this.minimalChain;
    const rps = this.rootParents;
    for (let i = 0; i < nNodes; i++) {
      const nd = nodes[i];
      const bq = nd.bone.quaternion;
      const aqx = bq.x, aqy = bq.y, aqz = bq.z, aqw = bq.w;
      nd.aqx = aqx; nd.aqy = aqy; nd.aqz = aqz; nd.aqw = aqw;
      nd.hasAnimQuat = true;
      let pqx, pqy, pqz, pqw;
      if (nd.parentIdx < 0) {
        const ce = chain[rps[nd.rootParentIdx].chainIdx];
        const bp = nd.bone.position;
        const px = bp.x * ce.wsc, py = bp.y * ce.wsc, pz = bp.z * ce.wsc;
        pqx = ce.qx; pqy = ce.qy; pqz = ce.qz; pqw = ce.qw;
        const tx = 2 * (pqy * pz - pqz * py);
        const ty = 2 * (pqz * px - pqx * pz);
        const tz = 2 * (pqx * py - pqy * px);
        nd.baseHx = ce.wx + px + pqw * tx + (pqy * tz - pqz * ty);
        nd.baseHy = ce.wy + py + pqw * ty + (pqz * tx - pqx * tz);
        nd.baseHz = ce.wz + pz + pqw * tz + (pqx * ty - pqy * tx);
      } else {
        const pnd = nodes[nd.parentIdx];
        pqx = pnd.wqx; pqy = pnd.wqy; pqz = pnd.wqz; pqw = pnd.wqw;
      }
      const wqx = pqx * aqw + pqw * aqx + pqy * aqz - pqz * aqy;
      const wqy = pqy * aqw + pqw * aqy + pqz * aqx - pqx * aqz;
      const wqz = pqz * aqw + pqw * aqz + pqx * aqy - pqy * aqx;
      const wqw = pqw * aqw - pqx * aqx - pqy * aqy - pqz * aqz;
      nd.wqx = wqx; nd.wqy = wqy; nd.wqz = wqz; nd.wqw = wqw;
      nd.animDx = 2 * (wqx * wqy - wqw * wqz);
      nd.animDy = 1 - 2 * (wqx * wqx + wqz * wqz);
      nd.animDz = 2 * (wqy * wqz + wqw * wqx);
    }

    // 2) Fixed-ceiling substep integration (h <= 1/60 s -> 1 substep at 60-144 fps, 2 at 30 fps; stable across 30-144 fps).
    const nSub = Math.min(3, Math.max(1, Math.ceil(dt * 60 - 1e-4)));
    const h = dt / nSub;
    const tauA = 0.064;
    const tauW = 0.052;
    const tauAtt = 0.055;
    if (Math.abs(h - this.lastH) > 1e-6) {
      for (let i = 0; i < nNodes; i++) nodes[i].dampH = Math.exp(-nodes[i].dampRate * h);
      this.alphaA = 1 - Math.exp(-h / tauA);
      this.alphaW = 1 - Math.exp(-h / tauW);
      this.lastH = h;
    }
    if (Math.abs(dt - this.lastDt) > 1e-6) {
      this.alphaAtt = 1 - Math.exp(-dt / tauAtt);
      this.lastDt = dt;
    }
    const alphaA = this.alphaA;
    const alphaW = this.alphaW;
    const alphaAtt = this.alphaAtt;

    const spd = Math.sqrt(tvx * tvx + tvz * tvz);
    // Gate 3D bone-attachment inertia OFF during idle and gentle jog so breathing/jog stay rock-steady,
    // while sprints, cuts, shots, passes, slides, dives & goal celebrations get full lively bounce!
    const rpScale = clipName === 'idle'
      ? 0
      : (clipName === 'run' ? (spd > 3.0 ? Math.min(1, (spd - 3.0) * 0.4) : 0) : 1);

    // Track 3D bone-attachment acceleration ONLY on the ~3 chain-root parents (hips, chest, head) relative to root!
    const invDt = 1 / dt;
    const invTauAtt = 1 / tauAtt;
    let anyRpActive = false;
    for (let r = 0; r < rps.length; r++) {
      const rp = rps[r];
      const ce = chain[rp.chainIdx];
      const relX = ce.wx - rx, relY = ce.wy, relZ = ce.wz - rz;
      if (!rp.hasPrev) {
        rp.px = relX; rp.py = relY; rp.pz = relZ;
        rp.vx = rp.vy = rp.vz = 0;
        rp.ax = rp.ay = rp.az = 0;
        rp.hasPrev = true;
      } else {
        let rvx = (relX - rp.px) * invDt;
        let rvy = (relY - rp.py) * invDt;
        let rvz = (relZ - rp.pz) * invDt;
        const rv2 = rvx * rvx + rvy * rvy + rvz * rvz;
        if (rv2 > 144) { const scv = 12 / Math.sqrt(rv2); rvx *= scv; rvy *= scv; rvz *= scv; }
        const dax = (rvx - rp.vx) * invTauAtt;
        const day = (rvy - rp.vy) * invTauAtt;
        const daz = (rvz - rp.vz) * invTauAtt;
        rp.vx += (rvx - rp.vx) * alphaAtt;
        rp.vy += (rvy - rp.vy) * alphaAtt;
        rp.vz += (rvz - rp.vz) * alphaAtt;
        rp.px = relX; rp.py = relY; rp.pz = relZ;
        if (rpScale === 0) {
          rp.ax = rp.ay = rp.az = 0;
        } else {
          const da2 = dax * dax + day * day + daz * daz;
          if (da2 <= 3.4225) { // 1.85^2 deadzone
            rp.ax = rp.ay = rp.az = 0;
          } else {
            const daMag = Math.sqrt(da2);
            const eff = (Math.min(26, daMag - 1.85) / daMag) * rpScale;
            rp.ax = dax * eff; rp.ay = day * eff; rp.az = daz * eff;
            anyRpActive = true;
          }
        }
      }
    }

    const fwdX = Math.cos(facing), fwdZ = Math.sin(facing);
    const leftX = fwdZ, leftZ = -fwdX;
    const isSlideOrDive = clipName === 'slide' || clipName === 'dive' || clipName === 'dive_R';
    const lowFloor = isSlideOrDive || (clipName === 'celebrate' && this.priestId === 'nikolai');
    const sc = this.worldScale;
    const floorY = (lowFloor ? 0.024 : 0.042) * sc;
    const capPad = 0.0055 * sc;
    const lockCross = clipName === 'celebrate' && this.priestId === 'giorgis';
    const hasCaps = this.hasCaps;
    const c = this.caps;
    // Hoist capsule origins, segment vectors & inverse squared lengths ONCE per frame (5 divisions instead of ~1500!).
    const tL0x = c[0],  tL0y = c[1],  tL0z = c[2],  tLdx = c[3] - tL0x,  tLdy = c[4] - tL0y,  tLdz = c[5] - tL0z;
    const tLab2 = tLdx * tLdx + tLdy * tLdy + tLdz * tLdz, tLinv = tLab2 > 1e-8 ? 1 / tLab2 : 0;
    const sL0x = c[6],  sL0y = c[7],  sL0z = c[8],  sLdx = c[9] - sL0x,  sLdy = c[10] - sL0y, sLdz = c[11] - sL0z;
    const sLab2 = sLdx * sLdx + sLdy * sLdy + sLdz * sLdz, sLinv = sLab2 > 1e-8 ? 1 / sLab2 : 0;
    const tR0x = c[12], tR0y = c[13], tR0z = c[14], tRdx = c[15] - tR0x, tRdy = c[16] - tR0y, tRdz = c[17] - tR0z;
    const tRab2 = tRdx * tRdx + tRdy * tRdy + tRdz * tRdz, tRinv = tRab2 > 1e-8 ? 1 / tRab2 : 0;
    const sR0x = c[18], sR0y = c[19], sR0z = c[20], sRdx = c[21] - sR0x, sRdy = c[22] - sR0y, sRdz = c[23] - sR0z;
    const sRab2 = sRdx * sRdx + sRdy * sRdy + sRdz * sRdz, sRinv = sRab2 > 1e-8 ? 1 / sRab2 : 0;
    const tor0x = c[24], tor0y = c[25], tor0z = c[26], tordx = c[27] - tor0x, tordy = c[28] - tor0y, tordz = c[29] - tor0z;
    const torab2 = tordx * tordx + tordy * tordy + tordz * tordz, torinv = torab2 > 1e-8 ? 1 / torab2 : 0;

    // Quadratic aerodynamic drag with jog deadzone (v <= 2.6 m/s -> 0; full 9.2 m/s sprint -> rich heavy trailing!)
    const dragFactor = spd > 2.6 ? ((spd - 2.6) * (isSlideOrDive ? 1.25 : 1.0)) : 0;
    const dragVx = dragFactor > 0 ? tvx * dragFactor : 0;
    const dragVz = dragFactor > 0 ? tvz * dragFactor : 0;
    const dragLiftBase = dragFactor > 0 ? spd * dragFactor : 0;

    for (let step = 0; step < nSub; step++) {
      // Exponential velocity & heading trackers remove 60 Hz sim staircase jitter on 120/144 Hz monitors.
      let ax = (tvx - this.memVx) / tauA;
      let az = (tvz - this.memVz) / tauA;
      const a2 = ax * ax + az * az;
      if (a2 <= 1.44) { // 1.2^2
        ax = 0; az = 0;
      } else {
        const aMag = Math.sqrt(a2);
        const scA = Math.min(28, aMag - 1.2) / aMag;
        ax *= scA; az *= scA;
      }
      this.memVx += (tvx - this.memVx) * alphaA;
      this.memVz += (tvz - this.memVz) * alphaA;

      const dFace = wrapAngle(facing - this.memFacing);
      let omega = dFace / tauW;
      if (omega > 13) omega = 13; else if (omega < -13) omega = -13;
      this.memFacing = wrapAngle(this.memFacing + dFace * alphaW);
      // Angular-velocity deadzone prevents fidgeting on slow walk curves while popping wide on sharp cuts!
      if (omega > 0.65) omega -= 0.65;
      else if (omega < -0.65) omega += 0.65;
      else omega = 0;
      const omega2 = omega * omega;

      for (let i = 0; i < nNodes; i++) {
        const nd = nodes[i];
        const L = nd.len;
        let hx, hy, hz, tx, ty, tz;
        if (nd.parentIdx >= 0) {
          const pnd = nodes[nd.parentIdx];
          hx = pnd.tipX; hy = pnd.tipY; hz = pnd.tipZ;
          const pf = nd.parentFollow;
          tx = nd.animDx + (pnd.dx - pnd.animDx) * pf;
          ty = nd.animDy + (pnd.dy - pnd.animDy) * pf;
          tz = nd.animDz + (pnd.dz - pnd.animDz) * pf;
          const tInv = 1 / (Math.sqrt(tx * tx + ty * ty + tz * tz) || 1);
          tx *= tInv; ty *= tInv; tz *= tInv;
        } else {
          hx = nd.baseHx; hy = nd.baseHy; hz = nd.baseHz;
          tx = nd.animDx; ty = nd.animDy; tz = nd.animDz;
        }

        if (lockCross && nd.kind === 'cross') {
          nd.dx = tx; nd.dy = ty; nd.dz = tz;
          nd.tipX = hx + tx * L; nd.tipY = hy + ty * L; nd.tipZ = hz + tz * L;
          nd.vx = nd.vy = nd.vz = 0;
          continue;
        }

        let px = hx + nd.dx * L;
        let py = hy + nd.dy * L;
        let pz = hz + nd.dz * L;

        // Sector outward bias in world space
        const biasX = fwdX * nd.sFwd + leftX * nd.sLeft;
        const biasZ = fwdZ * nd.sFwd + leftZ * nd.sLeft;

        // Spring restoring force toward animated clip target
        let fx = nd.k * (hx + tx * L - px);
        let fy = nd.k * (hy + ty * L - py);
        let fz = nd.k * (hz + tz * L - pz);

        // Inertial lag from world linear acceleration (sprint lag, hard-stop forward swing, sharp cut whip)
        if (ax !== 0 || az !== 0) {
          fx -= ax * nd.accelGain;
          fz -= az * nd.accelGain;
        }

        // Real 3D attachment acceleration (kicks, celebration jumps, dive/slide drops, sharp head snaps)
        if (anyRpActive && nd.chainRootParentIdx >= 0) {
          const rp = rps[nd.chainRootParentIdx];
          if (rp.ax !== 0 || rp.ay !== 0 || rp.az !== 0) {
            fx -= rp.ax * nd.accelGain * 0.65;
            fy -= rp.ay * nd.bounceGain;
            fz -= rp.az * nd.accelGain * 0.65;
            // Vertical torso bounce (footstrikes, jumps, shots) pops pectoral cross outward off the chest!
            if (nd.kind === 'cross' && rp.ay !== 0) {
              const outPush = Math.min(18, Math.abs(rp.ay) * nd.bounceGain * 0.85);
              fx += biasX * outPush;
              fz += biasZ * outPush;
              fy += outPush * 0.35;
            }
          }
        }

        // Quadratic aerodynamic drag + subtle upward wind-billow lift on full sprints, slides & dives
        if (dragFactor > 0 && nd.dragGain > 0) {
          fx -= dragVx * nd.dragGain;
          fz -= dragVz * nd.dragGain;
          fy += dragLiftBase * nd.liftGain * 0.32;
        }

        // Rotational centrifugal flare + tangential swirl behind sharp cuts & turns
        if (omega2 > 0.01) {
          const offX = hx - rx, offZ = hz - rz;
          const rOff2 = offX * offX + offZ * offZ;
          if (rOff2 > 0.0004) {
            const rOff = Math.sqrt(rOff2);
            const cent = Math.min(28, omega2 * rOff * 5.2 * nd.centGain);
            const invR = 1 / rOff;
            fx += offX * invR * cent;
            fz += offZ * invR * cent;
            fy += cent * 0.24;
            const sw = omega * 2.8 * nd.swirlGain;
            fx += offZ * sw;
            fz -= offX * sw;
          }
        }

        // Semi-implicit Euler with precomputed exponential damping (zero Math.exp in inner loop!)
        const damp = nd.dampH;
        nd.vx = (nd.vx + fx * h) * damp;
        nd.vy = (nd.vy + fy * h) * damp;
        nd.vz = (nd.vz + fz * h) * damp;
        const v2 = nd.vx * nd.vx + nd.vy * nd.vy + nd.vz * nd.vz;
        if (v2 > 144) { const vs = 12 / Math.sqrt(v2); nd.vx *= vs; nd.vy *= vs; nd.vz *= vs; }

        px += nd.vx * h;
        py += nd.vy * h;
        pz += nd.vz * h;

        // Distance projection
        let dx = px - hx, dy = py - hy, dz = pz - hz;
        let dInv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
        dx *= dInv; dy *= dInv; dz *= dInv;
        px = hx + dx * L; py = hy + dy * L; pz = hz + dz * L;

        // Hull collision pass 1 (tier-culled leg capsules for skirt hems, torso capsule for beards/stoles/veils/cross).
        // Torso radius is dynamically capped to the bone's animated pose clearance so bows/idle never artificially pop beards out.
        let collided = false;
        let rTorsoCur = -1;
        if (hasCaps) {
          if (nd.collideLegs && !riding) {
            if (nd.collideThigh) {
              if (pushOutCapPre(px, py, pz, tL0x, tL0y, tL0z, tLdx, tLdy, tLdz, tLinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true; }
              if (pushOutCapPre(px, py, pz, tR0x, tR0y, tR0z, tRdx, tRdy, tRdz, tRinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true; }
            }
            if (nd.collideShin) {
              if (pushOutCapPre(px, py, pz, sL0x, sL0y, sL0z, sLdx, sLdy, sLdz, sLinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true; }
              if (pushOutCapPre(px, py, pz, sR0x, sR0y, sR0z, sRdx, sRdy, sRdz, sRinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true; }
            }
          } else if (nd.collideTorso) {
            if (pushOutCapPre(px, py, pz, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv, nd.rTorso, nd.rTorso2, biasX, biasZ, capPad)) {
              const animD = distToSegPre(hx + nd.animDx * L, hy + nd.animDy * L, hz + nd.animDz * L, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv);
              if (animD < nd.rTorso) {
                rTorsoCur = Math.max(0.03 * sc, animD - 0.001);
                if (pushOutCapPre(px, py, pz, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv, rTorsoCur, rTorsoCur * rTorsoCur, biasX, biasZ, capPad)) {
                  px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true;
                }
              } else {
                rTorsoCur = nd.rTorso;
                px = _capOutX; py = _capOutY; pz = _capOutZ; collided = true;
              }
            }
          }
        }
        if (nd.collideLegs && py < floorY) { py = floorY; collided = true; }

        dx = px - hx; dy = py - hy; dz = pz - hz;
        dInv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
        dx *= dInv; dy *= dInv; dz *= dInv;

        // Cone angle clamp around animated target direction (zero trig!)
        const dot = dx * tx + dy * ty + dz * tz;
        if (dot < nd.cosMax) {
          let perpX = dx - dot * tx, perpY = dy - dot * ty, perpZ = dz - dot * tz;
          const p2 = perpX * perpX + perpY * perpY + perpZ * perpZ;
          if (p2 > 1e-12) {
            const invP = nd.sinMax / Math.sqrt(p2);
            dx = tx * nd.cosMax + perpX * invP;
            dy = ty * nd.cosMax + perpY * invP;
            dz = tz * nd.cosMax + perpZ * invP;
          } else {
            dx = tx; dy = ty; dz = tz;
          }
          px = hx + dx * L; py = hy + dy * L; pz = hz + dz * L;

          // Hull safety pass 2: leg & torso clearance ALWAYS beats cone clamp at larger sway angles!
          if (hasCaps) {
            let hit2 = false;
            if (nd.collideLegs) {
              if (nd.collideThigh) {
                if (pushOutCapPre(px, py, pz, tL0x, tL0y, tL0z, tLdx, tLdy, tLdz, tLinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true; }
                if (pushOutCapPre(px, py, pz, tR0x, tR0y, tR0z, tRdx, tRdy, tRdz, tRinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true; }
              }
              if (nd.collideShin) {
                if (pushOutCapPre(px, py, pz, sL0x, sL0y, sL0z, sLdx, sLdy, sLdz, sLinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true; }
                if (pushOutCapPre(px, py, pz, sR0x, sR0y, sR0z, sRdx, sRdy, sRdz, sRinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true; }
              }
            } else if (nd.collideTorso) {
              const rProbe = rTorsoCur >= 0 ? rTorsoCur : nd.rTorso;
              if (pushOutCapPre(px, py, pz, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv, rProbe, rProbe * rProbe, biasX, biasZ, capPad)) {
                if (rTorsoCur < 0) {
                  const animD = distToSegPre(hx + nd.animDx * L, hy + nd.animDy * L, hz + nd.animDz * L, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv);
                  rTorsoCur = animD < nd.rTorso ? Math.max(0.03 * sc, animD - 0.001) : nd.rTorso;
                  if (rTorsoCur < rProbe) {
                    if (pushOutCapPre(px, py, pz, tor0x, tor0y, tor0z, tordx, tordy, tordz, torinv, rTorsoCur, rTorsoCur * rTorsoCur, biasX, biasZ, capPad)) {
                      px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true;
                    }
                  } else {
                    px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true;
                  }
                } else {
                  px = _capOutX; py = _capOutY; pz = _capOutZ; hit2 = true;
                }
              }
            }
            if (hit2) {
              dx = px - hx; dy = py - hy; dz = pz - hz;
              dInv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
              dx *= dInv; dy *= dInv; dz *= dInv;
              collided = true;
            }
          }
        }

        // Exact unit-length floor projection for skirt hems (guarantees zero turf penetration during slides/dives!)
        if (nd.collideLegs && hy + dy * L < floorY) {
          const minDy = Math.min(0.95, (floorY - hy) / L);
          const rem = Math.sqrt(Math.max(1e-6, 1 - minDy * minDy));
          const hLen = Math.sqrt(dx * dx + dz * dz);
          if (hLen > 1e-5) { const s = rem / hLen; dx *= s; dz *= s; }
          else { dx = biasX * rem; dz = biasZ * rem; }
          dy = minDy;
          collided = true;
        }

        // Remove radial velocity along bone axis (prevents phantom energy buildup)
        const vRad = nd.vx * dx + nd.vy * dy + nd.vz * dz;
        nd.vx -= vRad * dx; nd.vy -= vRad * dy; nd.vz -= vRad * dz;
        if (collided) { nd.vx *= 0.68; nd.vy *= 0.68; nd.vz *= 0.68; }

        nd.collided = collided;
        nd.dx = dx; nd.dy = dy; nd.dz = dz;
        nd.tipX = hx + dx * L; nd.tipY = hy + dy * L; nd.tipZ = hz + dz * L;
      }

      // Circumferential hem continuity (only runs leg pushout when ring blend shifts inward or parent moved!).
      for (let tier = 0; tier < 3; tier++) {
        const ring = this.skirtRing[tier];
        for (let r = 0; r < ring.length; r++) {
          const nd = nodes[ring[r]];
          const pMoved = nd.parentIdx >= 0 && nodes[nd.parentIdx].ringMoved;
          nd.ringMoved = false;
          let dx = nd.dx, dy = nd.dy, dz = nd.dz;
          let changed = pMoved;
          let checkCaps = pMoved;
          if (!nd.collided) {
            const nL = nodes[nd.ringL], nR = nodes[nd.ringR];
            const ox = nd.animDx + 0.5 * ((nL.dx - nL.animDx) + (nR.dx - nR.animDx)) - dx;
            const oy = nd.animDy + 0.5 * ((nL.dy - nL.animDy) + (nR.dy - nR.animDy)) - dy;
            const oz = nd.animDz + 0.5 * ((nL.dz - nL.animDz) + (nR.dz - nR.animDz)) - dz;
            if (ox * ox + oy * oy + oz * oz > 2.5e-4) {
              const bx = dx + ox * 0.14, by = dy + oy * 0.14, bz = dz + oz * 0.14;
              const bInv = 1 / (Math.sqrt(bx * bx + by * by + bz * bz) || 1);
              const ndx = bx * bInv, ndy = by * bInv, ndz = bz * bInv;
              // Only re-test leg capsules if the ring blend pulled the hem inward toward the leg axis!
              if (!checkCaps) {
                const biasX = fwdX * nd.sFwd + leftX * nd.sLeft;
                const biasZ = fwdZ * nd.sFwd + leftZ * nd.sLeft;
                if ((ndx - dx) * biasX + (ndz - dz) * biasZ < 0) checkCaps = true;
              }
              dx = ndx; dy = ndy; dz = ndz;
              changed = true;
            }
          }
          if (!changed) continue;
          nd.ringMoved = true;
          const hx = nd.parentIdx >= 0 ? nodes[nd.parentIdx].tipX : nd.baseHx;
          const hy = nd.parentIdx >= 0 ? nodes[nd.parentIdx].tipY : nd.baseHy;
          const hz = nd.parentIdx >= 0 ? nodes[nd.parentIdx].tipZ : nd.baseHz;
          const L = nd.len;
          let px = hx + dx * L, py = hy + dy * L, pz = hz + dz * L;
          if (checkCaps && hasCaps) {
            const biasX = fwdX * nd.sFwd + leftX * nd.sLeft;
            const biasZ = fwdZ * nd.sFwd + leftZ * nd.sLeft;
            let hitR = false;
            if (nd.collideThigh) {
              if (pushOutCapPre(px, py, pz, tL0x, tL0y, tL0z, tLdx, tLdy, tLdz, tLinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hitR = true; }
              if (pushOutCapPre(px, py, pz, tR0x, tR0y, tR0z, tRdx, tRdy, tRdz, tRinv, nd.rThigh, nd.rThigh2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hitR = true; }
            }
            if (nd.collideShin) {
              if (pushOutCapPre(px, py, pz, sL0x, sL0y, sL0z, sLdx, sLdy, sLdz, sLinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hitR = true; }
              if (pushOutCapPre(px, py, pz, sR0x, sR0y, sR0z, sRdx, sRdy, sRdz, sRinv, nd.rShin, nd.rShin2, biasX, biasZ, capPad)) { px = _capOutX; py = _capOutY; pz = _capOutZ; hitR = true; }
            }
            if (hitR) {
              dx = px - hx; dy = py - hy; dz = pz - hz;
              const invR = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
              dx *= invR; dy *= invR; dz *= invR;
            }
          }
          if (hy + dy * L < floorY) {
            const minDy = Math.min(0.95, (floorY - hy) / L);
            const rem = Math.sqrt(Math.max(1e-6, 1 - minDy * minDy));
            const hLen = Math.sqrt(dx * dx + dz * dz);
            if (hLen > 1e-5) { const s = rem / hLen; dx *= s; dz *= s; }
            else { dx = (fwdX * nd.sFwd + leftX * nd.sLeft) * rem; dz = (fwdZ * nd.sFwd + leftZ * nd.sLeft) * rem; }
            dy = minDy;
          }
          nd.dx = dx; nd.dy = dy; nd.dz = dz;
          nd.tipX = hx + dx * L; nd.tipY = hy + dy * L; nd.tipZ = hz + dz * L;
        }
      }
    }

    // 3) Inline pure-scalar quaternion writeback (zero Vector3/Quaternion scratch calls!).
    for (let i = 0; i < nNodes; i++) {
      const nd = nodes[i];
      let pqx, pqy, pqz, pqw;
      if (nd.parentIdx >= 0) {
        const pnd = nodes[nd.parentIdx];
        pqx = pnd.wqx; pqy = pnd.wqy; pqz = pnd.wqz; pqw = pnd.wqw;
      } else {
        const ce = chain[rps[nd.rootParentIdx].chainIdx];
        pqx = ce.qx; pqy = ce.qy; pqz = ce.qz; pqw = ce.qw;
      }
      const aqx = nd.aqx, aqy = nd.aqy, aqz = nd.aqz, aqw = nd.aqw;
      const bqx = pqx * aqw + pqw * aqx + pqy * aqz - pqz * aqy;
      const bqy = pqy * aqw + pqw * aqy + pqz * aqx - pqx * aqz;
      const bqz = pqz * aqw + pqw * aqz + pqx * aqy - pqy * aqx;
      const bqw = pqw * aqw - pqx * aqx - pqy * aqy - pqz * aqz;

      const bx = 2 * (bqx * bqy - bqw * bqz);
      const by = 1 - 2 * (bqx * bqx + bqz * bqz);
      const bz = 2 * (bqy * bqz + bqw * bqx);
      const d = bx * nd.dx + by * nd.dy + bz * nd.dz;
      let fqx, fqy, fqz, fqw;
      if (d > 0.999999) {
        fqx = bqx; fqy = bqy; fqz = bqz; fqw = bqw;
      } else {
        let dqx, dqy, dqz, dqw;
        if (d < -0.999999) {
          dqx = Math.abs(bx) < 0.9 ? 0 : -bz; dqy = Math.abs(bx) < 0.9 ? -bz : 0; dqz = Math.abs(bx) < 0.9 ? by : bx;
          const inv = 1 / (Math.sqrt(dqx * dqx + dqy * dqy + dqz * dqz) || 1);
          dqx *= inv; dqy *= inv; dqz *= inv; dqw = 0;
        } else {
          dqx = by * nd.dz - bz * nd.dy;
          dqy = bz * nd.dx - bx * nd.dz;
          dqz = bx * nd.dy - by * nd.dx;
          dqw = 1 + d;
          const inv = 1 / Math.sqrt(dqx * dqx + dqy * dqy + dqz * dqz + dqw * dqw);
          dqx *= inv; dqy *= inv; dqz *= inv; dqw *= inv;
        }
        fqx = dqx * bqw + dqw * bqx + dqy * bqz - dqz * bqy;
        fqy = dqy * bqw + dqw * bqy + dqz * bqx - dqx * bqz;
        fqz = dqz * bqw + dqw * bqz + dqx * bqy - dqy * bqx;
        fqw = dqw * bqw - dqx * bqx - dqy * bqy - dqz * bqz;
      }
      nd.wqx = fqx; nd.wqy = fqy; nd.wqz = fqz; nd.wqw = fqw;
      // Local quat = conjugate(parentWorldQuat) * finalWorldQuat
      const ipx = -pqx, ipy = -pqy, ipz = -pqz, ipw = pqw;
      nd.bone.quaternion.set(
        ipx * fqw + ipw * fqx + ipy * fqz - ipz * fqy,
        ipy * fqw + ipw * fqy + ipz * fqx - ipx * fqz,
        ipz * fqw + ipw * fqz + ipx * fqy - ipy * fqx,
        ipw * fqw - ipx * fqx - ipy * fqy - ipz * fqz,
      );
    }

    this.prevRootX = rx;
    this.prevRootZ = rz;
  }
}

function buildPlaceholder(p, kit = p.info.look) {
  const L = p.info.look;
  const robeMat = new THREE.MeshStandardMaterial({ color: kit.robe, roughness: 0.85 });
  const trimMat = new THREE.MeshStandardMaterial({ color: kit.trim, roughness: 0.4, metalness: 0.6 });
  const skinMat = new THREE.MeshStandardMaterial({ color: 0xe0b394, roughness: 0.7 });
  const hairMat = new THREE.MeshStandardMaterial({ color: L.beard > 0.9 ? 0xeeeeea : 0x3b2a1e, roughness: 0.9 });
  const hatMat = new THREE.MeshStandardMaterial({ color: L.hatColor, roughness: L.hat === 'mitre' ? 0.3 : 0.8, metalness: L.hat === 'mitre' ? 0.7 : 0 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.25, metalness: 0.9 });

  const group = new THREE.Group(), body = new THREE.Group();
  group.add(body);
  const H = 1.75 * L.height, g = L.girth;

  const robe = new THREE.Mesh(new THREE.CylinderGeometry(0.24 * g, 0.42 * g, H * 0.62, 18, 1, true), robeMat);
  robe.position.y = H * 0.31;
  const hem = new THREE.Mesh(new THREE.TorusGeometry(0.42 * g, 0.03, 6, 24), trimMat);
  hem.rotation.x = Math.PI / 2; hem.position.y = 0.04;
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.25 * g, H * 0.2, 6, 14), robeMat);
  torso.position.y = H * 0.68;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), skinMat);
  head.position.y = H * 0.88;
  const beard = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.15 + 0.45 * L.beard, 10), hairMat);
  beard.rotation.x = Math.PI; beard.position.set(0, H * 0.86 - (0.15 + 0.45 * L.beard) / 2, 0.08);
  const hat = buildHat(L.hat, hatMat, goldMat);
  hat.position.y = H * 0.93;
  const cross = buildCross(L.cross, goldMat);
  cross.position.set(0, H * 0.62, 0.26 * g + 0.03);
  const armGeo = new THREE.CapsuleGeometry(0.07, 0.45, 4, 8);
  const armL = new THREE.Mesh(armGeo, robeMat), armR = new THREE.Mesh(armGeo, robeMat);
  armL.position.set(-0.3 * g, H * 0.66, 0); armR.position.set(0.3 * g, H * 0.66, 0);
  armL.geometry.translate(0, -0.25, 0);
  body.add(robe, hem, torso, head, beard, hat, cross, armL, armR);
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group, body, robe, armL, armR, beard, H };
}

function buildHat(kind, mat, gold) {
  const h = new THREE.Group();
  if (kind === 'kalimavkion' || kind === 'kamilavka') {
    const top = kind === 'kalimavkion' ? 0.16 : 0.14;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(top, 0.13, 0.26, 18), mat); c.position.y = 0.1; h.add(c);
    if (kind === 'kalimavkion') { const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 18), mat); brim.position.y = 0.23; h.add(brim); }
  } else if (kind === 'koukoulion') {
    const c = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 18), mat); c.position.y = 0.12; h.add(c);
    const veil = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.8), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, side: THREE.DoubleSide }));
    veil.position.set(0, -0.15, -0.16); h.add(veil);
  } else if (kind === 'klobuk') {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.13, 0.3, 18), mat); c.position.y = 0.12; h.add(c);
    const veil = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.7), new THREE.MeshStandardMaterial({ color: 0x0c0c0c, side: THREE.DoubleSide }));
    veil.position.set(0, -0.08, -0.15); h.add(veil);
  } else if (kind === 'mitre') {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.17, 18, 14), mat); c.scale.y = 1.25; c.position.y = 0.1; h.add(c);
    const k = buildCross(0.25, gold); k.position.y = 0.36; h.add(k);
  } else {
    const c = new THREE.Mesh(new THREE.SphereGeometry(0.135, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat); c.position.y = 0.0; h.add(c);
  }
  return h;
}

function buildCross(size, mat) {
  const g = new THREE.Group();
  const v = new THREE.Mesh(new THREE.BoxGeometry(0.05 * size * 2, 0.5 * size, 0.03), mat);
  const hbar = new THREE.Mesh(new THREE.BoxGeometry(0.32 * size, 0.05 * size * 2, 0.03), mat);
  hbar.position.y = 0.08 * size;
  g.add(v, hbar);
  return g;
}

function animatePlaceholder(v, p, dt, state) {
  const sp = p.speed || 0;
  state.phase += dt * (4 + sp * 1.6);
  const s = state.phase;
  const bob = Math.abs(Math.sin(s)) * Math.min(1, sp / 6) * 0.06;
  v.body.position.y = bob;
  v.body.rotation.x = Math.min(0.25, sp * 0.03);                 // lean into the run
  v.robe.rotation.z = Math.sin(s) * 0.04 * Math.min(1, sp / 4);  // robe swish
  v.beard.rotation.z = Math.sin(s * 0.5 + 1) * 0.08 * Math.min(1, sp / 4);
  const swing = Math.sin(s) * Math.min(0.9, sp * 0.12);
  v.armL.rotation.x = swing; v.armR.rotation.x = -swing;
  if (p.anim === 'kick' || p.anim === 'pass') v.body.rotation.x = -0.25;
  if (p.anim === 'tackle' || p.anim === 'slide') { v.body.rotation.x = 0.7; v.body.position.y = -0.2; }
  if (p.anim === 'dive') { v.body.rotation.z = (p.vel.z * (p.team ? -1 : 1)) > 0 ? -1.2 : 1.2; v.body.position.y = 0.2; }
  else v.body.rotation.z = 0;
  if (p.anim === 'stunned') v.body.rotation.y += dt * 12; else v.body.rotation.y = 0;
  if (p.anim === 'celebrate') { v.armL.rotation.x = v.armR.rotation.x = -2.8; v.body.position.y = Math.abs(Math.sin(s * 1.5)) * 0.3; }
}

// ---------- ball ----------
function ballTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#f5f0e6'; x.fillRect(0, 0, 128, 64);
  x.fillStyle = '#b8862b';
  for (let i = 0; i < 8; i++) { x.beginPath(); x.arc((i * 16 + 8) % 128, i % 2 ? 18 : 46, 7, 0, Math.PI * 2); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Rotate the hue of a material's albedo (after its texture is applied) in YIQ space.
function hueShifted(src, angle) {
  const mat = src.clone();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uHue = { value: angle };
    sh.fragmentShader = 'uniform float uHue;\n' + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        const mat3 toYIQ = mat3(0.299, 0.596, 0.211, 0.587, -0.274, -0.523, 0.114, -0.322, 0.312);
        const mat3 toRGB = mat3(1.0, 1.0, 1.0, 0.956, -0.272, -1.106, 0.621, -0.647, 1.703);
        vec3 yiq = toYIQ * diffuseColor.rgb;
        float c = cos(uHue), s = sin(uHue);
        yiq.yz = vec2(c * yiq.y - s * yiq.z, s * yiq.y + c * yiq.z);
        diffuseColor.rgb = clamp(toRGB * yiq, 0.0, 1.0);
      }`);
  };
  mat.customProgramCacheKey = () => `hue${angle}`;
  return mat;
}
