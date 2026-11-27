import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { enterMatch } from './cdp-front.mjs';
import { matchSetup } from '../../game/src/fields.js';

// Runs in the browser so projection and sampling use the screenshot's actual device pixels.
async function torsoMedians(png) {
  const { Vector3 } = await import('three');
  const image = new Image();
  image.src = 'data:image/png;base64,' + png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width; canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  function project(actor, height) {
    const v = actor.getWorldPosition(new Vector3());
    v.y += height; v.project(window.kitCamera);
    return { x: (1 + v.x) * canvas.width / 2, y: (1 - v.y) * canvas.height / 2 };
  }
  const players = window.kitActors.slice(0, -1);
  return players.map((actor, slot) => {
    const head = project(actor, 2.05), foot = project(actor, 0.08);
    const half = Math.max(2, Math.round(Math.abs(foot.y - head.y) * 0.095));
    const luma = [];
    for (let row = 0; row < 18; row++) {
      const t = 0.25 + 0.55 * row / 17;
      const y = Math.round(head.y + (foot.y - head.y) * t);
      const centre = Math.round(head.x + (foot.x - head.x) * t);
      for (let x = centre - half; x <= centre + half; x++) {
        if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) continue;
        const i = 4 * (y * canvas.width + x);
        const r = pixels[i], g = pixels[i+1], b = pixels[i+2];
        if (g > 1.15*r && g > 1.15*b) continue;
        luma.push(0.2126*r + 0.7152*g + 0.0722*b);
      }
    }
    if (!luma.length) throw new Error('Empty torso sample for ' + actor.name);
    luma.sort((a,b) => a-b);
    const median = (luma[Math.floor((luma.length-1)/2)] + luma[Math.floor(luma.length/2)]) / 2;
    return { id: actor.name, team: window.kitSides[slot < players.length / 2 ? 0 : 1], median, samples: luma.length };
  });
}

export async function checkBroadcastKits({ url, out, send, evaluate, shot }) {
  const { size, field } = matchSetup(new URL(url).searchParams);
  // Keep both keepers in the kickoff photograph on the wider five-a-side pitch.
  await send('Emulation.setDeviceMetricsOverride', { width: size === 3 ? 1280 : 1720, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    let frame;
    Object.defineProperty(performance, 'now', { value: () => 1000 });
    Date.now = () => 23;
    requestAnimationFrame = callback => { frame = callback; return 1; };
    window.drawKits = () => { if (!frame) return false; frame(1000); return true; };
  })()` });
  await send('Page.navigate', { url });
  await enterMatch(evaluate, send);
  async function waitFor(expression, reason) {
    for (let i = 0; i < 300; i++) {
      if (await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(reason);
  }
  await waitFor("window.drawKits?.() && document.querySelector('#controlled')?.textContent", 'Kick-off did not load');
  await evaluate(`(async () => {
    const {Scene} = await import('three');
    const original = Scene.prototype.onBeforeRender;
    Scene.prototype.onBeforeRender = function (...args) { window.kitRenderer = args[0]; window.kitScene = this; window.kitCamera = args[2].clone(); return original.apply(this, args); };
    try { drawKits(); } finally { Scene.prototype.onBeforeRender = original; }
    // Use the same wide kickoff photograph for every kit, independent of the venue's opening sweep.
    kitCamera.position.set(0, 30, 30);
    kitCamera.lookAt(0, 0, 0);
    kitCamera.updateMatrixWorld();
    window.drawKitPhoto = () => kitRenderer.render(kitScene, kitCamera);
  })()`);
  await waitFor("(window.kitActors = kitScene.children.filter(o => o.getObjectByProperty('isSkinnedMesh', true))).length === "+(size*2+1), 'The skinned lineup did not load');
  const landmark = { meteora: 'Meteora cliff parapet', winter: 'Snowy monastery walls' }[field];
  if (landmark) await waitFor(`kitScene.getObjectsByProperty('isInstancedMesh', true).some(o => o.name.startsWith(${JSON.stringify(landmark)}))`, 'The selected venue GLB did not load');
  await evaluate('drawKits(); drawKitPhoto()');
  const kit = new URL(url).searchParams.get('kit')?.toLowerCase();
  const sides = ['blue','away','blue-dome'].includes(kit) ? ['away','home'] : ['home','away'];
  await evaluate('window.kitSides = '+ JSON.stringify(sides));
  const kits = await evaluate(`kitActors.map(actor => {
    const maps = {};
    actor.traverse(o => { if (o.isSkinnedMesh && o.material.map) {
      const i = o.material.map.image;
      maps[o.material.name] = (i.currentSrc || i.src || 'embedded').split('/').pop();
    } });
    return { id: actor.name, maps };
  })`);
  for (const [slot, actor] of kits.entries()) {
    for (const part of ['Mat_Body', 'Mat_VestmentPrimary']) {
      if (slot < size*2) assert.equal(actor.maps[part], actor.id + '_' + sides[slot < size ? 0 : 1] + '.webp', part);
      else assert.doesNotMatch(actor.maps[part], /_(home|away)\.webp/);
    }
  }
  await shot('broadcast-kickoff');
  await evaluate(`kitScene.traverse(o => {
    if (o.isMesh && ['RingGeometry', 'CircleGeometry', 'ConeGeometry'].includes(o.geometry.type)) o.material.visible = false;
  }); drawKitPhoto()`);
  await shot('broadcast-without-rings');
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  const levels = await evaluate('(' + torsoMedians.toString() + ')(' + JSON.stringify(result.data) + ')');
  await evaluate("document.querySelector('canvas').style.filter = 'grayscale(1)'");
  await shot('broadcast-grey-without-rings');
  writeFileSync(join(out, 'torso-brightness.json'), JSON.stringify(levels, null, 2) + '\n');
  console.table(levels.map(x => ({ priest: x.id, team: x.team, median: x.median.toFixed(1), pixels: x.samples })));
  const misses = levels.filter(x => x.team === 'home' ? x.median > 70 : x.median < 140);
  assert.equal(misses.length, 0, 'Expected home ≤70 and away ≥140. Outside range: ' + misses.map(x => x.team+' '+x.id).join(', '));
}
