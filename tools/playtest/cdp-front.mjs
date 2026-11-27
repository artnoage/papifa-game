import assert from 'node:assert/strict';
import { observeGameCall } from './cdp-moves.mjs';
import { checkKeeperControls, checkStamina } from './cdp-player-controls.mjs';

async function waitFor(evaluate, expression) {
  for (let i = 0; i < 250; i++) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for ' + expression);
}

export async function reloadPage(send, evaluate) {
  const previous = await evaluate('performance.timeOrigin');
  await send('Page.reload');
  await waitFor(evaluate, 'performance.timeOrigin !== ' + previous);
}

async function activate(send, evaluate, selector, mobile) {
  const target = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (!el.contains(document.elementFromPoint(x, y))) throw Error('Control is covered: ' + el.outerHTML.slice(0, 100));
    return { x, y };
  })()`);
  if (mobile) {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...target, id: 1 }] });
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, ...target, button: 'left', clickCount: 1 });
    }
  }
}

// Gameplay tests exercise the same New game, Who's playing? and Kick off buttons after a remembered unlock.
export async function enterMatch(evaluate, send, claimDevice) {
  await waitFor(evaluate, "document.querySelector('#front')?.dataset.ready === 'true' && document.querySelector('#front').dataset.page === 'title'");
  const mobile = await evaluate('navigator.maxTouchPoints > 0');
  await activate(send, evaluate, '#new-game', mobile);
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'players'");
  if (claimDevice) await claimDevice();
  else await activate(send, evaluate, '#claim-slot-0', mobile);
  await waitFor(evaluate, "document.querySelector('#claim-continue')?.disabled === false");
  await activate(send, evaluate, '#claim-continue', mobile);
  await waitFor(evaluate, "document.querySelector('#front').dataset.page === 'teams'");
  await activate(send, evaluate, '#kick-off', mobile);
  await waitFor(evaluate, "document.querySelector('#match-shell')?.hidden === false");
  if (await evaluate("!document.querySelector('#venue-intro').hidden")) await activate(send, evaluate, '#skip-intro', mobile);
}

// Compare two renders of the same patch of grass. A correctly projected ring can still be painted over.
async function checkAimReticle(send, evaluate, advance) {
  const point = await evaluate('({x:Math.round(innerWidth*.64), y:Math.round(innerHeight*.65)})');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await advance();
  const changed = await evaluate(`(() => {
    const ring = flowScene.getObjectByName('Mouse aim');
    if (!ring.visible) return 0;
    const gl = flowRenderer.getContext(), side = 64;
    const x = Math.round(${point.x} * gl.drawingBufferWidth / innerWidth) - side / 2;
    const y = Math.round((1 - ${point.y} / innerHeight) * gl.drawingBufferHeight) - side / 2;
    function sample(visible) {
      ring.visible = visible;
      flowRenderer.render(flowScene, flowCamera);
      const pixels = new Uint8Array(side * side * 4);
      gl.readPixels(x, y, side, side, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    }
    const grass = sample(false), target = sample(true);
    let count = 0;
    for (let i = 0; i < grass.length; i += 4) if (Math.abs(target[i] - grass[i]) >= 24) count++;
    return count;
  })()`);
  assert.ok(changed >= 20, 'The mouse reticle must be visible on the grass under the cursor');
}

export async function checkFrontEnd({ url, send, evaluate, shot }) {
  const pageIs = name => waitFor(evaluate, 'document.querySelector("#front")?.dataset.ready === "true" && document.querySelector("#front").dataset.page === ' + JSON.stringify(name));
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "window.flowPolicyErrors=[]; addEventListener('securitypolicyviolation',e=>flowPolicyErrors.push(e.effectiveDirective))" });
  let mobile = false;
  const tap = selector => activate(send, evaluate, selector, mobile);
  for (const device of ['desktop','phone']) {
    mobile = device === 'phone';
    const width=mobile?390:1280, height=mobile?844:800;
    await send('Emulation.setDeviceMetricsOverride', {width,height,mobile,deviceScaleFactor:1});
    await send('Emulation.setTouchEmulationEnabled', {enabled:mobile,maxTouchPoints:mobile?5:1});
    await send('Storage.clearDataForOrigin', {origin:new URL(url).origin, storageTypes:'local_storage'});
    const link=new URL(url);
    const size=mobile?5:3, field=mobile?'winter':'meteora';
    link.searchParams.set('size',mobile?'3':'5');
    link.searchParams.set('field','WINTER');
    link.searchParams.set('kit', mobile?'gold':'away');
    link.searchParams.set('level',mobile?'normal':'HARD');
    link.searchParams.set('match','friendly'); link.hash='pitch';
    await send('Page.navigate', {url:link.href});
    await pageIs('title');
    if (mobile) {
      const { result } = await send('Page.getAppManifest');
      assert.deepEqual(result.errors, []);
      const manifest = JSON.parse(result.data);
      const root = new URL('./', link).href;
      assert.equal(new URL(manifest.start_url, result.url).href, root);
      assert.equal(new URL(manifest.scope, result.url).href, root);
      assert.equal(manifest.display, 'fullscreen');
      assert.ok(['192x192', '512x512'].every(size => manifest.icons.some(icon => icon.sizes === size)));
      const { result: install } = await send('Page.getInstallabilityErrors');
      assert.deepEqual(install.installabilityErrors, []);
    }
    await waitFor(evaluate,"document.querySelector('.portrait-model img').naturalWidth > 0");
    // No access code: a first visit opens straight on the title menu.
    assert.ok(await evaluate("!document.querySelector('#match-code') && document.querySelector('#menu-back').hidden && document.querySelector('#match-shell').hidden"));
    if (!mobile) await waitFor(evaluate,"!!document.querySelector('.portrait-model.has-model canvas')");
    await shot(device+'-title');
    await tap('#menu-sound');
    assert.equal(await evaluate("document.querySelector('#menu-sound').getAttribute('aria-pressed')"),'false');
    await reloadPage(send, evaluate);
    await pageIs('title');
    await waitFor(evaluate, "document.querySelector('#menu-sound')?.getAttribute('aria-pressed') === 'false'");
    await tap('button[data-page="controls"]'); await pageIs('controls');
    assert.equal(await evaluate("document.querySelectorAll('#front-moves dt').length"),6);
    assert.ok(await evaluate(`getComputedStyle(document.querySelector('#front-moves .${mobile?'finger':'key'}-move')).display !== 'none'`));
    await shot(device+'-controls'); await tap('#menu-back');
    await tap('button[data-page="difficulty"]'); await pageIs('difficulty');
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#menu-levels input')].map(i => i.value)"), ['veryEasy', 'easy', 'normal', 'hard', 'veryHard']);
    assert.equal(await evaluate("document.querySelector('#menu-levels :checked').value"), mobile?'normal':'hard');
    await tap('#menu-levels label:has([value=veryEasy])');
    assert.equal(await evaluate("localStorage.getItem('papifa.level.v1')"), 'veryEasy');
    await shot(device+'-difficulty');
    await tap('#menu-levels label:has([value=easy])');
    await tap('#menu-back'); await tap('#new-game'); await pageIs('players');
    assert.equal(await evaluate("document.querySelector('#local-mode-option').hidden"), mobile, 'Local 2P hidden on touch-only phone and shown on desktop');
    assert.equal(await evaluate("document.querySelector('#claim-continue').disabled"), true);
    await tap('#claim-slot-0');
    await waitFor(evaluate, "document.querySelector('#claim-continue').disabled === false");
    await shot(device+'-players');
    await tap('#claim-continue'); await pageIs('teams');
    assert.equal(await evaluate("document.querySelector('#match-size :checked').value"),mobile?'3':'5');
    assert.equal(await evaluate("document.querySelector('#match-field').value"),'winter');
    await tap('#match-size label:has([value="'+size+'"])');
    await evaluate(`(() => {
      const select=document.querySelector('#match-field');
      select.value=${JSON.stringify(field)};
      select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    const human = mobile?'gold':'blue', opponent=mobile?'blue':'gold';
    assert.equal(await evaluate("document.querySelector('#kit-options :checked').value"),human);
    await tap('.team-choice.'+opponent); await tap('.team-choice.'+human);
    assert.equal(await evaluate("document.querySelector('#kit-options :checked').value"),human);
    const tiles=mobile?'li:not([hidden]) .kit-pair img':'.squad-trio img';
    await waitFor(evaluate,`[...document.querySelectorAll('${tiles}')].every(i => i.naturalWidth>0 && i.getBoundingClientRect().width>0)`);
    assert.equal(await evaluate("document.querySelectorAll('#lineup li:not([hidden])').length"),size);
    assert.ok(await evaluate("document.querySelector('#front').scrollWidth <= innerWidth"));
    await shot(device+'-teams');
    // Drive the real game clock after leaving the menu. Replays still use the production frame loop.
    await evaluate(`(() => {
      let now=performance.now(), callback;
      window.openingWhistles=0;
      const startOscillator=OscillatorNode.prototype.start;
      OscillatorNode.prototype.start=function(...args){
        if(this.type==='square' && this.frequency.value===2900) window.openingWhistles++;
        return startOscillator.apply(this,args);
      };
      Object.defineProperty(performance,'now',{value:()=>now});
      window.requestAnimationFrame=fn=>{callback=fn;return 1};
      window.advanceFlow=(ms=0,n=1)=>{if(!callback)return false;for(let i=0;i<n;i++){now+=ms;callback(now)}return true};
    })()`);
    await tap('#kick-off');
    await waitFor(evaluate,"!document.querySelector('#match-shell').hidden && advanceFlow(0)");
    const advance=(ms=34,n=1)=>evaluate('advanceFlow('+ms+','+n+')');
    assert.ok(await evaluate("!document.querySelector('#venue-intro').hidden"));
    assert.ok(await evaluate("document.querySelector('#player-edge').hidden"));
    assert.equal(await evaluate("document.querySelector('#venue-name').textContent"),mobile?'Winter monastery':'Meteora cliff-top');
    await advance(100,8);
    assert.equal(await evaluate('openingWhistles'),0);
    await shot(device+'-venue-opening');
    if (mobile) await tap('#skip-intro');
    else await evaluate("for(let i=0;i<32 && !document.querySelector('#venue-intro').hidden;i++)advanceFlow(100)");
    assert.ok(await evaluate("document.querySelector('#venue-intro').hidden && document.querySelector('#clock').textContent==='3:00'"));
    assert.equal(await evaluate('openingWhistles'),1);
    await advance();
    await evaluate(`(async () => {
      const {Scene}=await import('three'), orig=Scene.prototype.onBeforeRender;
      Scene.prototype.onBeforeRender=function(...args){window.flowScene=this;window.flowRenderer=args[0];window.flowCamera=args[2];return orig.apply(this,args)};
      try {advanceFlow()} finally {Scene.prototype.onBeforeRender=orig}
      window.roster=()=>flowScene.children.filter(o=>o.getObjectByProperty('isSkinnedMesh',true));
      window.kitMaps=()=>roster().map(actor=>{
        let name='',ring;
        actor.traverse(o=>{
          if(o.isSkinnedMesh && o.material.name==='Mat_Body')name=(o.material.map.image.currentSrc || o.material.map.image.src || '').split('/').pop();
          if(o.geometry?.type==='RingGeometry')ring=o.material.color.getHex();
        });return {id:actor.name,name,ring};
      });
    })()`);
    await waitFor(evaluate,'roster().length === '+(size*2+1));
    await send('Debugger.enable');
    await observeGameCall(send,'sim','step','(window.flowMatch=m,false)');
    await advance();
    const names=mobile?['Gold Cross','Blue Dome']:['Blue Dome','Gold Cross'];
    const sides=mobile?['home','away']:['away','home'];
    const colors=mobile?[0xffc83d,0x3d9bff]:[0x3d9bff,0xffc83d];
    async function checkKits() {
      const maps=await evaluate('kitMaps()');
      maps.slice(0,-1).forEach((m,i)=>{
        const side=i<size?0:1;
        assert.equal(m.name,m.id+'_'+sides[side]+'.webp');
        assert.equal(m.ring, colors[side]);
      });
      assert.equal(maps.at(-1).id,'patriarch');assert.doesNotMatch(maps.at(-1).name,/_(?:home|away)\.webp$/);
      assert.equal(await evaluate("flowScene.children.find(o=>o.geometry?.type==='ConeGeometry').material.color.getHex()"),colors[0]);
    }
    await checkKits();
    assert.ok(await evaluate(`(() => {
      const priest=flowMatch.human, initial=priest.info.name.split(' ').at(-1)[0];
      const marker=document.querySelector('#player-edge'), x=priest.pos.x;
      priest.pos.x=flowMatch.pitch.length;
      advanceFlow(0);
      const rect=marker.getBoundingClientRect();
      const offscreen=marker.classList.contains('visible') && marker.textContent===initial
        && rect.left>innerWidth/2 && rect.right<=innerWidth;
      priest.pos.x=x; advanceFlow(0);
      return offscreen && !marker.classList.contains('visible');
    })()`), 'the controlled priest has a right-edge marker only while outside the frame');
    if (!mobile) {
      await checkAimReticle(send, evaluate, advance);
      await tap('#score');
      await advance();
      assert.equal(await evaluate('flowMatch.stats[0].shots'),0,'Clicking the scoreboard must not shoot');
    }
    assert.deepEqual(await evaluate("[0,1].map(i=>document.getElementById('name'+i).textContent)"),names);
    assert.ok(await evaluate("flowMatch.human.team===0 && flowMatch.level==='easy' && !document.querySelector('#pause-menu').open"));
    const address = new URL(await evaluate('location.href'));
    assert.equal(address.searchParams.get('size'),String(size));
    assert.equal(address.searchParams.get('field'),field);
    const layout={size,field,players:2*size,length:size===3?56:73,width:size===3?34:44};
    const matchLayout=()=>evaluate('({size:flowMatch.size,field:flowMatch.field,players:flowMatch.players.length,length:flowMatch.pitch.length,width:flowMatch.pitch.width})');
    assert.deepEqual(await matchLayout(),layout);
    assert.equal(address.searchParams.get('kit'),human); assert.equal(address.searchParams.get('match'),'friendly'); assert.equal(address.hash,'#pitch');
    await shot(device+'-kickoff');
    if (mobile) {
      const point = await evaluate(`(() => {
        const r = document.querySelector('#touch-stick').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...point }] });
      assert.ok(await evaluate("document.querySelector('#touch-stick').classList.contains('held')"), 'kick-off accepts a sustained touch');
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
    // Score 3.5 s after launch so the goal replay opens with the priest already on the turf.
    assert.ok(await evaluate(`(async () => {
      const { slideTackle } = await import('./src/sim.js');
      const p = flowMatch.human, ball = flowMatch.ball;
      ball.owner = null;
      for (const actor of flowMatch.players) ball.noPickup.set(actor, flowMatch.t + 4);
      window.slideHips = roster()[flowMatch.players.indexOf(p)].getObjectByName('hips');
      return slideTackle(flowMatch, p, {x:1,z:0});
    })()`));
    await advance(100,4);
    const contactHeight = await evaluate('slideHips.matrixWorld.elements[13]');
    assert.ok(contactHeight < .4, 'the live slide reaches the turf');
    await advance(100,31);
    await evaluate("Object.assign(flowMatch.ball,{owner:null,receiver:null,shot:null,pos:{x:flowMatch.pitch.length/2+.5,y:.6,z:0},vel:{x:9,y:0,z:0}})");
    await advance();
    assert.equal(await evaluate("document.querySelector('#banner').textContent"),'GOAL! '+names[0]);
    assert.ok(await evaluate("getComputedStyle(document.querySelector('#banner')).color === getComputedStyle(document.querySelector('#name0')).color"));
    await shot(device+'-goal');
    await evaluate("for(let i=0;i<50 && document.querySelector('#replay').hidden;i++)advanceFlow(70)");
    assert.ok(await evaluate("!document.querySelector('#replay').hidden"));
    const replayHeight = await evaluate('slideHips.matrixWorld.elements[13]');
    assert.ok(Math.abs(replayHeight - contactHeight) < .05, 'a replay opening mid-slide must keep the priest on the turf');
    assert.ok(await evaluate("document.querySelector('#player-edge').hidden"));
    await checkKits(); await shot(device+'-replay');
    await evaluate("for(let i=0;i<100 && !document.querySelector('#replay').hidden;i++)advanceFlow(100)");
    await evaluate("for(let i=0;i<20 && flowMatch.phase==='goal';i++)advanceFlow(100); flowMatch.clock=.001");
    await advance();
    assert.deepEqual(await evaluate("[...document.querySelectorAll('#results-card thead th')].map(h=>h.textContent)"),names);
    assert.ok(await evaluate("!document.querySelector('#results-card').hidden"));
    await shot(device+'-fulltime');
    await tap('#rematch-button'); await advance();
    if (await evaluate("!document.querySelector('#venue-intro').hidden")) await tap('#skip-intro');
    await advance();
    assert.deepEqual(await matchLayout(),layout);
    await send('Debugger.disable');
    assert.ok(await evaluate("document.querySelector('#results-card').hidden && document.querySelector('#front').hidden && document.querySelector('#s0').textContent==='0' && document.querySelector('#clock').textContent==='3:00'"));
    await checkKits();
    if (!mobile) await checkKeeperControls({ send, evaluate, advance, shot });
    await checkStamina({ send, evaluate, advance, shot, mobile });
    if (await evaluate("!!document.querySelector('meta[http-equiv=Content-Security-Policy]')")) {
      assert.deepEqual(await evaluate('flowPolicyErrors'), []);
      assert.deepEqual(await evaluate("performance.getEntriesByType('resource').map(e=>new URL(e.name)).filter(u=>/^https?:$/.test(u.protocol) && u.origin!==location.origin).map(u=>u.origin)"), []);
    }
    console.log(device, 'passed title on first visit, menus, both lineups, kickoff, goal, replay, full time and rematch as', names[0]);
  }
  // Storage can be disabled by the browser. The menu must still open.
  const {result:{identifier}}=await send('Page.addScriptToEvaluateOnNewDocument', {source:"Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage blocked','SecurityError')}})"});
  await send('Page.navigate',{url}); await pageIs('title');
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier});
  console.log('The title menu opens when storage is blocked.');
}
