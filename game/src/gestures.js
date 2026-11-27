// Switch distinguishes a tap from a hold. Two sprint taps must come from the same device.
export function createButtonGestures(emit) {
  let switchAt = null, pressCalled = false, lastTap = -Infinity;
  function poll() {
    if (switchAt !== null && !pressCalled && performance.now() - switchAt >= 300) {
      pressCalled = true;
      emit('pressPressed');
    }
  }
  return {
    poll,
    beginSwitch() {
      switchAt = performance.now();
      pressCalled = false;
    },
    endSwitch(cancelled = false) {
      if (switchAt === null) return;
      if (!cancelled) {
        poll();
        if (!pressCalled) emit('switchPressed');
      }
      switchAt = null;
    },
    sprintTap() {
      const now = performance.now();
      if (now - lastTap <= 280) {
        emit('knockOnPressed');
        lastTap = -Infinity;
      } else {
        lastTap = now;
      }
    },
    reset() {
      switchAt = null;
      lastTap = -Infinity;
    },
  };
}
