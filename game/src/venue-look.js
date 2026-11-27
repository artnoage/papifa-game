// Shared look of the three venues: light kit, tone mapping, procedural detail textures and the
// small shader patches that put world-space grain on the turf and on the vertex-coloured scenery.
// Everything here is generated from canvases at load time (no image assets). The low tier
// (?quality=low) keeps the plain materials, so it is never heavier than before.
import * as THREE from 'three';
import { randomSource } from './courtyard-textures.js';

// Late-afternoon light per venue. The sun sits behind the broadcast camera, low enough for long
// shadows, and the hemisphere light keeps the shadow side of the robes readable.
// turf: linear gain baked into the grass (not the chalk) so the warmer, lower sun and the tone-mapping toe leave the
// grass at the same mean colour as before (calibrated by measuring the rendered pitch, chalk excluded).
export const LOOKS = {
  courtyard: {
    exposure: 1.0,
    hemi: [0xdbe6f5, 0x56603c, 1.05],
    sun: [0xffdcae, 2.65],
    sunPos: [27, 30, 26],
    turf: [1.023, 1.076, 1.182],
  },
  meteora: {
    exposure: 1.0,
    hemi: [0xd8e3f2, 0x6b5a44, 1.0],
    sun: [0xffd6a4, 2.75],
    sunPos: [28, 29, 25],
    turf: [1.039, 1.145, 1.302],
  },
  winter: {
    exposure: 0.96,
    hemi: [0xdbe8f7, 0x7e8796, 1.12],
    sun: [0xffe7cf, 2.35],
    sunPos: [26, 27, 27],
    turf: [1.141, 1.093, 1.023],
  },
};

export function setToneMapping(renderer, look) {
  // Khronos PBR Neutral keeps base colours (team kits, rings, chalk) where they were and only
  // rolls off the highlights, so bright plaster and snow stop clipping to flat white.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = look.exposure;
}

function canvas2d(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c.getContext('2d', { willReadFrequently: true });
}

// Periodic value noise on a size x size grid (tiles seamlessly), several octaves.
function tileNoise(size, random, periods, weights) {
  const out = new Float32Array(size * size);
  let total = 0;
  periods.forEach((period, o) => {
    const grid = new Float32Array(period * period).map(() => random());
    const cell = size / period;
    for (let y = 0; y < size; y++) {
      const gy = y / cell, y0 = Math.floor(gy), ty = gy - y0, sy = ty * ty * (3 - 2 * ty);
      const r0 = (y0 % period) * period, r1 = ((y0 + 1) % period) * period;
      for (let x = 0; x < size; x++) {
        const gx = x / cell, x0 = Math.floor(gx), tx = gx - x0, sx = tx * tx * (3 - 2 * tx);
        const c0 = x0 % period, c1 = (x0 + 1) % period;
        const a = grid[r0 + c0] + (grid[r0 + c1] - grid[r0 + c0]) * sx;
        const b = grid[r1 + c0] + (grid[r1 + c1] - grid[r1 + c0]) * sx;
        out[y * size + x] += (a + (b - a) * sy) * weights[o];
      }
    }
    total += weights[o];
  });
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function dataTexture(ctx) {
  const map = new THREE.CanvasTexture(ctx.canvas);
  map.colorSpace = THREE.NoColorSpace;          // raw multipliers, not colours
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

// Scenery detail, packed in one tile: R masonry courses, G rock strata, B weathered grain.
let surfaceCache = null;
function surfaceDetailTexture() {
  if (surfaceCache) return surfaceCache;
  const size = 256, random = randomSource(7321);
  const grain = tileNoise(size, random, [4, 8, 32, 128], [0.35, 0.3, 0.2, 0.15]);
  const strata = tileNoise(size, random, [2, 8, 32], [0.5, 0.3, 0.2]);
  const fine = tileNoise(size, random, [64, 128], [0.5, 0.5]);
  // Masonry: 8 courses of ashlar blocks with mortar joints and per-block tone.
  const masonry = new Float32Array(size * size);
  const course = size / 8;
  for (let row = 0; row < 8; row++) {
    // Block widths that add up to exactly one tile, starting at a random offset (seamless wrap).
    const widths = [];
    let used = 0;
    while (size - used > 80) { const w = 38 + Math.floor(random() * 42); widths.push(w); used += w; }
    if (size - used < 38) widths[widths.length - 1] += size - used;
    else widths.push(size - used);
    const offset = Math.floor(random() * size), tones = widths.map(() => (random() - 0.5) * 0.22);
    for (let y = row * course; y < (row + 1) * course; y++) {
      const fy = y - row * course;
      for (let px = 0; px < size; px++) {
        let local = (px - offset + size) % size, k = 0;
        while (local >= widths[k]) { local -= widths[k]; k++; }
        const edge = Math.min(local, widths[k] - local, fy, course - fy);
        let v = 0.53 + tones[k] + (grain[y * size + px] - 0.5) * 0.35 + (fine[y * size + px] - 0.5) * 0.18;
        if (edge < 1.6) v = 0.22 + (fine[y * size + px] - 0.5) * 0.1;
        else if (edge < 3.5) v -= 0.08 * (3.5 - edge) / 2;
        masonry[y * size + px] = v;
      }
    }
  }
  const ctx = canvas2d(size), img = ctx.createImageData(size, size);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Strata: horizontal bands bent by noise, plus darker vertical weathering streaks.
      const band = Math.sin((y / size) * Math.PI * 2 * 6 + strata[i] * 9) * 0.12;
      const streak = (strata[(x * 7) % size + ((y >> 3) % 4) * size] - 0.5) * 0.25;
      const rock = 0.5 + band + streak + (grain[i] - 0.5) * 0.45 + (fine[i] - 0.5) * 0.2;
      const weathered = 0.5 + (grain[i] - 0.5) * 0.55 + (fine[i] - 0.5) * 0.22;
      img.data.set([clamp(masonry[i]), clamp(rock), clamp(weathered), 255], i * 4);
    }
  }
  ctx.putImageData(img, 0, 0);
  surfaceCache = dataTexture(ctx);
  return surfaceCache;
}

// Detail kinds: 0 soft grain (foliage, people, snow), 1 masonry, 2 rock, 3 weathered stone/plaster.
export const DETAIL = { soft: 0, masonry: 1, rock: 2, plaster: 3 };

// A Lambert vertex-colour material with world-projected surface detail and a little ground
// occlusion at the foot of walls and trees. kind = a DETAIL value for the whole material, or
// 'attribute' to read a per-vertex `detailKind` (merged meshes holding rocks and buildings).
export function detailMaterial(kind, params = {}) {
  const material = new THREE.MeshLambertMaterial({ vertexColors: true, ...params });
  // Plain trilinear filtering: anisotropic sampling over the large Meteora rock faces cost ~13% of
  // desktop frame time for detail that mostly faces the camera anyway.
  const map = surfaceDetailTexture();
  const perVertex = kind === 'attribute';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.surfaceDetail = { value: map };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vDetailPos;
        varying vec3 vDetailNormal;
        varying float vDetailKind;
        ${perVertex ? 'attribute float detailKind;' : ''}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        {
          vec4 wp = vec4( transformed, 1.0 );
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3( instanceMatrix ) * wn;
          #endif
          vDetailPos = ( modelMatrix * wp ).xyz;
          vDetailNormal = mat3( modelMatrix ) * wn;
          vDetailKind = ${perVertex ? 'detailKind' : kind.toFixed(1)};
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D surfaceDetail;
        varying vec3 vDetailPos;
        varying vec3 vDetailNormal;
        varying float vDetailKind;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 an = abs( vDetailNormal );
          vec2 p = an.y > max( an.x, an.z ) ? vDetailPos.xz : ( an.x > an.z ? vDetailPos.zy : vDetailPos.xy );
          float k = vDetailKind;
          // metres per tile: masonry 2.6, rock 7.5, plaster/soft 3.2
          float scale = k < 0.5 ? 0.31 : k < 1.5 ? 0.385 : k < 2.5 ? 0.133 : 0.31;
          vec4 d = texture2D( surfaceDetail, p * scale );
          float v = k < 0.5 ? d.b : k < 1.5 ? d.r : k < 2.5 ? d.g : d.b;
          float strength = k < 0.5 ? 0.38 : k < 1.5 ? 0.85 : k < 2.5 ? 1.0 : 0.62;
          float f = 1.0 + ( v - 0.5 ) * 2.0 * strength;
          // Darken the foot of anything standing on the pitch level (soft contact occlusion).
          float foot = step( -0.25, vDetailPos.y ) * ( 1.0 - smoothstep( 0.0, 1.1, vDetailPos.y ) );
          f *= 1.0 - 0.2 * foot;
          diffuseColor.rgb *= f;
        }`);
  };
  material.customProgramCacheKey = () => 'papifa-surface-' + (perVertex ? 'attr' : kind);
  return material;
}

// Merged venue geometry: tag every vertex with a detail kind (used by 'attribute' materials).
export function tagDetail(geometry, kindOf) {
  const pos = geometry.getAttribute('position');
  const kinds = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) kinds[i] = typeof kindOf === 'function' ? kindOf(pos.getY(i), i) : kindOf;
  geometry.setAttribute('detailKind', new THREE.BufferAttribute(kinds, 1));
  return geometry;
}

// ---------- sky and distant ridges ----------
// The sky is an equirectangular canvas on the upper part of a sphere: canvas row = h * polar angle / PI.
// Horizon colour = fog colour, so fogged scenery dissolves into the sky instead of into white haze.
export const SKIES = {
  courtyard: {
    stops: [[0, '#3c6fa6'], [0.2, '#5a8cbf'], [0.36, '#8fb2cf'], [0.45, '#c9d3cf'], [0.5, '#e6dcc2'], [0.56, '#d8d2b8']],
    fog: 0xdcd5bc, fogRange: [75, 190], ground: 0x8f9a74, glow: [255, 224, 168], haze: 0x9fb6c8,
    clouds: { count: 16, top: 0.27, spread: 0.15, color: [255, 244, 222] },
    plain: { y: -0.3, inner: 60, near: '#62733f', haze: 0.1 },
    ridges: [
      { radius: 200, height: 75, base: -20, color: '#6a82a3', haze: 0.32, seed: 11 },
      { radius: 150, height: 50, base: -20, color: '#5f7660', haze: 0.2, seed: 23, floor: 0.35 },
      { radius: 110, height: 26, base: -8, color: '#4c6340', haze: 0.1, seed: 37, rough: 0.12, floor: 0.3 },
    ],
  },
  meteora: {
    stops: [[0, '#356ba5'], [0.2, '#5689c1'], [0.36, '#8eb0d0'], [0.45, '#cad4d4'], [0.5, '#ecdcc0'], [0.56, '#dccfb5']],
    fog: 0xe0d5bc, fogRange: [70, 200], ground: 0xb4ab92, glow: [255, 220, 160], haze: 0xa3b8cc,
    clouds: { count: 13, top: 0.24, spread: 0.17, color: [255, 242, 218] },
    plain: { y: -34.5, inner: 150, near: '#7d8862', haze: 0.3 },
    ridges: [
      { radius: 215, height: 85, base: -40, color: '#6c82a0', haze: 0.32, seed: 5, sharp: 1.8 },
      { radius: 185, height: 60, base: -40, color: '#5f6f74', haze: 0.2, seed: 17, sharp: 1.5 },
      { radius: 158, height: 30, base: -40, color: '#5e6b48', haze: 0.12, seed: 29, rough: 0.15 },
    ],
  },
  winter: {
    stops: [[0, '#3a6597'], [0.2, '#5d88b8'], [0.36, '#9bb7d3'], [0.45, '#cfdbe7'], [0.5, '#e8eef4'], [0.56, '#dde6ef']],
    fog: 0xe2e9f0, fogRange: [70, 190], ground: 0xd3dfea, glow: [255, 232, 200], haze: 0xb4c6d8,
    clouds: { count: 16, top: 0.22, spread: 0.2, color: [246, 249, 255] },
    plain: { y: -0.3, inner: 88, near: '#c9d6e3', haze: 0.35 },
    ridges: [
      { radius: 205, height: 40, base: -20, color: '#a3b8cc', haze: 0.4, seed: 7, snow: 0.45, sharp: 1.5 },
      { radius: 158, height: 32, base: -20, color: '#8ea5b9', haze: 0.32, seed: 19, snow: 0.3, sharp: 1.3, floor: 0.35 },
      { radius: 125, height: 18, base: -8, color: '#55696c', haze: 0.22, seed: 31, rough: 0.22, floor: 0.3 },
    ],
  },
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function skyTexture(sky, sunDir, low) {
  const w = low ? 768 : 1536, h = w / 2;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  for (const [stop, color] of sky.stops) gradient.addColorStop(stop, color);
  gradient.addColorStop(1, sky.stops[sky.stops.length - 1][1]);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);
  // Sun azimuth on the sphere's u axis (x = -cos(phi), z = sin(phi)) and its elevation.
  const phi = Math.atan2(sunDir.z, -sunDir.x), u = ((phi / (2 * Math.PI)) % 1 + 1) % 1;
  const sunRow = h * (Math.acos(sunDir.clone().normalize().y) / Math.PI);
  function ellipse(x, y, rx, ry, stops) {
    for (const wrap of [-w, 0, w]) {
      ctx.save();
      ctx.translate(x + wrap, y);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      for (const [s, col] of stops) g.addColorStop(s, col);
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    }
  }
  // Warm the horizon on the sun's side, then a glow and a small bright disc at the sun.
  ellipse(u * w, h * 0.5, w * 0.36, h * 0.2, [[0, rgba(sky.glow, 0.42)], [0.6, rgba(sky.glow, 0.14)], [1, rgba(sky.glow, 0)]]);
  ellipse(u * w, sunRow, w * 0.09, h * 0.16, [[0, rgba(sky.glow, 0.7)], [0.35, rgba(sky.glow, 0.28)], [1, rgba(sky.glow, 0)]]);
  ellipse(u * w, sunRow, w * 0.008, h * 0.016, [[0, 'rgba(255,252,240,1)'], [0.7, 'rgba(255,248,228,.9)'], [1, 'rgba(255,248,228,0)']]);
  const random = randomSource(311), cl = sky.clouds;
  for (let i = 0; i < cl.count; i++) {
    const x = random() * w, y = (cl.top + random() * cl.spread) * h, breadth = (0.02 + random() * 0.045) * w;
    const lit = 0.5 + 0.5 * Math.cos((x / w - u) * Math.PI * 2);           // brighter towards the sun
    for (let j = 0; j < 9; j++) {
      const dx = (random() - 0.5) * breadth * 1.8, dy = (random() - 0.5) * h * 0.014;
      const rx = breadth * (0.22 + random() * 0.42), ry = h * (0.006 + random() * 0.013);
      // A faint shaded underside first, then the lit bank: each cloud gets some volume.
      ellipse(x + dx, y + dy + ry * 0.6, rx * 0.95, ry * 0.6, [[0, 'rgba(112,122,148,.08)'], [1, 'rgba(112,122,148,0)']]);
      ellipse(x + dx, y + dy, rx, ry, [[0, rgba(cl.color, 0.34 + 0.2 * lit)], [0.55, rgba(cl.color, 0.18 + 0.1 * lit)], [1, rgba(cl.color, 0)]]);
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

// Sky dome (upper 56% of a sphere) plus a far plain and rings of distant ridges, all in one
// vertex-coloured mesh with a bluish aerial haze baked in (not the pale fog colour, which washed
// them out). The rings sit 110-215 m out with their feet below ground, so from the broadcast
// heights they fill the band above the venue as layered silhouettes: crisp silhouettes at any zoom (the old ridges were
// painted into the sky texture and blurred when the camera came close). One extra draw call on
// every tier. The dome stays inside the camera's 300 m far plane from anywhere on the pitch.
export function addSkyAndRidges(group, scene, sky, { sunDir, low, name }) {
  const radius = 245;
  scene.background = new THREE.Color(sky.ground);
  scene.fog = new THREE.Fog(sky.fog, ...sky.fogRange);
  const frac = 0.56;
  const geo = new THREE.SphereGeometry(radius, low ? 20 : 32, low ? 8 : 12, 0, Math.PI * 2, 0, frac * Math.PI);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - frac + frac * uv.getY(i));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    map: skyTexture(sky, sunDir, low), side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
  }));
  dome.name = name;
  dome.renderOrder = 2;
  group.add(dome);

  const positions = [], colors = [], indices = [];
  const horizon = new THREE.Color(sky.haze), snow = new THREE.Color(0xf3f6fa);
  const segments = low ? 96 : 192;
  function ring(points) {                       // points(i, angle) -> [[x, y, z, color] bottom, [x, y, z, color] top]
    const start = positions.length / 3;
    for (let i = 0; i <= segments; i++) {
      for (const [x, y, z, c] of points(i, (i / segments) * Math.PI * 2)) {
        positions.push(x, y, z);
        colors.push(c.r, c.g, c.b);
      }
      if (i < segments) {
        const b = start + i * 2;
        indices.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
      }
    }
  }
  // The plain fades from hazy countryside at the venue's edge to the horizon colour.
  const plain = sky.plain, plainNear = new THREE.Color(plain.near).lerp(horizon, plain.haze);
  const plainFar = plainNear.clone().lerp(horizon, 0.35);
  const outer = sky.ridges[0].radius + 4;
  ring((i, a) => [
    [Math.cos(a) * plain.inner, plain.y, Math.sin(a) * plain.inner, plainNear],
    [Math.cos(a) * outer, plain.y, Math.sin(a) * outer, plainFar],
  ]);
  for (const layer of sky.ridges) {
    const random = randomSource(layer.seed);
    const harmonics = [2, 3, 5, 8, 13, 21, 34, ...(layer.rough ? [55, 89, 144] : [])];
    const waves = harmonics.map((k) => ({ k, a: Math.pow(k, -0.9) * (0.6 + random() * 0.8) * (k > 34 ? layer.rough * 6 : 1), p: random() * Math.PI * 2 }));
    const total = waves.reduce((sum, v) => sum + v.a, 0);
    const main = new THREE.Color(layer.color);
    // More air in front of the foot of a ridge than in front of its crest.
    const foot = main.clone().lerp(horizon, Math.min(1, layer.haze + 0.15));
    ring((i, a) => {
      let n = 0;
      for (const v of waves) n += v.a * Math.sin(v.k * a + v.p);
      n = Math.min(1, Math.max(0, 0.5 + 0.7 * n / total));
      const floor = layer.floor ?? 0;     // share of the height every point keeps (near rings stay above the plain)
      const top = layer.base + 2 + layer.height * (floor + (1 - floor) * Math.pow(n, layer.sharp ?? 1.2));
      const x = Math.cos(a) * layer.radius, z = Math.sin(a) * layer.radius;
      const crest = main.clone();
      if (layer.snow && n > 1 - layer.snow) crest.lerp(snow, Math.min(1, (n - (1 - layer.snow)) / layer.snow * 2.2));
      crest.lerp(horizon, layer.haze);
      return [[x, layer.base, z, foot], [x, top, z, crest]];
    });
  }
  const ridgeGeo = new THREE.BufferGeometry();
  ridgeGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  ridgeGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  ridgeGeo.setIndex(indices);
  ridgeGeo.computeBoundingSphere();
  const ridges = new THREE.Mesh(ridgeGeo, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false, toneMapped: false,
  }));
  ridges.name = 'Distant ridges';
  ridges.renderOrder = 1;
  group.add(ridges);
  return { dome, ridges };
}
