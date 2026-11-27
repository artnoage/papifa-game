import * as THREE from 'three';

// Fixed seeds keep the field and its markings identical in a replay or rematch.
export function randomSource(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function drawing(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d');
}

function texture(ctx, anisotropy = 1) {
  const map = new THREE.CanvasTexture(ctx.canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  return map;
}

function turfGrain(random) {
  const tile = drawing(256, 256);
  const pixels = tile.createImageData(256, 256);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const shade = Math.floor(65 + 118 * random());
    pixels.data.set([shade, shade, shade, 255], i);
  }
  tile.putImageData(pixels, 0, 0);
  for (let i = 0; i < 4200; i++) {
    const u = random() * 256, v = random() * 256;
    tile.strokeStyle = i % 2 ? '#d2d5b0' : '#354e3d';
    tile.lineWidth = .7;
    tile.beginPath();
    tile.moveTo(u, v);
    tile.lineTo(u + .5 + random(), v - 1 - random() * 3);
    tile.stroke();
  }
  return tile.canvas;
}

export function turfSize(pitch) {
  return { length: pitch.length + 2.4, width: pitch.width + 2.4 };
}

// Interpolate a few metres of variation at a time. These clumps remain visible
// at broadcast distance after individual blades have faded into the mipmaps.
function mottle(ctx, random, columns, rows, x, y, width, height, opacity) {
  const tile = drawing(columns, rows);
  const pixels = tile.createImageData(columns, rows);
  for (let i = 0; i < pixels.data.length; i += 4) {
    const shade = Math.round(25 + random() * 205);
    pixels.data.set([shade, shade, shade, 255], i);
  }
  tile.putImageData(pixels, 0, 0);
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = opacity;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tile.canvas, x, y, width, height);
  ctx.restore();
}

// Multiply every texel by a linear-light gain (one lookup table per channel). Used for the turf so
// the venue's light kit leaves the grass at its calibrated colour without tinting the chalk.
function linearGain(ctx, gain) {
  const toLinear = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const toSrgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const tables = gain.map((g) => Uint8ClampedArray.from({ length: 256 }, (_, i) => Math.round(255 * toSrgb(Math.min(1, toLinear(i / 255) * g)))));
  const image = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height), d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = tables[0][d[i]];
    d[i + 1] = tables[1][d[i + 1]];
    d[i + 2] = tables[2][d[i + 2]];
  }
  ctx.putImageData(image, 0, 0);
}

export function turfTexture(pitch, low, anisotropy, frost = false, gain = null) {
  const { length: turfLength, width: turfWidth } = turfSize(pitch);
  const random = randomSource(1923);
  const width = low ? 1024 : 2048;
  const ctx = drawing(width, Math.round(width * turfWidth / turfLength));
  const scale = width / turfLength, L = pitch.length / 2, W = pitch.width / 2;
  ctx.translate(width / 2, ctx.canvas.height / 2);
  ctx.scale(scale, scale);
  const base = ctx.createLinearGradient(-L, -W, L, W);
  base.addColorStop(0, frost ? '#658778' : '#518856');
  base.addColorStop(.52, frost ? '#719381' : '#568c53');
  base.addColorStop(1, frost ? '#7b9885' : '#609052');
  ctx.fillStyle = base;
  ctx.fillRect(-turfLength / 2, -turfWidth / 2, turfLength, turfWidth);
  const lane = pitch.length / 12;
  const dark = frost ? '45,71,65' : '24,67,45', light = frost ? '201,220,209' : '202,219,135';
  for (let i = -1; i <= 12; i++) {
    const x = -L + i * lane;
    const stripe = ctx.createLinearGradient(x, 0, x + lane, 0);
    const color = i % 2 ? dark : light;
    stripe.addColorStop(0, 'rgba(' + color + ',.22)');
    stripe.addColorStop(.04, 'rgba(' + color + ',.32)');
    stripe.addColorStop(.96, 'rgba(' + color + ',.35)');
    stripe.addColorStop(1, 'rgba(' + color + ',.24)');
    ctx.fillStyle = stripe;
    ctx.fillRect(x, -turfWidth / 2, lane + .015, turfWidth);
  }
  // Irregular changes in growth, scuffed goalmouths and the centre kick spot.
  function patch(x, z, rx, rz, color) {
    ctx.save();
    ctx.translate(x, z);
    ctx.scale(rx, rz);
    const fade = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    fade.addColorStop(0, color);
    fade.addColorStop(1, 'transparent');
    ctx.fillStyle = fade;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }
  for (let i = 0; i < 90; i++) {
    patch(
      (random() - .5) * turfLength,
      (random() - .5) * turfWidth,
      1 + random() * 5,
      .45 + random() * 3,
      i % 2 ? 'rgba(141,151,64,.10)' : 'rgba(36,83,58,.13)',
    );
  }
  for (const s of [-1, 1]) patch(s * (L - .8), 0, 3.2, 4.1, 'rgba(167,142,87,.50)');
  patch(0, 0, 1.1, .9, 'rgba(166,144,89,.32)');
  const growth = randomSource(802);
  for (const [columns, rows, opacity] of [[32, 19, .22], [112, 73, .21], [245, 142, .18]]) {
    mottle(ctx, growth, columns, rows, -turfLength / 2, -turfWidth / 2, turfLength, turfWidth, opacity);
  }
  if (frost) {
    // Leave the middle cleared. Frost collects along the runoff outside each touchline.
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.scale(1, side);
      const fringe = ctx.createLinearGradient(0, W - .8, 0, turfWidth / 2);
      fringe.addColorStop(0, 'rgba(221,237,239,0)');
      fringe.addColorStop(.5, 'rgba(221,237,239,.18)');
      fringe.addColorStop(1, 'rgba(227,241,242,.75)');
      ctx.fillStyle = fringe;
      ctx.fillRect(-turfLength / 2, W - .8, turfLength, turfWidth / 2 - W + .8);
      ctx.restore();
    }
  }

  if (gain) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    linearGain(ctx, gain);
    ctx.restore();
  }
  // Draw all chalk in metres so the texture, posts and simulation share a pitch.
  ctx.lineWidth = .105;
  ctx.strokeStyle = '#eeeede';
  ctx.fillStyle = '#eeeede';
  ctx.strokeRect(-L, -W, 2 * L, 2 * W);
  ctx.beginPath();
  ctx.moveTo(0, -W);
  ctx.lineTo(0, W);
  ctx.stroke();
  function arc(x, z, r, a, b) {
    ctx.beginPath();
    ctx.arc(x, z, r, a, b);
    ctx.stroke();
  }
  function spot(x) {
    ctx.beginPath();
    ctx.arc(x, 0, .135, 0, Math.PI * 2);
    ctx.fill();
  }
  arc(0, 0, 5, 0, Math.PI * 2);
  spot(0);
  for (const s of [-1, 1]) {
    ctx.save();
    ctx.scale(s, 1);
    for (const [depth, span] of [[pitch.boxDepth, pitch.boxWidth], [3.2, pitch.goalWidth + 3.5]]) {
      ctx.beginPath();
      ctx.moveTo(L, -span / 2);
      ctx.lineTo(L - depth, -span / 2);
      ctx.lineTo(L - depth, span / 2);
      ctx.lineTo(L, span / 2);
      ctx.stroke();
    }
    const spotDepth = pitch.boxDepth - 2.5, penalty = L - spotDepth, radius = 3.6;
    const angle = Math.acos((pitch.boxDepth - spotDepth) / radius);
    arc(penalty, 0, radius, Math.PI - angle, Math.PI + angle);
    spot(penalty);
    arc(L, -W, .68, Math.PI / 2, Math.PI);
    arc(L, W, .68, Math.PI, Math.PI * 1.5);
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const grain = turfGrain(random);
  ctx.globalCompositeOperation = 'soft-light';
  ctx.globalAlpha = .37;
  ctx.fillStyle = ctx.createPattern(grain, 'repeat');
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  // Tiny grass flecks interrupt the paint at field scale without blurring its edge.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = .29;
  ctx.fillStyle = '#72905e';
  for (let i = 0; i < width * 8; i++) ctx.fillRect(random() * width, random() * ctx.canvas.height, 1, 1.4);
  return texture(ctx, anisotropy);
}

export function pavingTexture(anisotropy) {
  const ctx = drawing(256, 256), random = randomSource(413);
  ctx.fillStyle = '#928779';
  ctx.fillRect(0, 0, 256, 256);
  for (let row = 0; row < 8; row++) {
    for (let col = -1; col < 5; col++) {
      const n = Math.round(random() * 19);
      ctx.fillStyle = 'rgb(' + (176 + n) + ',' + (162 + n) + ',' + (139 + n) + ')';
      ctx.fillRect(col * 64 + row % 2 * 32 + 1, row * 32 + 1, 62.5, 30.5);
    }
  }
  ctx.globalAlpha = .16;
  ctx.fillStyle = '#776957';
  for (let i = 0; i < 5000; i++) ctx.fillRect(random() * 256, random() * 256, 1, 1);
  const map = texture(ctx, anisotropy);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

export const orchardWidth = 164, orchardDepth = 128;

export function gardenTexture(pitch, low) {
  const width = low ? 640 : 1280, height = Math.round(width * orchardDepth / orchardWidth);
  const ctx = drawing(width, height), random = randomSource(9462), scale = width / orchardWidth;
  ctx.translate(width / 2, height / 2);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#87946c';
  ctx.fillRect(-orchardWidth / 2, -orchardDepth / 2, orchardWidth, orchardDepth);
  mottle(ctx, random, 53, 38, -orchardWidth / 2, -orchardDepth / 2, orchardWidth, orchardDepth, .78);
  mottle(ctx, random, 132, 94, -orchardWidth / 2, -orchardDepth / 2, orchardWidth, orchardDepth, .50);
  // The processional path passes the stone steps and curves into the olive grove.
  const paths = new Path2D();
  paths.moveTo(-81, -36);
  paths.bezierCurveTo(-40, -43, -32, -24, -9, -25);
  paths.bezierCurveTo(17, -23, 28, -27, 34, -19);
  paths.bezierCurveTo(38, -12, 32, -6, 36, 2);
  paths.bezierCurveTo(45, 16, 48, 22, 82, 28);
  paths.moveTo(33, -9);
  paths.bezierCurveTo(40, -7, 42, -2, 49, -5);
  paths.bezierCurveTo(58, -8, 61, -19, 82, -16);
  ctx.lineJoin = ctx.lineCap = 'round';
  const gravel = drawing(96, 96);
  gravel.fillStyle = '#c7b693';
  gravel.fillRect(0, 0, 96, 96);
  for (let i = 0; i < 2300; i++) {
    gravel.fillStyle = i % 2 ? 'rgba(91,78,58,.29)' : 'rgba(237,224,195,.72)';
    gravel.fillRect(random() * 96, random() * 96, .6 + random() * 1.3, .6 + random());
  }
  const stone = ctx.createPattern(gravel.canvas, 'repeat');
  // The hand-drawn paths and olive grove share the original courtyard layout.
  ctx.scale(pitch.length / 56, pitch.width / 34);
  stone.setTransform(new DOMMatrix().scale(1 / scale));
  ctx.lineWidth = 2.65;
  ctx.strokeStyle = '#a69c7f';
  ctx.stroke(paths);
  ctx.lineWidth = 2.14;
  ctx.strokeStyle = stone;
  ctx.stroke(paths);
  return texture(ctx, 2);
}

export function netTexture(anisotropy) {
  const ctx = drawing(64, 64);
  ctx.strokeStyle = '#f2efde';
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  ctx.moveTo(32, 0);
  ctx.lineTo(32, 64);
  ctx.moveTo(0, 32);
  ctx.lineTo(64, 32);
  ctx.stroke();
  ctx.fillStyle = '#eee9d4';
  ctx.beginPath();
  ctx.arc(32, 32, 3.8, 0, Math.PI * 2);
  ctx.fill();
  const map = texture(ctx, anisotropy);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  return map;
}

export function bannerTexture() {
  const ctx = drawing(256, 160);
  for (let i = 0; i < 2; i++) {
    ctx.save();
    ctx.translate(i * 128, 0);
    const trim = i ? '#e1e9df' : '#e5bc5f';
    ctx.fillStyle = i ? '#305c82' : '#413d2c';
    ctx.fillRect(0, 0, 128, 160);
    ctx.fillStyle = trim;
    ctx.fillRect(7, 0, 4, 160);
    ctx.fillRect(117, 0, 4, 160);
    ctx.fillRect(0, 12, 128, 4);
    if (i) {
      ctx.beginPath();
      ctx.moveTo(37, 86);
      ctx.bezierCurveTo(37, 66, 57, 64, 64, 45);
      ctx.bezierCurveTo(72, 65, 91, 66, 91, 86);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(39, 90, 50, 6);
      ctx.fillRect(62, 37, 4, 13);
      ctx.fillRect(58, 41, 12, 3);
    } else {
      ctx.fillRect(58, 44, 12, 59);
      ctx.fillRect(40, 60, 48, 12);
    }
    ctx.restore();
  }
  return texture(ctx, 4);
}
