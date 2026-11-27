import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { bannerTexture, randomSource } from './courtyard-textures.js';
import { DETAIL, detailMaterial } from './venue-look.js';

// Collapse the coloured pieces of each static model before it reaches the renderer.
export class GeometryBatch {
  constructor() {
    this.parts = [];
  }
  add(part, tint, x = 0, y = 0, z = 0, yaw = 0) {
    part.deleteAttribute('uv');
    if (!part.index) {
      const count = part.getAttribute('position').count;
      part.setIndex(Array.from({ length: count }, (_, index) => index));
    }
    if (!part.hasAttribute('color')) {
      const color = new THREE.Color(tint);
      const colors = new Float32Array(part.getAttribute('position').count * 3);
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = color.r;
        colors[i + 1] = color.g;
        colors[i + 2] = color.b;
      }
      part.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    part.rotateY(yaw);
    part.translate(x, y, z);
    this.parts.push(part);
  }
  box(x, y, z, w, h, d, tint, yaw = 0) {
    this.add(new THREE.BoxGeometry(w, h, d), tint, x, y, z, yaw);
  }
  cylinder(x, y, z, top, bottom, h, tint, sides = 12) {
    this.add(new THREE.CylinderGeometry(top, bottom, h, sides), tint, x, y, z);
  }
  finish() {
    const geometry = mergeGeometries(this.parts);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    geometry.computeBoundingSphere();
    return geometry;
  }
}

function instanced(geometry, material, places, name) {
  const mesh = new THREE.InstancedMesh(geometry, material, places.length);
  const dummy = new THREE.Object3D(), tone = new THREE.Color();
  places.forEach(({ x, y = 0, z, yaw = 0, sx = 1, sy = 1, sz = 1, light = 1 }, index) => {
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(index, dummy.matrix);
    tone.setRGB(light, light, light);
    mesh.setColorAt(index, tone);
  });
  mesh.computeBoundingSphere();
  mesh.name = name;
  return mesh;
}

function extrude(shape, depth, segments = 12) {
  return new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segments }).translate(
    0,
    0,
    -depth / 2,
  );
}

// A wall bay with an opening all the way through it, used both in the enclosure and belfry.
function openArch(width, height, radius, spring, depth, segments = 7) {
  const shape = new THREE.Shape();
  shape.moveTo(-width / 2, 0);
  shape.lineTo(-radius, 0);
  shape.lineTo(-radius, spring);
  shape.absarc(0, spring, radius, Math.PI, 0, true);
  shape.lineTo(radius, 0);
  shape.lineTo(width / 2, 0);
  shape.lineTo(width / 2, height);
  shape.lineTo(-width / 2, height);
  shape.closePath();
  return extrude(shape, depth, segments);
}

function archStone(inner, outer, a, b) {
  const points = [];
  for (const angle of [a, (a + b) / 2, b]) {
    for (const radius of [inner, outer]) points.push(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
  }
  const face = new THREE.BufferGeometry();
  face.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  face.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4]);
  face.computeVertexNormals();
  return face;
}

function wallBay(low) {
  const bay = new GeometryBatch();
  const stones = [0xcbb894, 0xd7c5a5, 0xc4af8d, 0xddcbaa, 0xcab799];
  bay.box(0, .19, 0, 2.6, .38, .47, 0xac9a7f);
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      for (const front of [-1, 1]) {
        bay.add(
          new THREE.PlaneGeometry(.635, .155),
          stones[(col + row * 3) % 5],
          -.975 + col * .65,
          .10 + row * .17,
          front * .236,
          front < 0 ? Math.PI : 0,
        );
      }
    }
  }
  bay.add(openArch(2.60, 1.23, .86, .27, .38), 0xc8b391, 0, .37, 0);
  if (!low) {
    for (const front of [-1, 1]) {
      for (let i = 0; i < 9; i++) {
        const a = i * Math.PI / 9, b = (i + 1) * Math.PI / 9;
        bay.add(
          archStone(.86, i === 4 ? 1.07 : 1.015, a + .009, b - .009),
          stones[(i + 2) % 5],
          0,
          .64,
          front * .192,
          front < 0 ? Math.PI : 0,
        );
      }
    }
  }
  for (const x of [-1.15, 1.15]) {
    bay.box(x, .69, 0, .28, .12, .46, 0xdcc8a5);
    bay.box(x, .445, 0, .34, .12, .50, 0xbca789);
  }
  bay.box(0, 1.61, 0, 2.60, .12, .49, 0xa69278);
  bay.box(0, 1.70, 0, 2.60, .115, .56, 0xe1cda8);
  return bay.finish();
}

function enclosure(group, material, pitch, low) {
  const xEdge = pitch.length / 2 + 3.55, zEdge = pitch.width / 2 + 1.55;
  const geometry = wallBay(low), random = randomSource(47);
  for (const side of [-1, 1]) {
    const long = [], short = [];
    const longCount = Math.round(2 * xEdge / 2.6), shortCount = Math.round(2 * zEdge / 2.6);
    for (let i = 0; i < longCount; i++) {
      long.push({
        x: ((i + .5) / longCount * 2 - 1) * xEdge,
        z: side * zEdge,
        sx: 2 * xEdge / longCount / 2.6,
        sy: side > 0 ? .53 : 1,
        light: .84 + random() * .16,
      });
    }
    for (let i = 0; i < shortCount; i++) {
      short.push({
        x: side * xEdge,
        z: ((i + .5) / shortCount * 2 - 1) * zEdge,
        yaw: Math.PI / 2,
        sx: 2 * zEdge / shortCount / 2.6,
        sy: .85,
        light: .84 + random() * .16,
      });
    }
    // Cull each length separately when the broadcast camera follows one goal.
    group.add(
      instanced(geometry, material, long, 'Touchline arches'),
      instanced(geometry, material, short, 'End-line arches'),
    );
  }
}

function roundHead(width, height) {
  const radius = width / 2, spring = height - radius, shape = new THREE.Shape();
  shape.moveTo(-radius, 0);
  shape.lineTo(radius, 0);
  shape.lineTo(radius, spring);
  shape.absarc(0, spring, radius, 0, Math.PI, false);
  shape.closePath();
  return new THREE.ShapeGeometry(shape, 10);
}

function windowArch(batch, x, y, z, width, height, yaw, door = false) {
  const dx = Math.sin(yaw), dz = Math.cos(yaw);
  batch.add(roundHead(width + .21, height + .16), 0xd9c8a9, x, y - .035, z, yaw);
  batch.add(roundHead(width, height), door ? 0x574233 : 0x485356, x + dx * .018, y, z + dz * .018, yaw);
  batch.box(x + dx * .047, y + height * .41, z + dz * .047, .055, height * .80, .045, door ? 0xac895e : 0xb1a387, yaw);
}

function roof(batch, x, y, z, length, width, rise, color) {
  // Triangular gable profile along the nave, with a small eave at both ends.
  const profile = new THREE.Shape();
  profile.moveTo(-width / 2, 0);
  profile.lineTo(width / 2, 0);
  profile.lineTo(0, rise);
  profile.closePath();
  batch.add(extrude(profile, length).rotateY(Math.PI / 2), color, x, y, z);
}

function cross(batch, x, y, z, size) {
  const gold = 0xe5b95b;
  batch.box(x, y + size * .52, z, .10 * size, 1.04 * size, .10 * size, gold);
  for (const yaw of [0, Math.PI / 2]) {
    batch.box(x, y + size * .67, z, .65 * size, .095 * size, .09 * size, gold, yaw);
    batch.box(x, y + size * .91, z, .32 * size, .065 * size, .065 * size, gold, yaw);
  }
}

function dome(batch, x, base, z, r, h, gold = false) {
  const profile = [[.78, 0], [.96, .10], [1.05, .25], [1.02, .40], [.88, .54], [.64, .67], [.35, .79], [.16, .90], [
    .08,
    1,
  ]];
  const points = profile.map(([rad, y]) => new THREE.Vector2(rad * r, y * h));
  batch.add(new THREE.LatheGeometry(points, 24), gold ? 0xcf9d4f : 0x396c8b, x, base, z);
  // Thin raised metal seams catch the evening light along the dome's profile.
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6;
    const seam = points.map((p) => new THREE.Vector3(Math.sin(a) * (p.x + .008), p.y, Math.cos(a) * (p.x + .008)));
    const curve = new THREE.CatmullRomCurve3(seam);
    batch.add(new THREE.TubeGeometry(curve, 10, gold ? .014 : .019, 3, false), gold ? 0xe5b665 : 0x6d91a1, x, base, z);
  }
  batch.cylinder(x, base + .05, z, r * .90, r * .90, .12, 0xb69b66, 24);
  batch.cylinder(x, base + h + .03, z, r * .10, r * .12, .12, 0xe4b964, 12);
  batch.add(new THREE.SphereGeometry(r * .12, 10, 6), 0xe2b65b, x, base + h + .14, z);
  cross(batch, x, base + h + .22, z, Math.max(.7, r * .62));
}

function drum(batch, x, y, z, r, h) {
  batch.cylinder(x, y + h / 2, z, r, r, h, 0xeee6cd, 16);
  batch.cylinder(x, y + .10, z, r * 1.09, r * 1.12, .20, 0xcbb793, 16);
  batch.cylinder(x, y + h - .08, z, r * 1.09, r * 1.05, .19, 0xe2cda6, 16);
  for (let i = 0; i < 8; i++) {
    const yaw = i * Math.PI / 4, edge = r * 1.004;
    windowArch(batch, x + Math.sin(yaw) * edge, y + .21, z + Math.cos(yaw) * edge, r * .27, h * .68, yaw);
  }
}

// Local west is the church door facing the pitch; its bell tower is visible through real openings.
function church(material, pitch) {
  const b = new GeometryBatch(), plaster = 0xf2e9d3, limestone = 0xcebb99, slate = 0x667d81;
  b.box(0, .24, 0, 10.1, .48, 6.5, limestone);
  b.box(0, 2.38, 0, 9.5, 3.94, 5.9, plaster);
  b.box(0, 4.40, 0, 9.85, .30, 6.25, 0xe5d1ad);
  roof(b, 0, 4.52, 0, 10.05, 6.48, 1.64, slate);
  b.box(.65, 2.68, 0, 4.5, 4.82, 7.56, plaster);
  b.box(.65, 5.09, 0, 4.70, .22, 7.86, limestone);
  const end = new THREE.Shape();
  end.moveTo(-2.46, 0);
  end.lineTo(2.46, 0);
  end.lineTo(0, 1.38);
  end.closePath();
  b.add(extrude(end, 8.04), slate, .65, 5.20, 0);
  for (const side of [-1, 1]) {
    for (const x of [-3.45, -2.0, 3.7]) windowArch(b, x, 1.32, side * 2.968, .62, 1.83, side > 0 ? 0 : Math.PI);
    for (const x of [-.28, 1.57]) windowArch(b, x, 2.07, side * 3.796, .65, 1.96, side > 0 ? 0 : Math.PI);
    for (const x of [-4.62, 4.62]) b.box(x, 2.33, side * 2.98, .34, 3.80, .19, 0xe4d6bd);
  }
  // Rounded sanctuary, stepped entrance and a stone architrave at the west door.
  b.cylinder(4.8, 1.82, 0, 2.25, 2.25, 3.16, plaster, 16);
  b.cylinder(4.8, 3.54, 0, 1.10, 2.46, .42, slate, 16);
  for (let i = 0; i < 3; i++) b.box(-5.55 + i * .27, .075 + i * .115, 0, 1.55, .15 + i * .14, 3.4 - i * .17, limestone);
  windowArch(b, -4.77, .38, 0, 1.40, 2.81, -Math.PI / 2, true);
  for (const z of [-2.0, 2.0]) windowArch(b, -4.77, 1.36, z, .51, 1.40, -Math.PI / 2);
  drum(b, .64, 5.72, 0, 2.06, 1.75);
  dome(b, .64, 7.47, 0, 2.15, 2.66);
  // Free-standing campanile: stone foot, arched belfry, bronze bell and gilt cupola.
  const tx = -1.60, tz = -6.68;
  b.box(tx, .25, tz, 3.20, .50, 3.20, limestone);
  b.box(tx, 3.36, tz, 2.62, 5.82, 2.62, plaster);
  for (const y of [1.1, 4.05, 6.20]) b.box(tx, y, tz, 2.91, .18, 2.91, limestone);
  windowArch(b, tx, 3.35, tz + 1.32, .42, 1.42, 0);
  windowArch(b, tx - 1.32, 3.35, tz, .42, 1.42, -Math.PI / 2);
  for (const dir of [-1, 1]) {
    b.add(openArch(2.75, 1.88, .84, .76, .32), plaster, tx, 6.28, tz + dir * 1.20);
    b.add(openArch(2.75, 1.88, .84, .76, .32), plaster, tx + dir * 1.20, 6.28, tz, Math.PI / 2);
  }
  b.box(tx, 8.20, tz, 3.04, .23, 3.04, limestone);
  b.cylinder(tx, 7.39, tz, .23, .53, .62, 0x80653e, 12);
  b.cylinder(tx, 7.04, tz, .55, .64, .13, 0x9c7745, 12);
  b.cylinder(tx, 7.83, tz, .055, .055, .34, 0x504e43, 8);
  b.cylinder(tx, 8.46, tz, 1.10, 1.43, .39, 0x7f8276, 12);
  dome(b, tx, 8.65, tz, 1.10, 1.47, true);
  const mesh = new THREE.Mesh(b.finish(), material);
  mesh.position.set(pitch.length / 2 + 10.7, 0, -pitch.width / 2 + 7.9);
  mesh.name = 'Church and bell tower';
  return mesh;
}

function cypressGeometry() {
  const b = new GeometryBatch();
  b.cylinder(0, .69, 0, .17, .24, 1.38, 0x75614a, 7);
  const rings = [
    [.78, .22],
    [1.04, .65],
    [1.53, .85],
    [2.15, .93],
    [2.82, .80],
    [3.43, .72],
    [4.08, .61],
    [4.62, .49],
    [5.19, .36],
    [5.77, .21],
    [6.37, .03],
  ];
  const points = [], colors = [], random = randomSource(752);
  const sides = 11;
  const rows = rings.map(([h, r], j) =>
    Array.from({ length: sides }, (_, i) => {
      const a = i * Math.PI * 2 / sides + (j % 2) * .19, rad = r * (.85 + .28 * random());
      return [Math.sin(a) * rad + .08 * h / 6, h + (random() - .5) * .14, Math.cos(a) * rad];
    })
  );
  function face(a, b, c, tint) {
    points.push(...a, ...b, ...c);
    const col = new THREE.Color(tint);
    for (let k = 0; k < 3; k++) colors.push(col.r, col.g, col.b);
  }
  const shades = [0x2d5440, 0x365d43, 0x42674b, 0x4c7150, 0x395d42];
  for (let j = 0; j < rows.length - 1; j++) {
    for (let i = 0; i < sides; i++) {
      const k = (i + 1) % sides, shade = shades[Math.floor(random() * shades.length)];
      face(rows[j][i], rows[j][k], rows[j + 1][i], shade);
      face(rows[j][k], rows[j + 1][k], rows[j + 1][i], shade);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.computeVertexNormals();
  b.add(g, 0xffffff);
  return b.finish();
}

function orchard(group, material, pitch, low) {
  const olive = new GeometryBatch(), shrubs = new GeometryBatch();
  // A forked trunk and wide silver-green crown distinguish olives from cypresses.
  olive.add(new THREE.CylinderGeometry(.20, .36, 1.55, 7).rotateZ(-.15), 0x817559, 0, .72, 0);
  for (const side of [-1, 1]) {
    olive.add(new THREE.CylinderGeometry(.10, .19, 1.14, 6).rotateZ(-side * .64), 0x82765d, side * .37, 1.75, 0);
  }
  for (
    const [x, y, z, r, color] of [[-1.04, 2.45, .02, 1.28, 0x7c8b62], [.87, 2.66, -.13, 1.32, 0x84916e], [
      -.19,
      2.58,
      .58,
      1.10,
      0x9aa481,
    ], [.16, 3.10, -.47, 1.18, 0x91a07b]]
  ) {
    olive.add(new THREE.IcosahedronGeometry(r, 1).scale(1.12, .72, .93), color, x, y, z);
  }
  for (
    const [x, y, z, r, tint] of [[-.49, .40, .06, .60, 0x6e8058], [.30, .52, -.18, .74, 0x7e8c61], [
      .72,
      .32,
      .26,
      .47,
      0x97a074,
    ]]
  ) {
    shrubs.add(new THREE.IcosahedronGeometry(r, 0).scale(1.12, .83, .91), tint, x, y, z);
  }
  const random = randomSource(591), trees = [], bushes = [];
  const scaleX = pitch.length / 56, scaleZ = pitch.width / 34;
  const sites = [
    [-43, -26],
    [-29, -34],
    [-14, -32],
    [6, -34],
    [22, -31],
    [36, -26],
    [46, -21],
    [52, -13],
    [48, -2],
    [43, 6],
    [53, 12],
    [-40, 3],
  ];
  for (const [index, [x, z]] of sites.entries()) {
    if (low && index % 3 === 1) continue;
    const size = .83 + random() * .43;
    trees.push({
      x: x * scaleX,
      z: z * scaleZ,
      sx: size,
      sy: size * (.86 + .25 * random()),
      sz: size,
      yaw: random() * 6,
      light: .91 + .09 * random(),
    });
  }
  for (
    const [cx, cz] of [
      [-29, -26],
      [-11, -29],
      [7, -28],
      [26, -26],
      [31, -28],
      [44, -19],
      [46, -13],
      [45, -2],
      [39, 5],
      [45, 14],
      [-37, 7],
    ]
  ) {
    for (let i = 0; i < (low ? 2 : 4); i++) {
      const size = .67 + random() * .55;
      bushes.push({
        x: cx * scaleX + (random() - .5) * 6,
        z: cz * scaleZ + (random() - .5) * 3,
        sx: size,
        sy: size,
        sz: size,
        yaw: random() * 6,
        light: .84 + .16 * random(),
      });
    }
  }
  group.add(
    instanced(olive.finish(), material, trees, 'Olive trees'),
    instanced(shrubs.finish(), material, bushes, 'Garden shrubs'),
  );
  return trees;
}

function terracePlace(section, row, along) {
  const cos = Math.cos(section.yaw), sin = Math.sin(section.yaw), back = row * 1.03;
  return { x: section.x + along * cos - back * sin, z: section.z - along * sin - back * cos, y: .83 + row * .46 };
}

function terraces(batch, terraceSections) {
  for (const section of terraceSections) {
    for (let row = 0; row < 3; row++) {
      const { x, y, z } = terracePlace(section, row, 0);
      batch.box(x, y / 2, z, section.length, y, 1.07, 0xab9b86, section.yaw);
      batch.box(x, y - .06, z, section.length + .07, .12, 1.12, 0xdfceb3, section.yaw);
    }
  }
}

function spectator(kind) {
  const b = new GeometryBatch(), monk = kind === 0, nun = kind === 1;
  const cloth = monk ? 0x504943 : nun ? 0x424a53 : 0xad806a, skin = monk ? 0xb88d70 : nun ? 0xd5aa84 : 0xc79a7e;
  // Small silhouettes at the terrace: habits, veils and everyday woven clothes.
  if (monk || nun) b.cylinder(0, .48, 0, .21, .30, .90, cloth, 8);
  else {
    for (const leg of [-.095, .095]) b.cylinder(leg, .29, 0, .088, .075, .56, 0x655f57, 6);
    b.cylinder(0, .73, 0, .18, .235, .46, cloth, 8);
  }
  b.cylinder(0, 1.02, 0, .23, .20, .34, monk ? 0x514a43 : nun ? 0x525961 : 0x829da6, 8);
  b.add(new THREE.SphereGeometry(.145, 7, 4).scale(.89, 1.15, .85), skin, 0, 1.37, 0);
  if (monk) {
    b.cylinder(0, 1.49, -.01, .132, .14, .13, 0x403c37, 9);
    b.add(new THREE.IcosahedronGeometry(.095).scale(1, 1.18, .50), 0x665b4c, 0, 1.292, .08);
  } else if (nun) {
    b.add(new THREE.SphereGeometry(.155, 7, 4).scale(1, 1.05, .85), 0xddd5bd, 0, 1.405, -.028);
    b.add(new THREE.IcosahedronGeometry(.105), skin, 0, 1.36, .075);
    b.cylinder(0, 1.23, -.085, .135, .205, .31, 0x41494d, 9);
  } else b.add(new THREE.SphereGeometry(.14, 7, 3).scale(1, .64, .93), 0x66503c, 0, 1.466, -.02);
  for (const side of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(.071, .060, .44, 7).rotateZ(side * .15), cloth, side * .23, .99, .015);
    b.add(new THREE.OctahedronGeometry(.072), skin, side * .265, .785, .046);
  }
  return b.finish();
}

function flags(group, pitch, low) {
  const positions = [], uv = [], indices = [];
  const anchors = [];
  const farCount = low ? 7 : 11, endCount = low ? 3 : 5;
  for (let i = 0; i < farCount; i++) {
    anchors.push({ x: (pitch.length - 4) * (i / (farCount - 1) - .5), z: -pitch.width / 2 - 1.27, yaw: 0, kit: i % 2 });
  }
  for (const side of [-1, 1]) {
    for (let i = 0; i < endCount; i++) {
      anchors.push({
        x: side * (pitch.length / 2 + 3.25),
        z: (pitch.width - 4) * (i / (endCount - 1) - .5),
        yaw: -side * Math.PI / 2,
        kit: (i + (side > 0 ? 1 : 0)) % 2,
      });
    }
  }
  const poles = new GeometryBatch();
  for (const { x, z, yaw, kit: type } of anchors) {
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    poles.cylinder(x - .65 * cos, 2.2, z + .65 * sin, .038, .053, 2.52, 0x8d7957, 7);
    poles.add(new THREE.CylinderGeometry(.03, .03, 1.44, 7).rotateZ(Math.PI / 2), 0xb29a68, x, 3.44, z, yaw);
    const start = positions.length / 3, cols = 6;
    for (let y = 0; y <= 1; y++) {
      for (let i = 0; i <= cols; i++) {
        const u = i / cols, across = (u - .5) * 1.24, fold = .07 + Math.sin(u * 10 + x + z) * (.02 + y * .075);
        positions.push(
          x + across * cos + fold * sin,
          3.40 - y * (1.42 + .22 * Math.abs(2 * u - 1)),
          z - across * sin + fold * cos,
        );
        uv.push((type + .013 + .974 * u) / 2, .99 - y * .98);
      }
    }
    for (let i = 0; i < cols; i++) {
      const a = start + i, b = a + cols + 1;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const flags = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: bannerTexture(), side: THREE.DoubleSide }));
  flags.name = 'Team banners';
  group.add(flags);
  return poles;
}

export function addBuildings(group, pitch, low, detail = false) {
  const L = pitch.length / 2, W = pitch.width / 2, gap = pitch.goalWidth / 2;
  const terraceSections = [
    { x: -L / 2 - .3, z: -W - 2.9, length: L - .5, yaw: 0 },
    { x: L / 2 + .3, z: -W - 2.9, length: L - .5, yaw: 0 },
    { x: L + 4.55, z: W / 3, length: W + 1, yaw: -Math.PI / 2 },
  ];
  // World-projected detail: masonry on the arcades and stands, weathered plaster on the church,
  // a soft grain on trees and people. Phones and the low tier keep one plain material.
  const plain = new THREE.MeshLambertMaterial({ vertexColors: true });
  const look = !detail
    ? { walls: plain, church: plain, soft: plain }
    : {
        walls: detailMaterial(DETAIL.masonry),
        church: detailMaterial(DETAIL.plaster),
        soft: detailMaterial(DETAIL.soft),
      };
  const material = look.soft;
  enclosure(group, look.walls, pitch, low);
  group.add(church(look.church, pitch));
  const masonry = flags(group, pitch, low);
  terraces(masonry, terraceSections);
  // The low stone kickboard meets the touchlines and leaves both goal mouths open.
  for (const s of [-1, 1]) {
    masonry.box(0, .15, s * (W + .31), L * 2 + .40, .30, .20, 0xc0af91);
    for (const t of [-1, 1]) masonry.box(s * (L + .29), .15, t * (gap + (W - gap) / 2), .20, .30, W - gap, 0xc0af91);
  }
  const terracesAndCurbs = new THREE.Mesh(masonry.finish(), look.walls);
  terracesAndCurbs.name = 'Stands and pitch curbs';
  group.add(terracesAndCurbs);
  const trees = [], random = randomSource(142);
  function tree(x, z, scale) {
    trees.push({
      x,
      z,
      sx: scale,
      sy: scale * (.92 + .17 * random()),
      sz: scale,
      yaw: random() * 6,
      light: .82 + .18 * random(),
    });
  }
  const grove = low
    ? [-34, -26, -21, -13, 1, 4, 19, 28, 33]
    : [-35, -32, -26, -22, -20, -12, -9, -2, 1, 3, 13, 16, 23, 29, 33, 36];
  for (const x of grove) tree(x * L / 28 + (random() - .5) * 1.3, -W - 8.8 - random() * 4, .69 + random() * .54);
  for (const side of [-1, 1]) {
    for (const z of (low ? [-17, 9] : [-17, -12, 3, 9, 15])) {
      if (side === 1 && z < 0) continue;
      tree(side * (L + 6 + random() * 2), z * W / 17, .80 + random() * .36);
    }
  }
  group.add(instanced(cypressGeometry(), material, trees, 'Cypresses'));
  const olives = orchard(group, material, pitch, low);
  const crowd = [[], [], []];
  const rows = low ? 2 : 3;
  for (const section of terraceSections) {
    for (let row = 0; row < rows; row++) {
      const count = Math.ceil(section.length / (low ? 2.15 : 1.55));
      for (let i = 0; i < count; i++) {
        if (random() < (low ? .08 : .12)) continue;
        const along = (i + .5 + (random() - .5) * .37) * section.length / count - section.length / 2;
        const spot = terracePlace(section, row, along), scale = .98 + random() * .20, kind = Math.floor(random() * 3);
        crowd[kind].push({
          ...spot,
          z: spot.z + (random() - .5) * .20,
          yaw: section.yaw + (random() - .5) * .72,
          sx: scale,
          sy: scale * (.94 + random() * .12),
          sz: scale,
          light: .87 + random() * .13,
        });
      }
    }
  }
  crowd.forEach((places, i) => group.add(instanced(spectator(i), material, places, ['Monks', 'Nuns', 'Villagers'][i])));
  return trees.concat(olives);
}
