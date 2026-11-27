import { Vector3 } from 'three';
import { STAMINA } from './config.js';

function ensureSlotElements(container, slot) {
  const edgeId = slot === 0 ? 'player-edge' : `player-edge-${slot}`;
  const staminaId = slot === 0 ? 'player-stamina' : `player-stamina-${slot}`;
  let marker = container.querySelector('#' + edgeId);
  if (!marker && slot > 0) {
    marker = document.createElement('div');
    marker.id = edgeId;
    marker.className = 'player-edge';
    marker.dataset.team = String(slot);
    marker.setAttribute('aria-hidden', 'true');
    marker.hidden = true;
    marker.innerHTML = '<i></i><b></b>';
    container.prepend(marker);
  }
  let pitchMeter = container.querySelector('#' + staminaId);
  if (!pitchMeter && slot > 0) {
    pitchMeter = document.createElement('div');
    pitchMeter.id = staminaId;
    pitchMeter.className = 'stamina-bar player-stamina';
    pitchMeter.dataset.team = String(slot);
    pitchMeter.setAttribute('aria-hidden', 'true');
    pitchMeter.hidden = true;
    container.prepend(pitchMeter);
  }
  return { marker, pitchMeter };
}

// Place off-screen edge arrows and pitch stamina meters for up to two human-controlled priests
// (team 0 in --team-0, team 1 in --team-1). HUD rectangles stop each arrow early so tips and
// bars stay clear of the scoreboard, hints, touch controls, and each other.
export function createPlayerIndicator(container, touchTeam = 0) {
  const baseMarker = container.querySelector('#player-edge');
  if (!baseMarker) return () => {};
  const touchMeter = container.querySelector('#touch-stamina');
  const point = new Vector3();
  const overlays = container.querySelectorAll(
    '#score, #clock, #controlled-bar, #controlled, #controlled-1, #move-signal, #help, #pause-button, #move-help summary, #move-help .move-panel, .touch-movement, .touch-actions',
  );
  const powerBars = [...container.querySelectorAll('#power, #power-1')];
  let rectangles = [], layoutChanged = true;
  const invalidate = () => { layoutChanged = true; };
  const observer = new ResizeObserver(invalidate);
  for (const element of overlays) observer.observe(element);
  for (const details of container.querySelectorAll('details')) details.addEventListener('toggle', invalidate);
  addEventListener('resize', invalidate);

  const slots = [0, 1].map((slot) => {
    const { marker, pitchMeter } = ensureSlotElements(container, slot);
    if (marker) {
      marker.classList.add('player-edge');
      marker.dataset.team = String(slot);
    }
    if (pitchMeter) {
      pitchMeter.classList.add('player-stamina');
      pitchMeter.dataset.team = String(slot);
    }
    return {
      slot,
      marker,
      letter: marker?.querySelector('b') ?? null,
      pitchMeter,
      lastPercent: undefined,
      lastLevel: undefined,
    };
  });

  function updateStamina(st, value, syncTouch) {
    const percent = Math.ceil(value * 100);
    const level = value <= 0 ? 'empty' : value < STAMINA.tired ? 'low' : 'fresh';
    if (percent === st.lastPercent && level === st.lastLevel) return;
    if (st.pitchMeter) {
      st.pitchMeter.style.setProperty('--stamina-fill', percent + '%');
      st.pitchMeter.dataset.stamina = level;
    }
    if (syncTouch && touchMeter) {
      touchMeter.style.setProperty('--stamina-fill', percent + '%');
      touchMeter.dataset.stamina = level;
      touchMeter.setAttribute('aria-valuenow', percent);
    }
    st.lastPercent = percent;
    st.lastLevel = level;
  }

  function overlaps(x, y, rects) {
    return rects.some(r => x + 20 > r.left && x - 20 < r.right && y + 1 > r.top && y - 7 < r.bottom);
  }

  // Keep the 38 x 6 px bar and its outline clear of HUD boxes and the other human's indicators.
  function placeMeter(st, x, y, rects) {
    if (!st.pitchMeter) return null;
    x = Math.round(x); y = Math.round(y);
    if (x < 20 || x > innerWidth - 20 || y < 7 || y >= innerHeight) return null;
    if (overlaps(x, y, rects)) return null;
    st.pitchMeter.style.transform = `translate(${x}px,${y}px) translate(-50%,-100%)`;
    return { left: x - 21, right: x + 21, top: y - 9, bottom: y + 2 };
  }

  function hideSlot(st) {
    if (st.marker) {
      st.marker.hidden = true;
      st.marker.classList.remove('visible');
    }
    if (st.pitchMeter) st.pitchMeter.hidden = true;
  }

  function updateSlot(st, player, camera, frameRects, syncTouch) {
    if (!player || !st.marker) {
      hideSlot(st);
      return;
    }
    updateStamina(st, player.stamina, syncTouch);
    st.marker.hidden = false;
    const cx = innerWidth / 2, cy = innerHeight / 2;
    point.set(player.pos.x, 1.05, player.pos.z).applyMatrix4(camera.matrixWorldInverse);
    const behind = point.z >= -camera.near;
    // A point behind the lens projects onto the opposite edge. Preserve its direction.
    point.z = -Math.max(camera.near, Math.abs(point.z));
    point.applyMatrix4(camera.projectionMatrix);
    const dx = point.x * cx, dy = -point.y * cy;
    const x = cx + dx, y = cy + dy;
    const covered = rectangles.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    if (!behind && !covered && Math.abs(dx) < cx && Math.abs(dy) < cy) {
      st.marker.classList.remove('visible');
      point.set(player.pos.x, 3.12, player.pos.z).project(camera);
      let placed = placeMeter(st, cx * (1 + point.x), cy * (1 - point.y) - 3, frameRects);
      if (!placed) {
        point.set(player.pos.x, 0, player.pos.z).project(camera);
        placed = placeMeter(st, cx * (1 + point.x), cy * (1 - point.y) + 15, frameRects);
      }
      if (st.pitchMeter) st.pitchMeter.hidden = !placed;
      if (placed) frameRects.push(placed);
      return;
    }

    // The disc and its arrowhead fit inside a 20 px radius.
    const pad = 21;
    let t = Math.min((cx - pad) / (Math.abs(dx) || 1e-8), (cy - pad) / (Math.abs(dy) || 1e-8));
    for (const r of frameRects) {
      const x1 = (r.left - pad - cx) / (dx || 1e-8), x2 = (r.right + pad - cx) / (dx || 1e-8);
      const y1 = (r.top - pad - cy) / (dy || 1e-8), y2 = (r.bottom + pad - cy) / (dy || 1e-8);
      const enter = Math.max(Math.min(x1, x2), Math.min(y1, y2));
      const exit = Math.min(Math.max(x1, x2), Math.max(y1, y2));
      if (enter >= 0 && enter <= exit) t = Math.min(t, enter);
    }
    const ex = Math.round(cx + dx * t), ey = Math.round(cy + dy * t);
    st.marker.style.transform = `translate(${ex}px,${ey}px) translate(-50%,-50%)`;
    const edgeBox = { left: ex - pad, right: ex + pad, top: ey - pad, bottom: ey + pad };
    const placed = placeMeter(st, ex + (ex < cx ? 36 : -36), ey + 3, frameRects)
      || placeMeter(st, ex, ey + (ey < cy ? 25 : -19), frameRects);
    if (st.pitchMeter) st.pitchMeter.hidden = !placed;
    frameRects.push(edgeBox);
    if (placed) frameRects.push(placed);
    st.marker.style.setProperty('--angle', Math.atan2(dy, dx) + 'rad');
    const initial = player.info.name.trim().split(/\s+/).at(-1)[0];
    if (st.letter && st.letter.textContent !== initial) st.letter.textContent = initial;
    st.marker.classList.add('visible');
  }

  return (players, camera) => {
    const list = Array.isArray(players) ? [players[0] ?? null, players[1] ?? null] : [players ?? null, null];
    if (touchMeter) touchMeter.hidden = !list[touchTeam];
    if (!list[0] && !list[1]) {
      for (const st of slots) hideSlot(st);
      return;
    }
    if (layoutChanged) {
      rectangles = [...overlays]
        .filter(e => !e.closest('details:not([open])') || Boolean(e.closest('summary')))
        .map(e => e.getBoundingClientRect())
        .filter(r => r.width && r.height);
      layoutChanged = false;
    }
    const frameRects = rectangles.slice();
    for (const bar of powerBars) {
      if (!bar.hidden && bar.style.visibility === 'visible') {
        const r = bar.getBoundingClientRect();
        if (r.width && r.height) frameRects.push(r);
      }
    }
    updateSlot(slots[0], list[0], camera, frameRects, touchTeam === 0);
    updateSlot(slots[1], list[1], camera, frameRects, touchTeam === 1);
  };
}
