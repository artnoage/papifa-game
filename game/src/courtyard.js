import * as THREE from 'three';
import { addBuildings, GeometryBatch } from './courtyard-buildings.js';
import {
  gardenTexture,
  netTexture,
  orchardDepth,
  orchardWidth,
  pavingTexture,
  turfSize,
  turfTexture,
} from './courtyard-textures.js';
import { addSkyAndRidges, LOOKS, setToneMapping, SKIES } from './venue-look.js';

function floor(width, depth, y, material) {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

// Leave the grass footprint empty so phones never shade the paving beneath it.
function groundBorder(material, x, z, outerX, outerZ, tiled) {
  const positions = [], uv = [], indices = [];
  function slab(left, right, near, far) {
    const start = positions.length / 3;
    for (const [px, pz] of [[left, near], [left, far], [right, far], [right, near]]) {
      positions.push(px, -.027, pz);
      if (tiled) uv.push(px / 4, -pz / 4);
      else uv.push(.5 + px / (2 * outerX), .5 - pz / (2 * outerZ));
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  slab(-outerX, outerX, -outerZ, -z);
  slab(-outerX, outerX, z, outerZ);
  slab(-outerX, -x, -z, z);
  slab(x, outerX, -z, z);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const apron = new THREE.Mesh(geometry, material);
  apron.name = tiled ? 'Courtyard paving' : 'Olive garden and gravel paths';
  return apron;
}

function goalFrames(pitch) {
  const frame = new GeometryBatch();
  const half = pitch.goalWidth / 2, height = pitch.goalHeight, depth = pitch.goalDepth;
  function rod(from, to, r, color) {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const delta = end.clone().sub(start), center = start.clone().lerp(end, .5);
    const geometry = new THREE.CylinderGeometry(r, r, delta.length(), 10);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
    frame.add(geometry, color, center.x, center.y, center.z);
  }
  for (const side of [-1, 1]) {
    const x = side * pitch.length / 2, rear = x + side * depth, roof = x + side * depth * .72;
    rod([x, height, -half], [x, height, half], .073, 0xf3efe1);
    rod([rear, .04, -half], [rear, .04, half], .041, 0xb7c1ac);
    rod([roof, height - .25, -half], [roof, height - .25, half], .035, 0xc6c9b7);
    for (const z of [-half, half]) {
      rod([x, 0, z], [x, height, z], .073, 0xf3efe1);
      rod([x, height, z], [roof, height - .25, z], .041, 0xc4c9b6);
      rod([roof, height - .25, z], [rear, .04, z], .037, 0xb4bfaa);
      rod([rear, .04, z], [x, .04, z], .039, 0xc1c7b8);
    }
  }
  const mesh = new THREE.Mesh(frame.finish(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.castShadow = true;
  mesh.name = 'Goal frames';
  return mesh;
}

// Four connected net surfaces per goal. The mouth is open. The roof sags between
// its supports and the rear panel bows out between the anchored corners.
function goalNets(pitch, anisotropy, low) {
  const positions = [], uv = [], indices = [];
  const half = pitch.goalWidth / 2, H = pitch.goalHeight, D = pitch.goalDepth;
  for (const side of [-1, 1]) {
    function point(t, w, h) {
      const middle = 1 - w * w, slack = Math.sin(Math.PI * t), lift = Math.sin(Math.PI * h);
      return [
        side * (pitch.length / 2 + t * D * (1 - .28 * h) + t * .21 * middle * lift),
        h * (H - .25 * t) - h * .16 * middle * slack - t * .05 * middle * h,
        w * (half + .09 * slack * lift),
      ];
    }
    function surface(cols, rows, uCells, vCells, sample) {
      const first = positions.length / 3;
      for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
          const u = c / cols, v = r / rows;
          positions.push(...sample(u, v));
          uv.push(.5 + u * uCells, .5 + v * vCells);
        }
      }
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const a = first + r * (cols + 1) + c, b = a + cols + 1;
          indices.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
    }
    const across = low ? 8 : 16, deep = low ? 3 : 6, high = low ? 4 : 8;
    surface(across, deep, 32, 9, (u, v) => point(v, u * 2 - 1, 1));
    surface(across, high, 32, 10, (u, v) => point(1, u * 2 - 1, v));
    for (const edge of [-1, 1]) surface(deep, high, 9, 10, (u, v) => point(u, edge, v));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(indices);
  const mat = new THREE.MeshBasicMaterial({
    map: netTexture(anisotropy),
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    opacity: .83,
    forceSinglePass: true,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'Sagging goal nets';
  return mesh;
}

function groundShadows(trees, sunSide, pitch) {
  // The scenery never moves. Bake soft contact patches into one draw, leaving the
  // shadow map for the ball, goals and the moving players.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d'), shade = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  shade.addColorStop(0, 'rgba(43,48,43,.43)');
  shade.addColorStop(.55, 'rgba(47,53,46,.29)');
  shade.addColorStop(1, 'rgba(47,53,46,0)');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, 64, 64);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false });
  const geometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const stamps = trees.map(
    (t) => [t.x - sunSide * 1.1 * t.sy, t.z - 1.3 * t.sy, 3.3 * t.sx, 5.5 * t.sy, sunSide * .57],
  );
  const L = pitch.length / 2, W = pitch.width / 2;
  stamps.push([L + 10, -W + 7, 12, 12, 0], [L + 8.8, -W + 1, 5.6, 6.0, 0]);
  for (const side of [-1, 1]) stamps.push([side * (L / 2 - 1), -W - 5, L - 6, 5.8, 0]);
  const mesh = new THREE.InstancedMesh(geometry, mat, stamps.length), transform = new THREE.Object3D();
  stamps.forEach(([x, z, w, d, yaw], i) => {
    transform.position.set(x, -.004, z);
    transform.rotation.y = yaw;
    transform.scale.set(w, 1, d);
    transform.updateMatrix();
    mesh.setMatrixAt(i, transform.matrix);
  });
  mesh.name = 'Courtyard contact shadows';
  mesh.computeBoundingSphere();
  return mesh;
}

export function addPitch(scene, renderer, teams, pitch, low, handheld, { frost = false, look = LOOKS.courtyard } = {}) {
  const sunSide = teams[0].kit === 'away' ? 1 : -1;
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 2 : handheld ? 4 : 8);
  setToneMapping(renderer, look);
  scene.add(new THREE.HemisphereLight(...look.hemi));
  const sun = new THREE.DirectionalLight(...look.sun);
  // Keep the light kit at the same angle to the afternoon sun from either end.
  sun.position.set(sunSide * look.sunPos[0], look.sunPos[1], look.sunPos[2]);
  sun.castShadow = true;
  const shadowSize = low ? 512 : handheld ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  const shadowX = Math.ceil(Math.hypot(pitch.length / 2, pitch.width / 2)) + 7, shadowY = pitch.width / 2 + 13;
  Object.assign(sun.shadow.camera, { left: -shadowX, right: shadowX, top: shadowY, bottom: -shadowY, near: 1, far: 105 });
  scene.add(sun);
  const turf = turfSize(pitch);
  // The turf stays out of tone mapping, like main's whole scene: the pitch is flat, so its colour is a
  // per-channel gain of the light, and the calibrated gain then restores main's stripes exactly, where
  // the Neutral curve would deepen the dark stripes and grey the light ones.
  const turfMaterial = new THREE.MeshLambertMaterial({ map: turfTexture(pitch, low, aniso, frost, look.turf), toneMapped: false });
  const grass = floor(turf.length, turf.width, 0, turfMaterial);
  grass.name = 'Mown pitch';
  grass.receiveShadow = true;
  scene.add(grass, goalFrames(pitch), goalNets(pitch, aniso, low));
}

export function addCourtyard(scene, renderer, teams, pitch, low, handheld) {
  addPitch(scene, renderer, teams, pitch, low, handheld);
  const group = new THREE.Group();
  group.name = 'Monastery courtyard';
  const sunSide = teams[0].kit === 'away' ? 1 : -1, sunPos = LOOKS.courtyard.sunPos;
  addSkyAndRidges(group, scene, SKIES.courtyard, {
    low, name: 'Evening sky', sunDir: new THREE.Vector3(sunSide * sunPos[0], sunPos[1], sunPos[2]),
  });
  const stone = new THREE.MeshBasicMaterial(
    low ? { color: 0xab9c84 } : { color: 0xf0e3ce, map: pavingTexture(Math.min(renderer.capabilities.getMaxAnisotropy(), 2)) },
  );
  const turf = turfSize(pitch), pavedX = pitch.length / 2 + 4.2, pavedZ = pitch.width / 2 + 6;
  group.add(groundBorder(stone, turf.length / 2, turf.width / 2, pavedX, pavedZ, true));
  const orchard = new THREE.MeshBasicMaterial({ map: gardenTexture(pitch, low) });
  group.add(groundBorder(orchard, pavedX, pavedZ, orchardWidth / 2, orchardDepth / 2, false));
  const trees = addBuildings(group, pitch, low, !low && !handheld);
  group.add(groundShadows(trees, sunSide, pitch));
  scene.add(group);
  return { group, landmark: new THREE.Vector3(pitch.length / 2 + 10, 5.5, -pitch.width / 2 + 5.5) };
}
