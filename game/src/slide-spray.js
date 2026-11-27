import * as THREE from 'three';
import { ROSTER } from './config.js';
import { randomSource } from './courtyard-textures.js';
import { SLIDE } from './sim.js';

const CONTACT = 5 / 30, SKID_END = .62, SKID_FADE = 3;
const PLAYER_COUNT = 2 * ROSTER.length, CLODS = 48;
const puffs = [
  { birth: CONTACT, along: -.24, side: -.26, drift: -1.6, sideways: -.85, size: 1.50, angle: .3 },
  { birth: .21, along: -.27, side: .16, drift: -1.1, sideways: 1.15, size: 1.30, angle: 2.2 },
  { birth: .27, along: -.28, side: -.08, drift: -1.8, sideways: .42, size: 1.42, angle: 4.1 },
];

function makePatterns() {
  const rand = randomSource(7501);
  return Array.from({ length: PLAYER_COUNT }, () => [
    ...puffs.map(p => ({ ...p, kind: 0, life: .6, lift: .6 })),
    ...Array.from({ length: CLODS }, (_, i) => {
      const boot = i < 42;
      return {
        kind: boot ? 1 : 2, birth: (boot ? .19 : CONTACT) + rand() * .26,
        along: boot ? .88 + .13 * rand() : -.16, side: (boot ? .17 : -.23) + (rand() - .5) * .28,
        drift: boot ? 4.8 + 3.2 * rand() : -.8 - rand(), sideways: (rand() - .5) * 5.2,
        lift: 1.9 + 1.5 * rand(), life: .48 + .21 * rand(), size: .105 + .045 * rand(), angle: 6.28 * rand(),
      };
    }),
  ]);
}

function makeSprites(capacity) {
  const geometry = new THREE.InstancedBufferGeometry().copy(new THREE.PlaneGeometry(1, 1));
  geometry.setAttribute('center', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('appearance', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, uniforms: { frost: { value: 0 } },
    vertexShader: `
      attribute vec3 center;
      attribute vec4 appearance;
      varying vec2 local;
      varying vec2 kindAlpha;
      void main() {
        vec4 view = modelViewMatrix * vec4(center, 1.0);
        view.xy += position.xy * appearance.x;
        gl_Position = projectionMatrix * view;
        float c = cos(appearance.w), s = sin(appearance.w);
        local = mat2(c, s, -s, c) * (uv - 0.5);
        kindAlpha = appearance.yz;
      }`,
    fragmentShader: `
      uniform float frost;
      varying vec2 local, kindAlpha;
      void main() {
        vec2 p = local;
        vec3 color;
        float coverage;
        if (kindAlpha.x < 0.5) {
          // Overlapping, feathered lobes give the dust an uneven leading edge.
          float a = length((p - vec2(-.08,.04)) * vec2(.96,1.21));
          float b = length((p - vec2(.13,-.06)) * vec2(1.48,1.23));
          float edge = min(a,b) + .018 * sin(16.0*p.x + 4.0*p.y) * cos(14.0*p.y);
          coverage = 1.0 - smoothstep(.13,.47,edge);
          color = mix(vec3(.64,.43,.24),vec3(.86,.91,.91),frost) * (.94 + .10*p.y);
        } else {
          // A torn tuft has a dark soil face and a lighter, irregular grass lip.
          vec2 q = vec2(p.x * (kindAlpha.x > 1.5 ? 1.65 : 1.0) + .14*p.y, p.y);
          float edge = max(abs(q.x)*1.08 + .32*abs(q.y), abs(q.y)*1.16 + .15*q.x);
          coverage = 1.0 - smoothstep(.38,.48,edge);
          vec3 soil = mix(vec3(.075,.039,.016),vec3(.18,.15,.11),frost);
          vec3 grass = mix(vec3(.31,.41,.105),vec3(.64,.72,.62),frost);
          color = mix(soil,grass,smoothstep(-.04,.12,q.y + .08*sin(14.0*q.x)));
        }
        float alpha = kindAlpha.y * coverage;
        if (alpha < .015) discard;
        gl_FragColor = vec4(color, alpha);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'Slide turf spray';
  mesh.frustumCulled = mesh.visible = false;
  mesh.renderOrder = 2;
  return mesh;
}

function makeSkids() {
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  // A priest can begin a second slide while an earlier mark is fading.
  const capacity = PLAYER_COUNT * 3;
  geometry.setAttribute('ink', new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage));
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1,
    uniforms: { frost: { value: 0 } },
    vertexShader: `
      attribute vec2 ink;
      varying vec2 trackUv, strengthSeed;
      void main() {
        trackUv = uv;
        strengthSeed = ink;
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position,1.0);
      }`,
    fragmentShader: `
      uniform float frost;
      varying vec2 trackUv, strengthSeed;
      void main() {
        float u = trackUv.x, seed = strengthSeed.y;
        float v = trackUv.y - .5 + .023*sin(12.0*u + seed) + .012*sin(31.0*u + seed);
        float taper = smoothstep(0.0,.12,u) * (1.0-smoothstep(.75,1.0,u));
        float width = (.26 + .10*u + .048*sin(27.0*u + seed) + .022*sin(71.0*u)) * taper;
        float edge = 1.0-smoothstep(width,width+.045,abs(v));
        float blades = .5 + .5*sin(67.0*v + .75*sin(u*14.0+seed));
        float alpha = strengthSeed.x * edge * taper * (.42 + .39*blades);
        if (alpha < .015) discard;
        vec3 soil = mix(vec3(.068,.047,.018),vec3(.13,.16,.12),frost);
        gl_FragColor = vec4(soil,alpha);
        #include <colorspace_fragment>
      }`,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = 'Slide skid marks';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = mesh.visible = false;
  mesh.renderOrder = -1;
  return mesh;
}

function distance(t, speed) {
  const braking = THREE.MathUtils.clamp(t - SLIDE.launch, 0, speed / SLIDE.decel);
  return speed * Math.min(t, SLIDE.launch) + braking * (speed - .5 * SLIDE.decel * braking);
}

function groundPoint(slide, age, along, side, point) {
  const d = distance(age, slide.speed), { fx, fz } = slide;
  const x = THREE.MathUtils.clamp(slide.x + fx * d, -slide.limitX, slide.limitX);
  const z = THREE.MathUtils.clamp(slide.z + fz * d, -slide.limitZ, slide.limitZ);
  return point.set(x + fx * along + fz * side, 0, z + fz * along - fx * side);
}

// Retain each launch in match time so the turf stays disturbed after the
// priest gets up. A replay evaluates the same launch without emitting it again.
export function createSlideSpray(scene) {
  const patterns = makePatterns();
  const sprites = makeSprites(PLAYER_COUNT * (CLODS + puffs.length)), skids = makeSkids();
  scene.add(sprites, skids);
  const centers = sprites.geometry.getAttribute('center'), looks = sprites.geometry.getAttribute('appearance');
  const ink = skids.geometry.getAttribute('ink'), transform = new THREE.Object3D();
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  const slides = [], active = [];
  let previousMatch, lastTime = -1;

  function record(match, oldestReplayTime) {
    if (match !== previousMatch || match.t < lastTime) {
      slides.length = active.length = 0;
      previousMatch = match;
    }
    lastTime = match.t;
    while (slides.length && slides[0].start + SKID_END + SKID_FADE < oldestReplayTime) slides.shift();
    for (const [slot, p] of match.players.entries()) {
      const current = active[slot], sliding = p.anim === 'slide' && p.actionT > 0 && match.phase !== 'over';
      if (current && sliding && current.direction === p.slideDir) continue;
      if (current) {
        current.stop = Math.min(current.stop, match.t - current.start);
        active[slot] = null;
      }
      if (!sliding) continue;
      const age = SLIDE.clip - p.actionT;
      const speed = Math.max(SLIDE.speed, Math.hypot(p.vel.x, p.vel.z) + SLIDE.decel * Math.max(0, age - SLIDE.launch));
      const fx = Math.cos(p.facing), fz = Math.sin(p.facing), d = distance(age, speed);
      const slide = {
        slot, direction: p.slideDir, start: match.t - age, stop: SKID_END,
        x: p.pos.x - fx * d, z: p.pos.z - fz * d, fx, fz, speed,
        limitX: match.pitch.length / 2 - .5, limitZ: match.pitch.width / 2 - .4,
      };
      active[slot] = slide;
      slides.push(slide);
    }
  }

  function draw(time, field) {
    if (time === null) {
      sprites.visible = skids.visible = false;
      return;
    }
    let count = 0, marks = 0;
    for (const slide of slides) {
      const age = time - slide.start;
      if (age < CONTACT || slide.stop < CONTACT || age >= slide.stop + SKID_FADE) continue;
      groundPoint(slide, CONTACT, -.20, -.12, from);
      groundPoint(slide, Math.min(age, slide.stop), -.20, -.12, to);
      const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
      if (length > .03) {
        transform.position.set((to.x + from.x) * .5, .012, (to.z + from.z) * .5);
        transform.rotation.y = -Math.atan2(dz, dx);
        transform.scale.set(length, 1, .57);
        transform.updateMatrix();
        skids.setMatrixAt(marks, transform.matrix);
        const fade = 1 - THREE.MathUtils.smoothstep(age, slide.stop, slide.stop + SKID_FADE);
        ink.setXY(marks++, fade * Math.min(length / .3, 1), slide.slot + slide.start % 7);
      }
      if (age > 1.15) continue;
      for (const e of patterns[slide.slot]) {
        const t = age - e.birth;
        if (e.birth > slide.stop || t < 0 || t >= e.life) continue;
        const u = t / e.life, puff = e.kind === 0;
        const y = puff ? .21 + e.lift * t : .11 + e.lift * t - 4.9 * t * t;
        if (y < .025) continue;
        groundPoint(slide, e.birth, e.along, e.side, from);
        const x = from.x + (slide.fx * e.drift + slide.fz * e.sideways) * t;
        const z = from.z + (slide.fz * e.drift - slide.fx * e.sideways) * t;
        const size = puff ? e.size * (1 - .47 * (1 - u) ** 2) : e.size;
        const alpha = puff ? .54 * Math.min(1, u * 12) * (1 - u) : 1 - u ** 3;
        centers.setXYZ(count, x, y, z);
        looks.setXYZW(count++, size, e.kind, alpha, e.angle + t * (puff ? .3 : 5));
      }
    }
    sprites.visible = count > 0;
    skids.visible = marks > 0;
    sprites.geometry.instanceCount = count;
    skids.count = marks;
    if (count) {
      sprites.material.uniforms.frost.value = field === 'winter' ? 1 : 0;
      centers.needsUpdate = looks.needsUpdate = true;
    }
    if (marks) {
      skids.material.uniforms.frost.value = field === 'winter' ? 1 : 0;
      ink.needsUpdate = skids.instanceMatrix.needsUpdate = true;
    }
  }
  return { record, draw };
}
