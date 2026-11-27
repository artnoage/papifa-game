import { createButtonGestures } from './gestures.js';

export function createTouchControls(root) {
  if (!navigator.maxTouchPoints) return null;

  const stick = root.querySelector('[data-control="move"]');
  const thumb = stick.firstElementChild;
  const shoot = root.querySelector('[data-control="shoot"]');
  const pass = root.querySelector('[data-control="pass"]');
  const pray = root.querySelector('[data-control="pray"]');
  const prayChoices = root.querySelector('#touch-prayer-choices');
  const prayJesus = root.querySelector('[data-prayer-choice="jesus"]');
  const prayMary = root.querySelector('[data-prayer-choice="mary"]');
  const prayGeorge = root.querySelector('[data-prayer-choice="george"]');
  const prayPhanourios = root.querySelector('[data-prayer-choice="phanourios"]');
  const owners = new Map();  // One finger per control. Either thumb can lift first.
  const pending = new Set();
  const gestures = createButtonGestures((edge) => pending.add(edge));
  let x = 0, z = 0, sprint = false;

  function steer(event) {
    const box = stick.getBoundingClientRect();
    const radius = (box.width - thumb.offsetWidth) / 2;
    const dx = event.clientX - (box.left + box.width / 2);
    const dz = event.clientY - (box.top + box.height / 2);
    const distance = Math.hypot(dx, dz);
    if (distance > radius * 0.35) owners.get(stick).centreTap = false;
    const scale = Math.max(radius, distance);
    x = dx / scale;
    z = dz / scale;
    thumb.style.transform = `translate(${x * radius}px, ${z * radius}px)`;
    sprint = distance >= radius * 0.9;
    if (distance < radius * 0.15) { x = 0; z = 0; }
  }

  function letGo(control) {
    owners.delete(control);
    control.classList.remove('held');
    if (control === stick) {
      x = 0; z = 0; sprint = false;
      thumb.style.removeProperty('transform');
    }
  }

  function end(event) {
    const control = event.currentTarget;
    const start = owners.get(control);
    if (start?.id !== event.pointerId) return;
    const up = event.type === 'pointerup';
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    const swipeUp = dy <= -24 && -dy >= Math.abs(dx);
    if (control.dataset.control === 'switch') {
      gestures.endSwitch(!up);
    } else if (up && control === pass) {
      pending.add('passPressed');
      if (swipeUp) pending.add('throughPressed');
      else if (dx >= 24 && dx > Math.abs(dy)) pending.add('oneTwoPressed');
    } else if (up && control === shoot) {
      pending.add('shootReleased');
      if (swipeUp) pending.add('chipReleased');
    } else if (up && control === prayJesus) {
      pending.add('prayerJesus');
    } else if (up && control === prayMary) {
      pending.add('prayerMary');
    } else if (up && control === prayGeorge) {
      pending.add('prayerGeorge');
    } else if (up && control === prayPhanourios) {
      pending.add('prayerPhanourios');
    } else if (up && control === stick && start.centreTap && performance.now() - start.at <= 220) {
      gestures.sprintTap();
    }
    letGo(control);
  }

  for (const control of root.querySelectorAll('[data-control], [data-prayer-choice]')) {
    const action = control.dataset.control ?? control.dataset.prayerChoice;
    control.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || owners.has(control)) return;
      event.preventDefault();
      control.setPointerCapture(event.pointerId);
      owners.set(control, { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now(), centreTap: true });
      control.classList.add('held');
      if (control === stick) steer(event);
      else if (control === shoot) pending.add('shootPressed');
      else if (action === 'switch') gestures.beginSwitch();
    });
    control.addEventListener('pointerup', end);
    control.addEventListener('pointercancel', end);
    control.addEventListener('lostpointercapture', end);
    if (control !== stick) control.addEventListener('click', (event) => {
      // Keyboard and accessibility activation can arrive without a pointer.
      if (event.detail !== 0) return;
      if (control === prayJesus) { pending.add('prayerJesus'); return; }
      if (control === prayMary) { pending.add('prayerMary'); return; }
      if (control === prayGeorge) { pending.add('prayerGeorge'); return; }
      if (control === prayPhanourios) { pending.add('prayerPhanourios'); return; }
      if (control === pray) return;
      pending.add(action + 'Pressed');
      if (control === shoot) pending.add('shootReleased');
    });
  }
  stick.addEventListener('pointermove', (event) => {
    if (owners.get(stick)?.id === event.pointerId) steer(event);
  });
  root.addEventListener('contextmenu', (event) => event.preventDefault());
  document.body.classList.add('touch-enabled');
  root.hidden = false;

  return {
    poll(input) {
      if (x || z) { input.move.x = x; input.move.z = z; }
      input.sprint ||= sprint;
      input.shootHeld ||= owners.has(shoot);
      input.prayerHeld ||= Boolean(pray && owners.has(pray));
      gestures.poll();
      for (const edge of pending) input[edge] = true;
      pending.clear();
    },
    reset() {
      for (const [control, { id }] of owners) {
        letGo(control);
        if (control.hasPointerCapture(id)) control.releasePointerCapture(id);
      }
      gestures.reset();
      pending.clear();
    },
    setPassLabel(label) {
      if (pass.textContent !== label) pass.textContent = label;
    },
    updatePrayer(pr, enabled = true) {
      if (!pray) return;
      const show = Boolean(enabled && pr);
      pray.hidden = !show;
      if (!show) { if (prayChoices) prayChoices.hidden = true; return; }
      const ready = Boolean(pr.ready);
      const canCharge = pr.remaining > 0 && pr.active === null && !ready;
      pray.disabled = !canCharge && !ready;
      pray.classList.toggle('ready', ready);
      pray.classList.toggle('active', pr.active !== null);
      if (prayChoices) {
        prayChoices.hidden = !ready;
        // Jesus uses both prayer slots: his button is off with only one left.
        const jesusBtn = prayChoices.querySelector('[data-prayer-choice="jesus"]');
        if (jesusBtn) jesusBtn.disabled = pr.remaining < 2;
      }
    },
  };
}
