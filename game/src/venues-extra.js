// Additional selectable venues (Meteora Cliff-Top & Winter Russian Monastery) built from
// modular Blender GLB kits (assets/models/venue_meteora.glb & venue_winter.glb).
// Reuses addPitch() from courtyard.js so pitch dimensions, goal nets, shadow camera, and
// kit lighting stay consistent across all three venues at both 3v3 (56x34) and 5v5 (73x44).
// Static venue instances are merged into spatially culled BufferGeometry batches by material
// (separating the east-goal landmark so it frustum-culls during midfield broadcast play).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { addPitch } from './courtyard.js';
import { GeometryBatch } from './courtyard-buildings.js';
import { bannerTexture, randomSource, turfSize } from './courtyard-textures.js';
import { addSkyAndRidges, DETAIL, detailMaterial, LOOKS, SKIES, tagDetail } from './venue-look.js';

const venueLoader = new GLTFLoader();
const venueCache = new Map();

function loadVenueGLB(url) {
  if (!venueCache.has(url)) {
    venueCache.set(url, venueLoader.loadAsync(url).catch((err) => {
      console.warn('Venue GLB load failed:', url, err);
      return null;
    }));
  }
  return venueCache.get(url);
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c.getContext('2d');
}

function makeTex(ctx, anisotropy = 1, repeat = false) {
  const map = new THREE.CanvasTexture(ctx.canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  if (repeat) map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

// Shared per-venue material palette (avoids redundant shader binds & expensive per-pixel PBR envMap IBL).
function createVenueMaterials(low, detail) {
  // Matte scenery reads a per-vertex detail kind (rock, masonry, plaster, soft) on desktop only;
  // phones and ?quality=low keep the plain material (the scenery is small on a phone screen).
  const matte = detail ? detailMaterial('attribute') : new THREE.MeshLambertMaterial({ vertexColors: true });
  const gold = low
    ? new THREE.MeshLambertMaterial({ color: 0xf2c648, emissive: 0x3e2d08 })
    : new THREE.MeshPhongMaterial({
        color: 0xf0c240,
        specular: 0xfff8dc,
        shininess: 92,
        emissive: 0x3b2a06,
      });
  const glow = new THREE.MeshBasicMaterial({ color: 0xf4be5c });
  return { matte, gold, glow };
}

// Hollow ground apron leaving the grass footprint cut out (zero phone overdraw beneath turf).
function groundBorder(material, innerX, innerZ, outerX, outerZ, y = -0.025, tiled = false, tileSize = 4) {
  const positions = [], uv = [], indices = [];
  function slab(left, right, near, far) {
    const start = positions.length / 3;
    for (const [px, pz] of [[left, near], [left, far], [right, far], [right, near]]) {
      positions.push(px, y, pz);
      if (tiled) uv.push(px / tileSize, -pz / tileSize);
      else uv.push(0.5 + px / (2 * outerX), 0.5 - pz / (2 * outerZ));
    }
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  slab(-outerX, outerX, -outerZ, -innerZ);
  slab(-outerX, outerX, innerZ, outerZ);
  slab(-outerX, -innerX, -innerZ, innerZ);
  slab(innerX, outerX, -innerZ, innerZ);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

function addTeamBanners(group, pitch, xEdge, zEdge) {
  const poleBatch = new GeometryBatch();
  const count = Math.max(6, Math.round(pitch.length / 11));
  const spots = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const x = -xEdge + 4.0 + t * (2 * xEdge - 8.0);
    spots.push([x, -zEdge + 0.14, i % 2 === 0, 0]);
  }
  for (const s of [-1, 1]) {
    spots.push([xEdge - 0.14, s * (pitch.width * 0.28), s > 0, -Math.PI / 2]);
    spots.push([-xEdge + 0.14, s * (pitch.width * 0.28), s < 0, Math.PI / 2]);
  }
  const positions = [], uvs = [], indices = [];
  for (const [x, z, isGold, yaw] of spots) {
    poleBatch.cylinder(x, 1.75, z, 0.045, 0.055, 3.5, 0x624d3b, 6);
    poleBatch.cylinder(x, 3.52, z, 0.09, 0.09, 0.12, 0xd8b24c, 8);
    const bx = x + Math.sin(yaw) * 0.18, bz = z + Math.cos(yaw) * 0.18;
    poleBatch.box(bx, 3.18, bz, 1.12, 0.06, 0.06, 0x5c4430, yaw);
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const u0 = isGold ? 0.008 : 0.508;
    const u1 = isGold ? 0.492 : 0.992;
    const base = positions.length / 3;
    const hw = 0.50, yTop = 3.14, yBot = 1.78;
    for (const [lx, py, u, v] of [
      [-hw, yTop, u0, 0.99],
      [ hw, yTop, u1, 0.99],
      [-hw, yBot, u0, 0.01],
      [ hw, yBot, u1, 0.01],
    ]) {
      positions.push(bx + lx * cos, py, bz - lx * sin);
      uvs.push(u, v);
    }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }
  const poles = new THREE.Mesh(poleBatch.finish(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  poles.name = 'Banner poles';
  group.add(poles);

  const clothGeo = new THREE.BufferGeometry();
  clothGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  clothGeo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  clothGeo.setIndex(indices);
  clothGeo.computeBoundingSphere();
  const flags = new THREE.Mesh(clothGeo, new THREE.MeshBasicMaterial({ map: bannerTexture(), side: THREE.DoubleSide }));
  flags.name = 'Team banners';
  group.add(flags);
}

// Extract normalized geometry primitives tagged by material kind ('matte' | 'gold' | 'glow').
function extractKitPiece(gltfScene, name) {
  const node = gltfScene.getObjectByName(name);
  if (!node) return [];
  node.updateMatrixWorld(true);
  const invRoot = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const prims = [];
  node.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone();
    const rel = new THREE.Matrix4().multiplyMatrices(invRoot, o.matrixWorld);
    if (!rel.equals(new THREE.Matrix4())) geo.applyMatrix4(rel);
    const nm = o.material?.name;
    const kind = nm === 'Mat_VenueGold' ? 'gold' : nm === 'Mat_VenueGlow' ? 'glow' : 'matte';
    prims.push({ geo, kind });
  });
  return prims;
}

// Keep instanced helper for named perimeter walls so automated venue checks find them directly.
function addInstancedKit(group, prims, placements, mats, name, kind = DETAIL.soft) {
  if (!prims.length || !placements.length) return;
  for (const { geo, kind: mat } of prims) if (mat === 'matte') tagDetail(geo, kind);
  const dummy = new THREE.Object3D();
  const tone = new THREE.Color();
  prims.forEach(({ geo, kind }, pIdx) => {
    const mat = mats[kind];
    const im = new THREE.InstancedMesh(geo, mat, placements.length);
    placements.forEach(({ x, y = 0, z, yaw = 0, sx = 1, sy = 1, sz = 1, light = 1, tint = null }, i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, yaw, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      im.setMatrixAt(i, dummy.matrix);
      if (kind === 'matte') {
        if (tint) tone.setRGB(tint[0], tint[1], tint[2]);
        else tone.setRGB(light, light, light);
        im.setColorAt(i, tone);
      }
    });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.name = pIdx ? `${name}_${pIdx}` : name;
    im.computeBoundingSphere();
    group.add(im);
  });
}

// Bake static kit placements into one merged BufferGeometry per material kind (zero per-instance
// matrix/color shader overhead, tight bounding sphere for clean frustum culling!).
class StaticKitMerger {
  constructor() {
    this.buckets = {
      matte: { pos: [], norm: [], col: [], det: [], idx: [], vCount: 0 },
      gold:  { pos: [], norm: [], col: null, idx: [], vCount: 0 },
      glow:  { pos: [], norm: [], col: null, idx: [], vCount: 0 },
    };
    this._mat = new THREE.Matrix4();
    this._nmat = new THREE.Matrix3();
    this._pos = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._sc = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._n = new THREE.Vector3();
    this._e = new THREE.Euler();
  }

  // kind: a DETAIL value, or a function of the piece's local height (rock base under a building).
  add(prims, placements, kind = DETAIL.soft) {
    if (!prims.length || !placements.length) return;
    for (const p of placements) {
      const { x, y = 0, z, yaw = 0, sx = 1, sy = 1, sz = 1, light = 1, tint = null } = p;
      this._pos.set(x, y, z);
      this._e.set(0, yaw, 0);
      this._q.setFromEuler(this._e);
      this._sc.set(sx, sy, sz);
      this._mat.compose(this._pos, this._q, this._sc);
      this._nmat.getNormalMatrix(this._mat);
      const tr = tint ? tint[0] : light;
      const tg = tint ? tint[1] : light;
      const tb = tint ? tint[2] : light;

      for (const { geo, kind } of prims) {
        const b = this.buckets[kind];
        const posAttr = geo.attributes.position;
        const normAttr = geo.attributes.normal;
        const colAttr = kind === 'matte' ? geo.attributes.color : null;
        const base = b.vCount;
        const nVerts = posAttr.count;
        for (let i = 0; i < nVerts; i++) {
          this._v.fromBufferAttribute(posAttr, i).applyMatrix4(this._mat);
          b.pos.push(this._v.x, this._v.y, this._v.z);
          if (normAttr) {
            this._n.fromBufferAttribute(normAttr, i).applyMatrix3(this._nmat).normalize();
            b.norm.push(this._n.x, this._n.y, this._n.z);
          } else {
            b.norm.push(0, 1, 0);
          }
          if (b.det) b.det.push(typeof kind === 'function' ? kind(posAttr.getY(i)) : kind);
          if (b.col) {
            if (colAttr) {
              b.col.push(
                Math.min(1, colAttr.getX(i) * tr),
                Math.min(1, colAttr.getY(i) * tg),
                Math.min(1, colAttr.getZ(i) * tb),
              );
            } else {
              b.col.push(tr, tg, tb);
            }
          }
        }
        const indexAttr = geo.index;
        if (indexAttr) {
          for (let i = 0; i < indexAttr.count; i++) b.idx.push(base + indexAttr.getX(i));
        } else {
          for (let i = 0; i < nVerts; i++) b.idx.push(base + i);
        }
        b.vCount += nVerts;
      }
    }
  }

  emit(group, mats, label) {
    for (const kind of ['matte', 'gold', 'glow']) {
      const b = this.buckets[kind];
      if (!b.vCount) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(b.norm, 3));
      if (b.col) geo.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
      if (b.det) geo.setAttribute('detailKind', new THREE.Float32BufferAttribute(b.det, 1));
      geo.setIndex(b.idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[kind]);
      mesh.name = kind === 'matte' ? label : `${label}_${kind}`;
      group.add(mesh);
    }
  }
}

// Desktop only: a second, staggered row of onlookers behind the first, kept clear of tree trunks.
// They merge into the existing static batches, so the crowd costs triangles but no draw calls.
function backRowMonks(rnd, HL, z, treeXs) {
  const spots = [], count = 18;
  for (let i = 0; i < count; i++) {
    const x = (-0.9 + (1.8 * (i + 0.5)) / count) * HL + (rnd() - 0.5) * 1.2;
    if (Math.abs(x) < HL * 0.06 || treeXs.some((t) => Math.abs(t - x) < 1.3)) continue;
    spots.push({
      x,
      y: 0.0,
      z: z - rnd() * 0.3,
      yaw: (rnd() - 0.5) * 0.5,
      sx: 0.92 + rnd() * 0.14,
      sy: 0.9 + rnd() * 0.2,
      sz: 0.92 + rnd() * 0.14,
      light: 0.8 + rnd() * 0.25,
    });
  }
  return spots;
}

function addBakedContactShadows(group, stamps, colorRgba = 'rgba(40,42,38,.40)') {
  if (!stamps.length) return;
  const ctx = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, colorRgba);
  g.addColorStop(0.55, colorRgba.replace(/\.[\d]+\)$/, '.22)'));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const mat = new THREE.MeshBasicMaterial({ map: makeTex(ctx), transparent: true, depthWrite: false });
  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const im = new THREE.InstancedMesh(geo, mat, stamps.length);
  const dummy = new THREE.Object3D();
  stamps.forEach(([x, z, w, d, yaw = 0], i) => {
    dummy.position.set(x, -0.005, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(w, 1, d);
    dummy.updateMatrix();
    im.setMatrixAt(i, dummy.matrix);
  });
  im.computeBoundingSphere();
  im.name = 'Venue contact shadows';
  group.add(im);
}

// =========================================================================
// VENUE 2: METEORA CLIFF-TOP MONASTERY
// =========================================================================
function meteoraPlateauTexture(anisotropy) {
  const ctx = makeCanvas(256, 256), rnd = randomSource(733);
  ctx.fillStyle = '#c4b397';
  ctx.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 8; row++) {
    for (let col = -1; col < 5; col++) {
      const n = Math.round(rnd() * 20);
      ctx.fillStyle = `rgb(${194 + n},${178 + n},${150 + n})`;
      ctx.fillRect(col * 64 + (row % 2) * 32 + 1, row * 32 + 1, 62, 30);
    }
  }
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = '#8b7960';
  for (let i = 0; i < 3600; i++) ctx.fillRect(rnd() * 256, rnd() * 256, 1.3, 1.3);
  return makeTex(ctx, anisotropy, true);
}

// Rich sunlit Thessalian valley floor baked with warm atmospheric mist (512x512, hollow cutout under pitch!).
function meteoraValleyTexture() {
  const s = 512;
  const ctx = makeCanvas(s, s), rnd = randomSource(881);
  ctx.fillStyle = '#7e9069';
  ctx.fillRect(0, 0, s, s);
  const tones = ['#6c825a', '#8d9b6f', '#b2a37a', '#647d58', '#a3936e', '#7c8f66'];
  for (let i = 0; i < 200; i++) {
    ctx.fillStyle = tones[i % tones.length];
    ctx.globalAlpha = 0.58;
    ctx.fillRect(rnd() * s, rnd() * s, 12 + rnd() * 44, 10 + rnd() * 36);
  }
  ctx.globalAlpha = 0.68;
  ctx.fillStyle = '#bc6848';
  for (let i = 0; i < 45; i++) {
    ctx.fillRect(s * (0.18 + rnd() * 0.64), s * (0.18 + rnd() * 0.64), 3 + rnd() * 4, 2 + rnd() * 3);
  }
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = '#88acc0';
  ctx.lineWidth = s * 0.020;
  ctx.beginPath();
  ctx.moveTo(0, s * 0.34);
  ctx.bezierCurveTo(s * 0.3, s * 0.42, s * 0.6, s * 0.25, s, s * 0.38);
  ctx.stroke();
  ctx.globalAlpha = 1.0;
  const haze = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.12, s * 0.5, s * 0.5, s * 0.50);
  haze.addColorStop(0.0, 'rgba(218,208,188,0.28)');
  haze.addColorStop(0.62, 'rgba(218,208,188,0.56)');
  haze.addColorStop(1.0, 'rgba(212,202,181,1.0)');
  ctx.fillStyle = haze;
  ctx.fillRect(0, 0, s, s);
  return makeTex(ctx, 1);
}

export function addMeteora(scene, renderer, teams, pitch, low = false, handheld = false) {
  addPitch(scene, renderer, teams, pitch, low, handheld, { look: LOOKS.meteora });
  const group = new THREE.Group();
  group.name = 'Meteora cliff-top';
  const HL = pitch.length / 2, HW = pitch.width / 2;
  const sunSide = teams[0].kit === 'away' ? 1 : -1;
  const aniso = Math.min(renderer.capabilities.getMaxAnisotropy(), low ? 2 : handheld ? 4 : 8);

  const sunPos = LOOKS.meteora.sunPos;
  addSkyAndRidges(group, scene, SKIES.meteora, {
    low, name: 'Meteora sky', sunDir: new THREE.Vector3(sunSide * sunPos[0], sunPos[1], sunPos[2]),
  });

  const turf = turfSize(pitch);
  const xEdge = HL + 4.0, zEdge = HW + 2.2;

  // Hollow valley border around the cliff plateau (ZERO pixel overdraw under grass; dropped in low mode!)
  if (!low) {
    const valley = groundBorder(
      new THREE.MeshBasicMaterial({ map: meteoraValleyTexture() }),
      xEdge - 0.5, zEdge - 0.5, 165, 165, -34, false,
    );
    valley.renderOrder = 1;
    valley.name = 'Thessalian valley below';
    group.add(valley);
  }

  const platMat = new THREE.MeshBasicMaterial(
    low ? { color: 0xc5b498 } : { color: 0xf7eee0, map: meteoraPlateauTexture(Math.min(aniso, 2)) },
  );
  const plateau = groundBorder(platMat, turf.length / 2, turf.width / 2, xEdge + 0.5, zEdge + 0.5, -0.025, true, 4.5);
  plateau.name = 'Cliff-top limestone terrace';
  group.add(plateau);
  addTeamBanners(group, pitch, xEdge, zEdge);

  const ready = loadVenueGLB('assets/models/venue_meteora.glb').then((gltf) => {
    if (!gltf) return;
    const mats = createVenueMaterials(low, !low && !handheld);
    const rnd = randomSource(3031);

    // Detail kinds: cliff rock under masonry parapets; rock pinnacles under plastered monasteries.
    const rimKind = (y) => (y < 0 ? DETAIL.rock : DETAIL.masonry);
    const pinnacleKind = (y) => (y < 7.5 ? DETAIL.rock : DETAIL.plaster);
    const sketeKind = (y) => (y < 2.7 ? DETAIL.rock : DETAIL.plaster);
    // Split perimeter parapet into 4 frustum-cullable sides (keeps 'Meteora cliff parapet' name for venue checks)
    const rimPrims = extractKitPiece(gltf.scene, 'CliffRimBay');
    const nX = Math.max(12, Math.round((2 * xEdge) / 4.0));
    const nZ = Math.max(8, Math.round((2 * zEdge) / 4.0));
    const sxX = (2 * xEdge) / (nX * 4.0);
    const sxZ = (2 * zEdge) / (nZ * 4.0);
    for (const side of [-1, 1]) {
      const longSpots = [], shortSpots = [];
      for (let i = 0; i < nX; i++) {
        longSpots.push({
          x: -xEdge + (i + 0.5) * (2 * xEdge / nX),
          z: side * zEdge,
          yaw: side > 0 ? Math.PI : 0,
          sx: sxX,
          sy: side > 0 ? 0.50 : 1.0,
          light: 0.90 + rnd() * 0.12,
        });
      }
      for (let i = 0; i < nZ; i++) {
        shortSpots.push({
          x: side * xEdge,
          z: -zEdge + (i + 0.5) * (2 * zEdge / nZ),
          yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2,
          sx: sxZ,
          sy: 1.0,
          light: 0.90 + rnd() * 0.12,
        });
      }
      addInstancedKit(group, rimPrims, longSpots, mats, side < 0 ? 'Meteora cliff parapet' : 'Meteora cliff parapet south', rimKind);
      addInstancedKit(group, rimPrims, shortSpots, mats, side < 0 ? 'Meteora cliff parapet west' : 'Meteora cliff parapet east', rimKind);
    }

    // Spatially split merged static batches (west / east / far) so off-screen sides frustum-cull cleanly!
    const northWest = new StaticKitMerger();
    const northEast = new StaticKitMerger();
    const eastMerger = new StaticKitMerger();
    const farWest = new StaticKitMerger();
    const farEast = new StaticKitMerger();
    const addSplit = (west, east, prims, list, kind) => {
      const lw = [], le = [];
      for (const p of list) (p.x < 0 ? lw : le).push(p);
      west.add(prims, lw, kind);
      east.add(prims, le, kind);
    };

    const cornerPrims = extractKitPiece(gltf.scene, 'CliffCorner');
    addSplit(northWest, northEast, cornerPrims, [
      { x: -xEdge, z: -zEdge, sy: 1.0 },
      { x:  xEdge, z: -zEdge, sy: 1.0 },
      { x: -xEdge, z:  zEdge, sy: 0.45 },
      { x:  xEdge, z:  zEdge, sy: 0.45 },
    ], rimKind);

    // Visible outer sheer cliff face along south & east edges only (dropped in low mode!)
    if (!low) {
      const skirtPrims = extractKitPiece(gltf.scene, 'CliffSkirt');
      const skirtSpots = [];
      const skX = Math.max(6, Math.round((2 * xEdge) / 8.0));
      const skZ = Math.max(4, Math.round((2 * zEdge) / 8.0));
      for (let i = 0; i < skX; i++) {
        skirtSpots.push({
          x: -xEdge + (i + 0.5) * (2 * xEdge / skX),
          z: zEdge + 0.5,
          yaw: 0,
          sx: (2 * xEdge) / (skX * 8.0) * 1.03,
          light: 0.88 + rnd() * 0.14,
        });
      }
      for (let i = 0; i < skZ; i++) {
        skirtSpots.push({
          x: xEdge + 0.5,
          z: -zEdge + (i + 0.5) * (2 * zEdge / skZ),
          yaw: Math.PI / 2,
          sx: (2 * zEdge) / (skZ * 8.0) * 1.03,
          light: 0.88 + rnd() * 0.14,
        });
      }
      addSplit(northWest, eastMerger, skirtPrims, skirtSpots, DETAIL.rock);
    }

    // East-goal hero monastery on sheer narrow pinnacle (culls cleanly when camera is away from east end!)
    const monPrims = extractKitPiece(gltf.scene, 'MonasteryPinnacle');
    eastMerger.add(monPrims, [
      { x: HL + 19.6, y: 0.0, z: -3.2, yaw: 0.12, sx: 0.96, sy: 0.94, sz: 0.96, light: 1.0 },
    ], pinnacleKind);
    if (!low) {
      farWest.add(monPrims, [
        { x: -HL - 35.0, y: 2.0, z: -HW - 34.0, yaw: -2.4, sx: 0.78, sy: 0.82, sz: 0.78, tint: [0.80, 0.84, 0.90] },
      ], pinnacleKind);
    }

    // Broadcast-framed north cliff skete(s) perched on rock pillars right across the north chasm!
    const sketePrims = extractKitPiece(gltf.scene, 'NorthCliffSkete');
    const sketeSpots = [
      { x: HL * 0.18, y: -1.4, z: -zEdge - 7.8, yaw: -0.06, sx: 0.92, sy: 0.86, sz: 0.92, tint: [1.04, 0.99, 0.93] },
    ];
    if (!low) {
      sketeSpots.push({ x: -HL * 0.58, y: -2.2, z: -zEdge - 9.4, yaw: 0.14, sx: 0.78, sy: 0.74, sz: 0.78, tint: [0.97, 0.94, 0.90] });
    }
    addSplit(northWest, northEast, sketePrims, sketeSpots, sketeKind);

    // Foreground chasm rocks (warm near tint) + mid/far hazy Meteora spires (far layer dropped in low mode!)
    const needlePrims = extractKitPiece(gltf.scene, 'RockNeedle');
    const mesaPrims = extractKitPiece(gltf.scene, 'RockMesa');
    const nearWarm = [1.06, 0.98, 0.89];
    const midSoft  = [0.90, 0.89, 0.90];
    const farHaze  = [0.74, 0.81, 0.90];

    addSplit(northWest, northEast, needlePrims, [
      { x: -HL * 0.22, y: -11.5, z: -zEdge - 6.8, yaw: 0.6, sx: 0.78, sy: 0.92, sz: 0.78, tint: nearWarm },
      { x:  HL * 0.62, y: -10.5, z: -zEdge - 7.4, yaw: 2.3, sx: 0.82, sy: 0.94, sz: 0.80, tint: nearWarm },
    ], DETAIL.rock);
    addSplit(northWest, northEast, mesaPrims, low ? [
      { x: -HL * 0.82, y: -4.8,  z: -zEdge - 8.4, yaw: 0.5, sx: 0.82, sy: 0.92, sz: 0.78, tint: nearWarm },
      { x:  HL * 0.88, y: -4.2,  z: -zEdge - 9.0, yaw: 4.1, sx: 0.84, sy: 0.94, sz: 0.80, tint: nearWarm },
    ] : [
      { x: -HL * 0.88, y: -4.8,  z: -zEdge - 8.4, yaw: 0.5, sx: 0.82, sy: 0.92, sz: 0.78, tint: nearWarm },
      { x: -HL * 0.04, y: -5.4,  z: -zEdge - 11.2,yaw: 2.7, sx: 0.86, sy: 0.90, sz: 0.82, tint: [0.98, 0.94, 0.89] },
      { x:  HL * 0.88, y: -4.2,  z: -zEdge - 9.0, yaw: 4.1, sx: 0.84, sy: 0.94, sz: 0.80, tint: nearWarm },
    ], DETAIL.rock);

    // East replay flanking needles (culled in midfield broadcast!)
    eastMerger.add(needlePrims, [
      { x: HL + 27, y: -2.0, z: -HW - 18, yaw: 0.9, sx: 1.05, sy: 1.12, sz: 1.02, tint: midSoft },
      { x: HL + 33, y: -4.0, z:  13,      yaw: 3.4, sx: 1.00, sy: 0.92, sz: 1.00, tint: midSoft },
    ], DETAIL.rock);

    if (!low) {
      addSplit(farWest, farEast, needlePrims, [
        { x: -HL - 19,   y:  0.0, z: -HW - 14, yaw: 0.4, sx: 1.05, sy: 1.10, sz: 1.02, tint: midSoft },
        { x: -HL * 0.44, y:  2.0, z: -HW - 28, yaw: 1.7, sx: 1.12, sy: 1.28, sz: 1.08, tint: midSoft },
        { x:  HL * 0.34, y:  5.0, z: -HW - 42, yaw: 2.8, sx: 1.32, sy: 1.42, sz: 1.25, tint: farHaze },
        { x: -HL * 0.08, y:  6.0, z: -HW - 52, yaw: 4.1, sx: 1.45, sy: 1.55, sz: 1.35, tint: farHaze },
        { x: -HL - 38,   y:  2.0, z: -HW - 36, yaw: 1.2, sx: 1.30, sy: 1.35, sz: 1.22, tint: farHaze },
        { x:  HL + 44,   y:  3.0, z: -11,      yaw: 1.9, sx: 1.32, sy: 1.30, sz: 1.24, tint: farHaze },
      ], DETAIL.rock);
      addSplit(farWest, farEast, mesaPrims, [
        { x:  HL * 0.68, y:  1.0, z: -HW - 26, yaw: 0.3, sx: 1.10, sy: 1.25, sz: 1.05, tint: midSoft },
        { x: -HL - 29,   y: -2.0, z:  11,      yaw: 4.6, sx: 1.08, sy: 1.05, sz: 1.02, tint: midSoft },
        { x: -HL * 0.72, y:  3.0, z: -HW - 44, yaw: 1.4, sx: 1.38, sy: 1.45, sz: 1.28, tint: farHaze },
        { x:  HL * 0.92, y:  2.0, z: -HW - 42, yaw: 3.1, sx: 1.34, sy: 1.38, sz: 1.26, tint: farHaze },
      ], DETAIL.rock);
    }

    const cypPrims = extractKitPiece(gltf.scene, 'CypressTree');
    const oliPrims = extractKitPiece(gltf.scene, 'OliveTree');
    const cypSpots = [
      { x: -xEdge + 3.2, y: -0.2, z: -zEdge - 1.7, yaw: 0.4, sx: 0.92, sy: 0.88, sz: 0.92, light: 0.95 },
      { x: -HL * 0.36,   y: -0.4, z: -zEdge - 2.0, yaw: 1.9, sx: 0.85, sy: 0.82, sz: 0.85, light: 0.93 },
      { x:  HL * 0.44,   y: -0.3, z: -zEdge - 1.9, yaw: 3.2, sx: 0.88, sy: 0.85, sz: 0.88, light: 0.96 },
      { x:  xEdge - 2.6, y: -0.2, z: -zEdge - 1.6, yaw: 0.8, sx: 0.95, sy: 0.92, sz: 0.95, light: 0.97 },
    ];
    const cypEast = [
      { x:  xEdge + 1.8, y: -0.1, z: -HW * 0.72,   yaw: 0.5, sx: 1.02, sy: 1.12, sz: 1.02, light: 0.96 },
      { x:  xEdge + 1.8, y: -0.1, z:  HW * 0.62,   yaw: 1.5, sx: 1.00, sy: 1.08, sz: 1.00, light: 0.95 },
    ];
    const oliSpots = [
      { x: -HL * 0.72,   y: -0.2, z: -zEdge - 1.8, yaw: 0.9, sx: 0.90, sy: 0.88, sz: 0.90, light: 0.94 },
      { x: -HL * 0.06,   y: -0.3, z: -zEdge - 1.9, yaw: 2.5, sx: 0.86, sy: 0.84, sz: 0.86, light: 0.96 },
      { x:  HL * 0.74,   y: -0.2, z: -zEdge - 1.8, yaw: 4.1, sx: 0.92, sy: 0.88, sz: 0.92, light: 0.95 },
    ];
    const oliWest = [
      { x: -xEdge - 1.8, y: -0.1, z: -HW * 0.72,   yaw: 1.4, sx: 1.00, sy: 1.00, sz: 1.00, light: 0.94 },
      { x: -xEdge - 1.8, y: -0.1, z:  HW * 0.62,   yaw: 3.1, sx: 0.96, sy: 0.96, sz: 0.96, light: 0.94 },
    ];
    addSplit(northWest, northEast, cypPrims, low ? cypSpots.slice(0, 3) : cypSpots);
    eastMerger.add(cypPrims, cypEast);
    addSplit(northWest, northEast, oliPrims, low ? oliSpots.slice(0, 2) : oliSpots);
    if (!low) farWest.add(oliPrims, oliWest);

    const monkPrims = extractKitPiece(gltf.scene, 'MonkSpectator');
    const monkSpots = [];
    const nMonks = low ? 6 : 14;
    for (let i = 0; i < nMonks; i++) {
      const side = i < nMonks / 2 ? -1 : 1;
      const localT = (i % (nMonks / 2) + 0.5) / (nMonks / 2);
      const mx = side * (HL * 0.24 + localT * HL * 0.62) + (rnd() - 0.5) * 0.5;
      monkSpots.push({
        x: mx,
        y: 0.0,
        z: -zEdge - 0.75,
        yaw: (rnd() - 0.5) * 0.35,
        sx: 0.95 + rnd() * 0.12,
        sy: 0.94 + rnd() * 0.14,
        sz: 0.95 + rnd() * 0.12,
        light: 0.88 + rnd() * 0.18,
      });
    }
    if (!low && !handheld) monkSpots.push(...backRowMonks(rnd, HL, -zEdge - 1.45, [...cypSpots, ...oliSpots].map((t) => t.x)));
    addSplit(northWest, northEast, monkPrims, monkSpots);

    northWest.emit(group, mats, 'Meteora north-west cliffside');
    northEast.emit(group, mats, 'Meteora north-east cliffside');
    eastMerger.emit(group, mats, 'Meteora east pinnacle');
    farWest.emit(group, mats, 'Meteora distant spires west');
    farEast.emit(group, mats, 'Meteora distant spires east');

    if (!low) {
      const shadowStamps = [...cypSpots, ...oliSpots].map((e) => [e.x - sunSide * 0.9, e.z - 0.7, 2.8 * e.sx, 3.8 * e.sx, sunSide * 0.45]);
      addBakedContactShadows(group, shadowStamps);
    }
  });

  scene.add(group);
  return {
    group,
    ready,
    landmark: new THREE.Vector3(HL + 19.6, 11.5, -3.2),
    update() {},
  };
}

// =========================================================================
// VENUE 3: WINTER RUSSIAN MONASTERY
// =========================================================================
function winterSnowfieldTexture(low) {
  const s = low ? 256 : 512;
  const ctx = makeCanvas(s, s), rnd = randomSource(912);
  ctx.fillStyle = '#dae6f2';
  ctx.fillRect(0, 0, s, s);
  for (let i = 0; i < 90; i++) {
    ctx.save();
    const x = rnd() * s, y = rnd() * s, rx = 12 + rnd() * 45, ry = 8 + rnd() * 30;
    ctx.translate(x, y);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, i % 2 ? 'rgba(248,252,255,.52)' : 'rgba(164,186,208,.24)');
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(142,154,166,.46)';
  ctx.lineWidth = s * 0.020;
  ctx.beginPath();
  ctx.moveTo(s * 0.68, s * 0.48);
  ctx.bezierCurveTo(s * 0.78, s * 0.44, s * 0.85, s * 0.56, s, s * 0.52);
  ctx.stroke();
  const edge = ctx.createRadialGradient(s * 0.5, s * 0.5, s * 0.24, s * 0.5, s * 0.5, s * 0.52);
  edge.addColorStop(0.0, 'rgba(207,220,232,0)');
  edge.addColorStop(0.75, 'rgba(207,220,232,0.35)');
  edge.addColorStop(1.0, 'rgba(207,220,232,1.0)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, s, s);
  return makeTex(ctx, 1);
}

// Single-draw GPU falling snow particles (default mode only; NO discard for fast TBDR/SwiftShader fillrate!).
function buildFallingSnow(pitch, handheld) {
  const count = handheld ? 110 : 180;
  const rnd = randomSource(4242);
  const spanX = pitch.length + 22;
  const spanZ = pitch.width + 20;
  const spanY = 17.0;
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  const size = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (rnd() - 0.5) * spanX;
    pos[i * 3 + 1] = rnd() * spanY;
    pos[i * 3 + 2] = (rnd() - 0.5) * spanZ;
    phase[i] = rnd() * Math.PI * 2;
    speed[i] = 1.65 + rnd() * 1.40;
    size[i] = 2.6 + rnd() * 2.8;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const uniforms = {
    uTime: { value: 0 },
    uSpanY: { value: spanY },
    uPixelRatio: { value: Math.min(typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1, 1.5) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float aPhase;
      attribute float aSpeed;
      attribute float aSize;
      uniform float uTime;
      uniform float uSpanY;
      uniform float uPixelRatio;
      varying float vAlpha;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * aSpeed, uSpanY);
        p.x += sin(uTime * 0.85 + aPhase) * 0.90;
        p.z += cos(uTime * 0.65 + aPhase * 1.3) * 0.65;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp(aSize * uPixelRatio * (22.0 / max(6.0, -mv.z)), 1.5, 5.5);
        vAlpha = smoothstep(0.0, 1.8, p.y) * smoothstep(uSpanY, uSpanY - 2.0, p.y) * 0.68;
      }
    `,
    fragmentShader: `
      varying float vAlpha;
      void main() {
        vec2 c = gl_PointCoord - vec2(0.5);
        float soft = smoothstep(0.25, 0.02, dot(c, c));
        gl_FragColor = vec4(0.95, 0.97, 1.0, soft * vAlpha);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = 'Falling snow particles';
  return { pts, uniforms };
}

export function addWinterMonastery(scene, renderer, teams, pitch, low = false, handheld = false) {
  addPitch(scene, renderer, teams, pitch, low, handheld, { frost: true, look: LOOKS.winter });
  const group = new THREE.Group();
  group.name = 'Winter Russian monastery';
  const HL = pitch.length / 2, HW = pitch.width / 2;
  const sunSide = teams[0].kit === 'away' ? 1 : -1;

  const sunPos = LOOKS.winter.sunPos;
  addSkyAndRidges(group, scene, SKIES.winter, {
    low, name: 'Winter sky', sunDir: new THREE.Vector3(sunSide * sunPos[0], sunPos[1], sunPos[2]),
  });

  const turf = turfSize(pitch);
  const snowApron = groundBorder(
    new THREE.MeshBasicMaterial(low ? { color: 0xd6e3ef } : { map: winterSnowfieldTexture(low) }),
    turf.length / 2, turf.width / 2, HL + 82, HW + 70, -0.025, false,
  );
  snowApron.name = 'Snowy monastery grounds';
  group.add(snowApron);

  const xEdge = HL + 4.4, zEdge = HW + 2.8;
  addTeamBanners(group, pitch, xEdge, zEdge);

  // Drop falling snow completely in low mode so ?quality=low is strictly faster than default!
  const snow = low ? null : buildFallingSnow(pitch, handheld);
  if (snow) group.add(snow.pts);

  const ready = loadVenueGLB('assets/models/venue_winter.glb').then((gltf) => {
    if (!gltf) return;
    const mats = createVenueMaterials(low, !low && !handheld);
    const rnd = randomSource(7071);

    // Split perimeter Kremlin wall into 4 frustum-cullable sides (keeps 'Snowy monastery walls' name for venue checks)
    const wallPrims = extractKitPiece(gltf.scene, 'SnowWallBay');
    const nX = Math.max(12, Math.round((2 * xEdge) / 4.0));
    const nZ = Math.max(8, Math.round((2 * zEdge) / 4.0));
    const sxX = (2 * xEdge) / (nX * 4.0);
    const sxZ = (2 * zEdge) / (nZ * 4.0);
    for (const side of [-1, 1]) {
      const longSpots = [], shortSpots = [];
      for (let i = 0; i < nX; i++) {
        longSpots.push({
          x: -xEdge + (i + 0.5) * (2 * xEdge / nX),
          z: side * zEdge,
          yaw: side > 0 ? Math.PI : 0,
          sx: sxX,
          sy: side > 0 ? 0.44 : 1.0,
          light: 0.94 + rnd() * 0.08,
        });
      }
      for (let i = 0; i < nZ; i++) {
        shortSpots.push({
          x: side * xEdge,
          z: -zEdge + (i + 0.5) * (2 * zEdge / nZ),
          yaw: side > 0 ? -Math.PI / 2 : Math.PI / 2,
          sx: sxZ,
          sy: 1.0,
          light: 0.94 + rnd() * 0.08,
        });
      }
      addInstancedKit(group, wallPrims, longSpots, mats, side < 0 ? 'Snowy monastery walls' : 'Snowy monastery walls south', DETAIL.plaster);
      addInstancedKit(group, wallPrims, shortSpots, mats, side < 0 ? 'Snowy monastery walls west' : 'Snowy monastery walls east', DETAIL.plaster);
    }

    // Spatially split merged static batches (west / east / cathedral) so off-screen sides frustum-cull cleanly!
    const arenaWest = new StaticKitMerger();
    const arenaEast = new StaticKitMerger();
    const eastMerger = new StaticKitMerger();
    const addSplit = (west, east, prims, list, kind) => {
      const lw = [], le = [];
      for (const p of list) (p.x < 0 ? lw : le).push(p);
      west.add(prims, lw, kind);
      east.add(prims, le, kind);
    };

    const towerPrims = extractKitPiece(gltf.scene, 'CornerTower');
    addSplit(arenaWest, arenaEast, towerPrims, [
      { x: -xEdge,     z: -zEdge,       yaw:  0.3, sx: 1.0,  sy: 0.96, sz: 1.0,  light: 0.99 },
      { x:  xEdge,     z: -zEdge,       yaw: -0.3, sx: 1.0,  sy: 0.96, sz: 1.0,  light: 0.99 },
      { x: -HL * 0.58, z: -zEdge - 1.2, yaw:  0.2, sx: 0.72, sy: 0.64, sz: 0.72, light: 0.98 },
      { x:  HL * 0.58, z: -zEdge - 1.2, yaw: -0.2, sx: 0.72, sy: 0.64, sz: 0.72, light: 0.98 },
      { x: -xEdge,     z:  zEdge,       yaw:  0.0, sx: 0.55, sy: 0.24, sz: 0.55, light: 0.95 },
      { x:  xEdge,     z:  zEdge,       yaw:  0.0, sx: 0.55, sy: 0.24, sz: 0.55, light: 0.95 },
    ], DETAIL.plaster);

    // Broadcast-framed north monastery gate chapel (snow roofs, bell spire & 3 golden onion domes!)
    const northChapelPrims = extractKitPiece(gltf.scene, 'WinterNorthChapel');
    arenaEast.add(northChapelPrims, [
      { x: HL * 0.08, y: 0.0, z: -zEdge - 3.6, yaw: 0.0, sx: 0.94, sy: 0.84, sz: 0.92, light: 1.0 },
    ], DETAIL.plaster);

    // East-goal hero 5-dome cathedral + tall bell tower (isolated in eastMerger -> culled in midfield broadcast!)
    const cathPrims = extractKitPiece(gltf.scene, 'RussianCathedral');
    eastMerger.add(cathPrims, [
      { x: HL + 18.2, y: 0.0, z: -2.4, yaw: 0.0, sx: 0.94, sy: 0.92, sz: 0.94, light: 1.0 },
    ], DETAIL.plaster);
    const bellPrims = extractKitPiece(gltf.scene, 'RussianBellTower');
    eastMerger.add(bellPrims, [
      { x: HL + 16.0, y: 0.0, z: -14.8, yaw: 0.0, sx: 0.92, sy: 0.88, sz: 0.92, light: 1.0 },
    ], DETAIL.plaster);

    // Irregular wind-sculpted & shovelled snowdrifts (2 distinct asymmetric shapes, randomized clusters!)
    const driftA = extractKitPiece(gltf.scene, 'SnowDrift_A');
    const driftB = extractKitPiece(gltf.scene, 'SnowDrift_B');
    const spotsDA = [], spotsDB = [];
    for (const sideZ of (low ? [-1] : [-1, 1])) {
      let curX = -HL - 1.5;
      let idx = 0;
      while (curX < HL + 1.2) {
        const step = (low ? 4.8 : 3.2) + rnd() * 4.4;
        const cx = curX + step * 0.45;
        if (rnd() > 0.14) {
          const isA = (idx % 2 === 0) !== (rnd() < 0.35);
          const scX = 0.65 + rnd() * 0.95;
          const scY = (sideZ > 0 ? 0.55 : 0.72) + rnd() * 0.65;
          const scZ = 0.70 + rnd() * 0.68;
          const zOff = sideZ * (HW + 1.55 + rnd() * 0.75);
          const entry = {
            x: cx,
            y: -0.02,
            z: zOff,
            yaw: (rnd() < 0.5 ? 0 : Math.PI) + (rnd() - 0.5) * 0.36,
            sx: scX,
            sy: scY,
            sz: scZ,
            light: 0.95 + rnd() * 0.07,
          };
          (isA ? spotsDA : spotsDB).push(entry);
        }
        curX += step;
        idx++;
      }
    }
    if (!low) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          spotsDB.push({
            x: sx * (HL + 2.3 + rnd() * 0.8),
            y: -0.02,
            z: sz * (HW * 0.56 + rnd() * 3.0),
            yaw: Math.PI / 2 + (rnd() - 0.5) * 0.45,
            sx: 0.95 + rnd() * 0.65,
            sy: 0.80 + rnd() * 0.55,
            sz: 0.85 + rnd() * 0.50,
            light: 0.97,
          });
          spotsDA.push({
            x: sx * (HL + 2.4),
            y: -0.02,
            z: sz * (HW + 0.6),
            yaw: sx * sz * 0.7 + (rnd() - 0.5) * 0.3,
            sx: 0.90 + rnd() * 0.45,
            sy: 0.85 + rnd() * 0.45,
            sz: 0.95 + rnd() * 0.40,
            light: 0.98,
          });
        }
      }
    }
    addSplit(arenaWest, arenaEast, driftA, spotsDA);
    addSplit(arenaWest, arenaEast, driftB, spotsDB);

    // Snow-laden Russian firs (foreground broadcast-height firs + background taiga forest in default mode!)
    const spA = extractKitPiece(gltf.scene, 'SnowSpruce_A');
    const spB = extractKitPiece(gltf.scene, 'SnowSpruce_B');
    const spotsA = [], spotsB = [], eastSpA = [], eastSpB = [], shadowStamps = [];
    const fgXs = [-xEdge + 3.5, -HL * 0.78, -HL * 0.40, HL * 0.42, HL * 0.76, xEdge - 3.5];
    for (const fx of fgXs) {
      const sc = 0.78 + rnd() * 0.24;
      spotsB.push({ x: fx, z: -zEdge - 2.3 - rnd() * 1.2, yaw: rnd() * 6.28, sx: sc, sy: sc, sz: sc, light: 0.95 + rnd() * 0.08 });
      shadowStamps.push([fx - sunSide * 0.9 * sc, -zEdge - 2.6, 3.0 * sc, 3.8 * sc, sunSide * 0.45]);
    }
    if (!low) {
      const nBack = 16;
      for (let i = 0; i < nBack; i++) {
        const t = (i + 0.5) / nBack;
        const x = -xEdge - 8 + t * (2 * xEdge + 18);
        const z = -zEdge - 7.8 - (i % 3) * 4.5 - rnd() * 2.5;
        const sc = 0.85 + rnd() * 0.42;
        const entry = { x, z, yaw: rnd() * 6.28, sx: sc, sy: sc * (0.92 + rnd() * 0.25), sz: sc, light: 0.90 + rnd() * 0.12 };
        (i % 2 === 0 ? spotsA : spotsB).push(entry);
        shadowStamps.push([x - sunSide * 1.1 * sc, z - 1.0 * sc, 3.8 * sc, 4.8 * sc, sunSide * 0.45]);
      }
    }
    for (const side of (low ? [1] : [-1, 1])) {
      const nEnd = low ? 3 : 6;
      for (let i = 0; i < nEnd; i++) {
        const z = -HW + 2 + (i / Math.max(1, nEnd - 1)) * (2 * HW - 2);
        if (side > 0 && z > -18 && z < 6) continue;
        const x = side * (xEdge + 5.5 + (i % 2) * 5.2);
        const sc = 0.88 + rnd() * 0.35;
        const entry = { x, z, yaw: rnd() * 6.28, sx: sc, sy: sc, sz: sc, light: 0.92 + rnd() * 0.10 };
        if (side > 0) (i % 2 === 0 ? eastSpA : eastSpB).push(entry);
        else (i % 2 === 0 ? spotsA : spotsB).push(entry);
        shadowStamps.push([x - sunSide * 1.1 * sc, z - 1.0 * sc, 3.8 * sc, 4.8 * sc, sunSide * 0.45]);
      }
    }
    addSplit(arenaWest, arenaEast, spA, spotsA);
    addSplit(arenaWest, arenaEast, spB, spotsB);
    eastMerger.add(spA, eastSpA);
    eastMerger.add(spB, eastSpB);

    const monkPrims = extractKitPiece(gltf.scene, 'WinterMonk');
    const monkSpots = [];
    const nMonks = low ? 6 : 14;
    for (let i = 0; i < nMonks; i++) {
      const side = i < nMonks / 2 ? -1 : 1;
      const localT = (i % (nMonks / 2) + 0.5) / (nMonks / 2);
      const mx = side * (HL * 0.28 + localT * HL * 0.58) + (rnd() - 0.5) * 0.5;
      monkSpots.push({
        x: mx,
        y: 0.0,
        z: -zEdge - 0.95,
        yaw: (rnd() - 0.5) * 0.35,
        sx: 0.95 + rnd() * 0.12,
        sy: 0.94 + rnd() * 0.14,
        sz: 0.95 + rnd() * 0.12,
        light: 0.88 + rnd() * 0.18,
      });
    }
    if (!low && !handheld) monkSpots.push(...backRowMonks(rnd, HL, -zEdge - 1.6, fgXs));
    addSplit(arenaWest, arenaEast, monkPrims, monkSpots);

    arenaWest.emit(group, mats, 'Winter monastery surround west');
    arenaEast.emit(group, mats, 'Winter monastery surround east');
    eastMerger.emit(group, mats, 'Winter east cathedral');
    if (!low) addBakedContactShadows(group, shadowStamps, 'rgba(65,82,108,.30)');
  });

  scene.add(group);
  return {
    group,
    ready,
    landmark: new THREE.Vector3(HL + 18.0, 10.5, -4.5),
    update(dt) {
      if (snow) snow.uniforms.uTime.value += dt;
    },
  };
}
