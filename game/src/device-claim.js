// "Who's playing?" device-claim logic for vs AI and Local 2P.
// Produces team-order device descriptors:
//   { type: 'keyboard' } | { type: 'gamepad', index: Gamepad.index } | { type: 'touch' }

export function isTouchOnlyDevice(env = globalThis) {
  const nav = env.navigator;
  const hasTouch = (nav?.maxTouchPoints ?? 0) > 0;
  if (!hasTouch) return false;
  if (typeof env.matchMedia !== 'function') return true;
  const coarse = env.matchMedia('(pointer: coarse)').matches;
  const fine = env.matchMedia('(any-pointer: fine)').matches;
  return coarse && !fine;
}

export function deviceKey(device) {
  if (!device) return '';
  return device.type === 'gamepad' ? `gamepad:${device.index}` : device.type;
}

export function deviceLabel(device) {
  if (!device) return '';
  if (device.type === 'keyboard') return 'Keyboard & mouse';
  if (device.type === 'touch') return 'Touch';
  if (device.type === 'gamepad') return `Controller ${device.index + 1}`;
  return String(device.type);
}

export function canClaimInMode(mode, device) {
  if (!device) return false;
  if (mode === 'local') return device.type === 'keyboard' || device.type === 'gamepad';
  return device.type === 'keyboard' || device.type === 'gamepad' || device.type === 'touch';
}

export function createDeviceClaim({
  touchOnly = isTouchOnlyDevice(),
  getGamepads = () => globalThis.navigator?.getGamepads?.() ?? [],
  onChange = () => {},
  onClaim = () => {},
  onContinue = () => {},
} = {}) {
  let mode = 'ai';
  let slots = [null, null];
  let notice = '';
  let active = false;
  let rafId = 0;
  const prevPadButtons = new Map();

  function requiredCount() {
    return mode === 'local' ? 2 : 1;
  }

  function ready() {
    if (mode === 'local') return Boolean(slots[0] && slots[1]);
    return Boolean(slots[0]);
  }

  function devices() {
    return mode === 'local' ? [slots[0], slots[1]] : [slots[0], null];
  }

  function state() {
    const pads = [...(getGamepads() || [])].filter(Boolean);
    return {
      mode,
      touchOnly,
      slots: [slots[0], slots[1]],
      devices: devices(),
      required: requiredCount(),
      ready: ready(),
      notice,
      connectedPads: pads.length,
    };
  }

  function emitChange() {
    onChange(state());
  }

  function setMode(nextMode) {
    const resolved = ['host', 'join'].includes(nextMode) || (nextMode === 'local' && !touchOnly) ? nextMode : 'ai';
    if (resolved === mode) { emitChange(); return; }
    mode = resolved;
    notice = '';
    if (mode === 'local') {
      // Touch is not valid in Local 2P; preserve keyboard/gamepad claims when upgrading from vs AI.
      if (slots[0] && !canClaimInMode('local', slots[0])) slots[0] = null;
      if (slots[1] && !canClaimInMode('local', slots[1])) slots[1] = null;
    } else {
      if (!slots[0] && slots[1]) slots[0] = slots[1];
      slots[1] = null;
    }
    emitChange();
  }

  function claim(device) {
    if (!device) return { claimed: false, reason: 'invalid' };
    if (!canClaimInMode(mode, device)) {
      notice = 'Local 2P needs two controllers, or keyboard + mouse and a controller.';
      emitChange();
      return { claimed: false, reason: 'unsupported' };
    }
    const key = deviceKey(device);
    const req = requiredCount();
    // Already claimed by a slot?
    for (let i = 0; i < req; i++) {
      if (deviceKey(slots[i]) === key) {
        if (ready()) {
          notice = '';
          return { claimed: false, reason: 'duplicate', alreadyReady: true, slot: i };
        }
        notice = mode === 'local'
          ? `${deviceLabel(device)} is already Player ${i + 1}. Claim Player ${i === 0 ? 2 : 1} with another device.`
          : '';
        emitChange();
        return { claimed: false, reason: 'duplicate', slot: i };
      }
    }
    const openSlot = slots.slice(0, req).findIndex((s) => !s);
    if (openSlot === -1) return { claimed: false, reason: 'full' };
    const normalized = device.type === 'gamepad'
      ? { type: 'gamepad', index: device.index }
      : { type: device.type };
    slots[openSlot] = normalized;
    notice = '';
    onClaim(normalized, openSlot, state());
    emitChange();
    return { claimed: true, slot: openSlot, device: normalized };
  }

  function clearSlot(index) {
    if (index !== 0 && index !== 1) return;
    if (!slots[index]) return;
    slots[index] = null;
    notice = '';
    emitChange();
  }

  function swapSlots() {
    if (mode !== 'local') return;
    [slots[0], slots[1]] = [slots[1], slots[0]];
    notice = '';
    emitChange();
  }

  function snapshotPads() {
    prevPadButtons.clear();
    const pads = getGamepads() || [];
    for (const pad of pads) {
      if (!pad) continue;
      prevPadButtons.set(pad.index, {
        a: Boolean(pad.buttons?.[0]?.pressed),
        start: Boolean(pad.buttons?.[9]?.pressed),
      });
    }
  }

  function pollGamepads() {
    const pads = getGamepads() || [];
    const seen = new Set();
    let disconnected = false;
    for (const pad of pads) {
      if (!pad) continue;
      seen.add(pad.index);
      const a = Boolean(pad.buttons?.[0]?.pressed);
      const start = Boolean(pad.buttons?.[9]?.pressed);
      const prev = prevPadButtons.get(pad.index) ?? { a: false, start: false };
      prevPadButtons.set(pad.index, { a, start });
      if ((a && !prev.a) || (start && !prev.start)) {
        const res = claim({ type: 'gamepad', index: pad.index });
        if (res.alreadyReady) onContinue(state());
      }
    }
    // Remove disconnected pads from previous-button cache and release their slot if still on claim screen.
    for (const idx of [...prevPadButtons.keys()]) {
      if (!seen.has(idx)) prevPadButtons.delete(idx);
    }
    for (let i = 0; i < requiredCount(); i++) {
      const s = slots[i];
      if (s?.type === 'gamepad' && !seen.has(s.index)) {
        slots[i] = null;
        notice = `Controller ${s.index + 1} disconnected. Claim Player ${i + 1} again.`;
        disconnected = true;
      }
    }
    if (disconnected) emitChange();
  }

  function tick() {
    if (!active) return;
    pollGamepads();
    rafId = requestAnimationFrame(tick);
  }

  function activate() {
    if (active) return;
    active = true;
    notice = '';
    snapshotPads();
    emitChange();
    if (typeof requestAnimationFrame === 'function') rafId = requestAnimationFrame(tick);
  }

  function deactivate() {
    active = false;
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  return {
    activate,
    deactivate,
    setMode,
    claim,
    clearSlot,
    swapSlots,
    pollGamepads,
    state,
    devices,
    ready,
  };
}
