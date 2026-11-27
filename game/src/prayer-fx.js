// 3D pitch effects for prayers (live + goal replay synchronized):
// 1. Jesus shot: continuous tapered golden light beam behind the ball + soft radial golden light on the shooter.
// 2. Mary goal: glowing celestial blue/white goalposts, crossbar, and shimmering sanctuary net (+ impact ripple on maryBlock).
// 3. Clash: luminous gold-and-blue starburst + expanding shockwave rings at the clash point.
import * as THREE from 'three';

const HISTORY_S = 6.5;
const RIBBON_SEGS = 28;
const TRAIL_LIFE = 0.48;
const SHOOTER_FLASH_LIFE = 0.85;
const BLOCK_RIPPLE_LIFE = 0.75;
const CLASH_BURST_LIFE = 1.45;

function makeGoalGlow(pitch, sign) {
  const HL = pitch.length / 2;
  const GW = pitch.goalWidth / 2;
  const H = pitch.goalHeight;
  const D = pitch.goalDepth;
  const group = new THREE.Group();
  group.name = sign < 0 ? 'Mary glow team 0' : 'Mary glow team 1';
  group.visible = false;

  // Inner bright white-blue core + outer celestial blue aura sheathing posts and crossbar.
  const coreMat = new THREE.MeshBasicMaterial({
    color: 0xeaf7ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const outerMat = new THREE.MeshBasicMaterial({
    color: 0x3ba8ff, transparent: true, opacity: 0.52, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const x = sign * HL;
  for (const [rad, mat] of [[0.095, coreMat], [0.22, outerMat]]) {
    const postGeo = new THREE.CylinderGeometry(rad, rad, H + 0.08, 12);
    const barGeo = new THREE.CylinderGeometry(rad, rad, pitch.goalWidth + 0.2, 12);
    barGeo.rotateX(Math.PI / 2);
    for (const z of [-GW, GW]) {
      const post = new THREE.Mesh(postGeo, mat);
      post.position.set(x, H / 2, z);
      group.add(post);
    }
    const bar = new THREE.Mesh(barGeo, mat);
    bar.position.set(x, H, 0);
    group.add(bar);
  }

  // Translucent shimmering celestial blue/white sanctuary veil across goal mouth.
  const veilMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 },
      uAlpha: { value: 0.62 },
      uPulse: { value: 0 },
      uHitUV: { value: new THREE.Vector2(0.5, 0.5) },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime, uAlpha, uPulse;
      uniform vec2 uHitUV;
      varying vec2 vUv;
      void main() {
        float edgeX = smoothstep(0.0, 0.16, vUv.x) * smoothstep(0.0, 0.16, 1.0 - vUv.x);
        float edgeY = smoothstep(0.0, 0.20, vUv.y) * smoothstep(0.0, 0.16, 1.0 - vUv.y);
        float border = 1.0 - edgeX * edgeY;
        float wave = 0.5 + 0.5 * sin(vUv.x * 18.0 + uTime * 3.4) * cos(vUv.y * 12.0 - uTime * 2.4);
        float dHit = distance(vUv, uHitUV);
        float ripple = uPulse * exp(-pow((dHit - (1.0 - uPulse) * 0.78) * 9.0, 2.0));
        vec3 deepBlue = vec3(0.18, 0.62, 1.0);
        vec3 paleWhite = vec3(0.92, 0.98, 1.0);
        vec3 col = mix(deepBlue, paleWhite, border * 0.62 + wave * 0.22 + ripple * 0.85);
        float a = uAlpha * (0.24 + border * 0.56 + wave * 0.14) + ripple * 0.8;
        gl_FragColor = vec4(col, clamp(a, 0.0, 0.94));
      }`,
  });

  const mouthGeo = new THREE.PlaneGeometry(pitch.goalWidth, H);
  mouthGeo.rotateY(Math.PI / 2);
  const mouth = new THREE.Mesh(mouthGeo, veilMat);
  mouth.position.set(x - sign * 0.04, H / 2, 0);
  group.add(mouth);

  // Soft celestial blue glow along back, roof, and side nets.
  const netMat = new THREE.MeshBasicMaterial({
    color: 0x3ea8ff,
    transparent: true,
    opacity: 0.24,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(pitch.goalWidth, H).rotateY(Math.PI / 2), netMat);
  back.position.set(x + sign * D, H / 2, 0);
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(D, pitch.goalWidth).rotateX(-Math.PI / 2), netMat);
  roof.position.set(x + sign * (D / 2), H, 0);
  const sideGeo = new THREE.PlaneGeometry(D, H);
  for (const z of [-GW, GW]) {
    const s = new THREE.Mesh(sideGeo, netMat);
    s.position.set(x + sign * (D / 2), H / 2, z);
    group.add(s);
  }
  group.add(back, roof);

  return { group, coreMat, outerMat, veilMat, netMat };
}

function makeTrailRibbon() {
  // Two crossed glowing ribbons (horizontal + vertical) along the shot path so it reads smoothly from every camera angle.
  const vertsPerRibbon = (RIBBON_SEGS + 1) * 2;
  const positions = new Float32Array(vertsPerRibbon * 2 * 3);
  const uvs = new Float32Array(vertsPerRibbon * 2 * 2);
  const indices = [];
  for (let r = 0; r < 2; r++) {
    const base = r * vertsPerRibbon;
    for (let i = 0; i <= RIBBON_SEGS; i++) {
      const u = i / RIBBON_SEGS; // 0 = tail, 1 = ball head
      const vi = base + i * 2;
      uvs[vi * 2] = u; uvs[vi * 2 + 1] = 0;
      uvs[(vi + 1) * 2] = u; uvs[(vi + 1) * 2 + 1] = 1;
      if (i < RIBBON_SEGS) {
        indices.push(vi, vi + 1, vi + 2, vi + 1, vi + 3, vi + 2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);

  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uOpacity: { value: 1 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime, uOpacity;
      varying vec2 vUv;
      void main() {
        float across = abs(vUv.y - 0.5) * 2.0; // 0 at center line, 1 at edge
        float core = exp(-across * across * 6.5);
        float halo = pow(max(0.0, 1.0 - across), 1.8);
        float lengthFade = smoothstep(0.0, 0.85, vUv.x);
        float shimmer = 0.88 + 0.12 * sin(vUv.x * 24.0 - uTime * 20.0);
        vec3 col = mix(vec3(1.0, 0.66, 0.14), vec3(1.0, 0.98, 0.82), core);
        float a = uOpacity * lengthFade * shimmer * (core * 0.92 + halo * 0.42);
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Jesus golden trail';
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.renderOrder = 3;
  return { mesh, positions, geo, mat };
}

export function createPrayerEffects(scene) {
  let builtPitchKey = '';
  let goalGlows = [null, null];

  // 1. Jesus continuous golden light ribbon + soft radial ball halo.
  const ribbon = makeTrailRibbon();
  scene.add(ribbon.mesh);

  const ballHaloMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 0.95 } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xy += position.xy;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length((vUv - 0.5) * 2.0);
        float core = exp(-d * d * 5.0);
        float outer = exp(-d * d * 1.9);
        vec3 col = mix(vec3(1.0, 0.75, 0.2), vec3(1.0, 1.0, 0.92), core);
        float a = uOpacity * (core * 0.9 + outer * 0.45) * smoothstep(1.0, 0.25, d);
        if (a < 0.01) discard;
        gl_FragColor = vec4(col, a);
      }`,
  });
  const ballHalo = new THREE.Mesh(new THREE.PlaneGeometry(1.35, 1.35), ballHaloMat);
  ballHalo.name = 'Jesus ball halo';
  ballHalo.visible = false;
  ballHalo.renderOrder = 4;
  scene.add(ballHalo);

  // 2. Soft radial feathered golden light on the shooter (no hard cylinder rim!).
  const shooterGroup = new THREE.Group();
  shooterGroup.name = 'Jesus shooter light';
  shooterGroup.visible = false;
  shooterGroup.renderOrder = 2;
  const shooterGroundMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float d = length((vUv - 0.5) * 2.0);
        float glow = exp(-d * d * 3.2) * smoothstep(1.0, 0.15, d);
        float ring = exp(-pow((d - 0.55) * 7.0, 2.0)) * 0.6;
        vec3 col = mix(vec3(1.0, 0.72, 0.18), vec3(1.0, 0.96, 0.75), glow);
        gl_FragColor = vec4(col, uOpacity * (glow * 0.55 + ring * 0.45));
      }`,
  });
  const shooterGround = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 3.2).rotateX(-Math.PI / 2), shooterGroundMat);
  shooterGround.position.y = 0.04;
  const shooterColumnMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: { uOpacity: { value: 1 } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uOpacity;
      varying vec2 vUv;
      void main() {
        float bottomSoft = smoothstep(0.0, 0.18, vUv.y);
        float topFade = pow(max(0.0, 1.0 - vUv.y), 2.1);
        vec3 col = mix(vec3(1.0, 0.78, 0.24), vec3(1.0, 0.97, 0.8), 1.0 - vUv.y);
        gl_FragColor = vec4(col, uOpacity * bottomSoft * topFade * 0.42);
      }`,
  });
  const shooterBeam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.05, 3.6, 20, 1, true), shooterColumnMat);
  shooterBeam.position.y = 1.8;
  shooterGroup.add(shooterGround, shooterBeam);
  scene.add(shooterGroup);

  // 3. Clash burst of light (soft white-gold core + expanding gold & celestial blue shockwave rings).
  const clashGroup = new THREE.Group();
  clashGroup.name = 'Prayer clash burst';
  clashGroup.visible = false;
  clashGroup.renderOrder = 4;
  const clashCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const clashCore = new THREE.Mesh(new THREE.SphereGeometry(0.65, 16, 12), clashCoreMat);
  const clashGoldMat = new THREE.MeshBasicMaterial({
    color: 0xffd75e, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const clashRingGold = new THREE.Mesh(new THREE.RingGeometry(0.62, 1.0, 32), clashGoldMat);
  const clashBlueMat = new THREE.MeshBasicMaterial({
    color: 0x6ac8ff, transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
  const clashRingBlue = new THREE.Mesh(new THREE.RingGeometry(0.82, 1.2, 32), clashBlueMat);
  clashRingBlue.rotation.y = Math.PI / 2;
  const clashHaloMat = new THREE.MeshBasicMaterial({
    color: 0xdcf4ff, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const clashHalo = new THREE.Mesh(new THREE.SphereGeometry(1.3, 16, 12), clashHaloMat);
  clashGroup.add(clashCore, clashHalo, clashRingGold, clashRingBlue);
  scene.add(clashGroup);

  // Replay-synchronized match-time records.
  let recordedMatch = null;
  const maryHistory = [];    // { t, m0, m1 }
  const trailPts = [];       // { t, x, y, z, shotId }
  const shooterFlashes = []; // { t, x, z }
  const blockRipples = [];   // { t, team, x, y, z }
  const clashBursts = [];    // { t, x, y, z }
  let shotCounter = 0;
  let activeShotRef = null;

  function ensurePitch(pitch) {
    if (!pitch) return;
    const key = `${pitch.length}x${pitch.width}`;
    if (key === builtPitchKey) return;
    builtPitchKey = key;
    for (const g of goalGlows) if (g) scene.remove(g.group);
    goalGlows = [makeGoalGlow(pitch, -1), makeGoalGlow(pitch, 1)];
    scene.add(goalGlows[0].group, goalGlows[1].group);
  }

  function reset() {
    maryHistory.length = 0;
    trailPts.length = 0;
    shooterFlashes.length = 0;
    blockRipples.length = 0;
    clashBursts.length = 0;
    activeShotRef = null;
  }

  function record(m) {
    ensurePitch(m.pitch);
    if (m !== recordedMatch || (maryHistory.length && m.t < maryHistory[maryHistory.length - 1].t)) {
      reset();
      recordedMatch = m;
    }
    const cutoff = m.t - HISTORY_S;
    const m0 = Boolean(m.prayersEnabled && m.prayers?.[0]?.active === 'mary');
    const m1 = Boolean(m.prayersEnabled && m.prayers?.[1]?.active === 'mary');
    if (!maryHistory.length || maryHistory[maryHistory.length - 1].t < m.t) {
      maryHistory.push({ t: m.t, m0, m1 });
    } else {
      maryHistory[maryHistory.length - 1] = { t: m.t, m0, m1 };
    }
    while (maryHistory.length > 2 && maryHistory[0].t < cutoff) maryHistory.shift();

    if (m.ball.shot?.jesus && !m.ball.inNet) {
      const last = trailPts[trailPts.length - 1];
      if (m.ball.shot !== activeShotRef) {
        if (!last || m.t - last.t > 0.2) shotCounter += 1;
        activeShotRef = m.ball.shot;
      }
      if (!last || last.shotId !== shotCounter || Math.hypot(m.ball.pos.x - last.x, m.ball.pos.z - last.z) > 0.08 || m.t - last.t > 0.015) {
        trailPts.push({ t: m.t, x: m.ball.pos.x, y: Math.max(0.22, m.ball.pos.y), z: m.ball.pos.z, shotId: shotCounter });
      }
    }
    while (trailPts.length && trailPts[0].t < cutoff) trailPts.shift();

    for (const p of m.players) {
      if (p.jesusShotT >= 0 && m.t - p.jesusShotT < 0.12) {
        const dup = shooterFlashes.some((f) => Math.abs(f.t - p.jesusShotT) < 0.08 && Math.hypot(f.x - p.pos.x, f.z - p.pos.z) < 2);
        if (!dup) shooterFlashes.push({ t: p.jesusShotT, x: p.pos.x, z: p.pos.z });
      }
    }
    while (shooterFlashes.length && shooterFlashes[0].t < cutoff) shooterFlashes.shift();
    while (blockRipples.length && blockRipples[0].t < cutoff) blockRipples.shift();
    while (clashBursts.length && clashBursts[0].t < cutoff) clashBursts.shift();
  }

  function recordEvents(m, events) {
    if (!events?.length) return;
    ensurePitch(m.pitch);
    const t = m.t;
    for (const e of events) {
      if (e.type === 'maryBlock') {
        blockRipples.push({ t, team: e.team, x: e.x ?? 0, y: e.y ?? 0.9, z: e.z ?? 0 });
      } else if (e.type === 'clash') {
        clashBursts.push({ t, x: e.x ?? 0, y: Math.max(0.5, e.y ?? 1.0), z: e.z ?? 0 });
      } else if (e.type === 'kick' && e.jesus) {
        const bp = m.ball.pos;
        const dup = shooterFlashes.some((f) => Math.abs(f.t - t) < 0.12);
        if (!dup) shooterFlashes.push({ t, x: bp.x, z: bp.z });
        shotCounter += 1;
        activeShotRef = m.ball.shot;
        trailPts.push({ t, x: bp.x, y: Math.max(0.22, bp.y), z: bp.z, shotId: shotCounter });
      }
    }
  }

  function maryActiveAt(t, liveMatch) {
    if (liveMatch) {
      return [
        Boolean(liveMatch.prayersEnabled && liveMatch.prayers?.[0]?.active === 'mary'),
        Boolean(liveMatch.prayersEnabled && liveMatch.prayers?.[1]?.active === 'mary'),
      ];
    }
    if (!maryHistory.length) return [false, false];
    let pick = maryHistory[0];
    for (let i = maryHistory.length - 1; i >= 0; i--) {
      if (maryHistory[i].t <= t) { pick = maryHistory[i]; break; }
    }
    return [pick.m0, pick.m1];
  }

  function updateRibbon(t) {
    // Collect points of the latest Jesus shot within TRAIL_LIFE of `t`.
    let headIdx = -1;
    for (let i = trailPts.length - 1; i >= 0; i--) {
      if (trailPts[i].t <= t) {
        if (t - trailPts[i].t <= TRAIL_LIFE) headIdx = i;
        break;
      }
    }
    if (headIdx < 0) {
      ribbon.mesh.visible = false;
      ballHalo.visible = false;
      return;
    }
    const head = trailPts[headIdx];
    const sid = head.shotId;
    let tailIdx = headIdx;
    while (tailIdx > 0 && trailPts[tailIdx - 1].shotId === sid && t - trailPts[tailIdx - 1].t <= TRAIL_LIFE) {
      tailIdx--;
    }
    const tail = trailPts[tailIdx];
    const dx = head.x - tail.x, dy = head.y - tail.y, dz = head.z - tail.z;
    const len = Math.hypot(dx, dy, dz);
    const fade = Math.max(0, 1 - (t - head.t) / TRAIL_LIFE);

    if (len < 0.15) {
      ribbon.mesh.visible = false;
    } else {
      // Smooth continuous straight beam from tail -> head (with horizontal + vertical crossed planes).
      const hLen = Math.hypot(dx, dz) || 1;
      const sx = -dz / hLen, sz = dx / hLen; // horizontal perpendicular
      const vertsPerRibbon = (RIBBON_SEGS + 1) * 2;
      const pos = ribbon.positions;
      for (let i = 0; i <= RIBBON_SEGS; i++) {
        const u = i / RIBBON_SEGS;
        const px = tail.x + dx * u;
        const py = tail.y + dy * u;
        const pz = tail.z + dz * u;
        const halfW = 0.08 + 0.36 * u;
        // Ribbon 0: horizontal ribbon
        let idx = i * 2 * 3;
        pos[idx] = px - sx * halfW; pos[idx + 1] = py; pos[idx + 2] = pz - sz * halfW;
        pos[idx + 3] = px + sx * halfW; pos[idx + 4] = py; pos[idx + 5] = pz + sz * halfW;
        // Ribbon 1: vertical ribbon
        idx = (vertsPerRibbon + i * 2) * 3;
        pos[idx] = px; pos[idx + 1] = Math.max(0.03, py - halfW); pos[idx + 2] = pz;
        pos[idx + 3] = px; pos[idx + 4] = py + halfW; pos[idx + 5] = pz;
      }
      ribbon.geo.attributes.position.needsUpdate = true;
      ribbon.mat.uniforms.uTime.value = t;
      ribbon.mat.uniforms.uOpacity.value = fade;
      ribbon.mesh.visible = true;
    }

    if (t - head.t < 0.12) {
      ballHalo.visible = true;
      ballHalo.position.set(head.x, head.y, head.z);
      ballHaloMat.uniforms.uOpacity.value = Math.max(0, 1 - (t - head.t) / 0.12);
    } else {
      ballHalo.visible = false;
    }
  }

  function draw(t, pitch, liveMatch = null) {
    ensurePitch(pitch);
    if (t === null || !pitch) {
      for (const g of goalGlows) if (g) g.group.visible = false;
      ribbon.mesh.visible = ballHalo.visible = shooterGroup.visible = clashGroup.visible = false;
      return;
    }

    // 1. Mary glowing goals + maryBlock impact ripples.
    const mary = maryActiveAt(t, liveMatch);
    const GW = pitch.goalWidth / 2, H = pitch.goalHeight;
    for (let team = 0; team < 2; team++) {
      const g = goalGlows[team];
      if (!g) continue;
      let latestRipple = null;
      for (let i = blockRipples.length - 1; i >= 0; i--) {
        const rp = blockRipples[i];
        if (rp.team === team && rp.t <= t && t - rp.t < BLOCK_RIPPLE_LIFE) { latestRipple = rp; break; }
      }
      const on = mary[team] || Boolean(latestRipple);
      g.group.visible = on;
      if (on) {
        const pulse = 0.85 + 0.15 * Math.sin(t * 4.5);
        g.coreMat.opacity = (mary[team] ? 0.84 : 0.35) * pulse;
        g.outerMat.opacity = (mary[team] ? 0.54 : 0.2) * pulse;
        g.netMat.opacity = (mary[team] ? 0.24 : 0.08) * pulse;
        g.veilMat.uniforms.uTime.value = t;
        g.veilMat.uniforms.uAlpha.value = mary[team] ? 0.62 : 0.22;
        if (latestRipple) {
          const u = 1 - (t - latestRipple.t) / BLOCK_RIPPLE_LIFE;
          g.veilMat.uniforms.uPulse.value = u;
          g.veilMat.uniforms.uHitUV.value.set((latestRipple.z + GW) / (2 * GW), Math.max(0, Math.min(1, latestRipple.y / H)));
        } else {
          g.veilMat.uniforms.uPulse.value = 0;
        }
      }
    }

    // 2. Jesus golden light beam + ball halo.
    updateRibbon(t);

    // 3. Soft feathered golden light on shooter.
    let activeFlash = null;
    for (let i = shooterFlashes.length - 1; i >= 0; i--) {
      const f = shooterFlashes[i];
      if (f.t <= t && t - f.t < SHOOTER_FLASH_LIFE) { activeFlash = f; break; }
    }
    if (activeFlash) {
      const age = (t - activeFlash.t) / SHOOTER_FLASH_LIFE;
      const fade = (1 - age) * (1 - age);
      shooterGroup.visible = true;
      shooterGroup.position.set(activeFlash.x, 0, activeFlash.z);
      shooterGround.scale.setScalar(0.85 + age * 0.75);
      shooterGroundMat.uniforms.uOpacity.value = fade;
      shooterBeam.scale.set(0.95 + age * 0.25, 0.85 + age * 0.35, 0.95 + age * 0.25);
      shooterColumnMat.uniforms.uOpacity.value = fade;
    } else {
      shooterGroup.visible = false;
    }

    // 4. Clash radiant burst of gold + blue-white light.
    let activeClash = null;
    for (let i = clashBursts.length - 1; i >= 0; i--) {
      const c = clashBursts[i];
      if (c.t <= t && t - c.t < CLASH_BURST_LIFE) { activeClash = c; break; }
    }
    if (activeClash) {
      const age = (t - activeClash.t) / CLASH_BURST_LIFE;
      const fade = Math.max(0, 1 - age);
      clashGroup.visible = true;
      clashGroup.position.set(activeClash.x, activeClash.y, activeClash.z);
      clashCore.scale.setScalar(0.55 + Math.sin(Math.min(1, age * 3) * Math.PI * 0.5) * 1.15 * fade);
      clashCoreMat.opacity = 0.95 * fade;
      clashHalo.scale.setScalar(0.8 + age * 2.8);
      clashHaloMat.opacity = 0.52 * fade * fade;
      clashRingGold.scale.setScalar(0.6 + age * 4.2);
      clashRingGold.rotation.z = age * 2.5;
      clashGoldMat.opacity = 0.85 * fade;
      clashRingBlue.scale.setScalar(0.5 + age * 3.8);
      clashRingBlue.rotation.x = age * 2.2;
      clashBlueMat.opacity = 0.8 * fade;
    } else {
      clashGroup.visible = false;
    }
  }

  return { record, recordEvents, draw, reset };
}
