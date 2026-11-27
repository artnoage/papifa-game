// Button meaning is fixed on press, even if possession changes before release.
export function createMouseControls(target, liveMatch, emit, team = 0) {
  const { canvas } = target, aim = { x: 0, z: 0 };
  let x = 0, y = 0, lastUse = -Infinity, shooting = false;
  const hasBall = match => !!match.ball.owner && match.ball.owner === (match.humans ? match.humans[team] : match.human);

  function reset() {
    shooting = false;
    lastUse = -Infinity;
    target.hide();
  }
  function point() {
    if (!liveMatch()) { reset(); return null; }
    if (performance.now() - lastUse > 3500) {
      target.hide();
      return null;
    }
    const hit = target.at(x, y);
    if (!hit) return null;
    aim.x = hit.x;
    aim.z = hit.z;
    return aim;
  }
  function track(e) {
    x = e.clientX;
    y = e.clientY;
    lastUse = performance.now();
  }
  function begin(e) {
    const match = liveMatch();
    if (e.pointerType !== 'mouse' || !match || (e.button !== 0 && e.button !== 2)) return;
    track(e);
    if (!point()) return;
    const attacking = hasBall(match);
    if (e.button === 0 && attacking) {
      shooting = true;
      emit('shootPressed');
    } else if (e.button === 2 && !attacking) {
      if (!e.shiftKey) { emit('switchPressed'); emit('switchToAim'); }
    } else {
      emit('passPressed');
      if (e.button === 2 && e.shiftKey) emit('throughPressed');
    }
    e.preventDefault();
  }
  function end(e) {
    if (e.pointerType !== 'mouse' || e.button !== 0 || !shooting) return;
    shooting = false;
    if (liveMatch()) { track(e); emit('shootReleased'); }
  }
  canvas.addEventListener('pointerdown', begin);
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !liveMatch()) return;
    track(e);
    // Pointer Events report additional button transitions as moves while another button is down.
    if (e.button === 0 || e.button === 2) {
      if (e.buttons & (e.button === 0 ? 1 : 2)) begin(e);
      else end(e);
    }
  });
  canvas.addEventListener('pointerleave', reset);
  canvas.addEventListener('pointercancel', reset);
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  return {
    point,
    reset,
    hasBall: () => { const m = liveMatch(); return !!(m && hasBall(m)); },
    get shooting() { return shooting; },
  };
}
