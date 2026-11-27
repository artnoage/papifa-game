// Two-player aware match HUD updates (scoreboard controlled names, per-team power bars, move signal).

export function createMatchHud(root) {
  const $ = (id) => root.querySelector('#' + id);
  const s0 = $('s0'), s1 = $('s1'), clock = $('clock');
  const controlled0 = $('controlled');
  let controlled1 = $('controlled-1');
  const power0 = $('power'), fill0 = $('powerfill');
  let power1 = $('power-1'), fill1 = $('powerfill-1');
  const signal = $('move-signal');

  // Create team-1 HUD slots lazily if the host HTML does not include them yet.
  if (!controlled1 && controlled0?.parentElement) {
    controlled1 = document.createElement('div');
    controlled1.id = 'controlled-1';
    controlled1.hidden = true;
    controlled0.insertAdjacentElement('afterend', controlled1);
  }
  if (!power1 && power0?.parentElement) {
    power1 = document.createElement('div');
    power1.id = 'power-1';
    power1.className = 'power-meter';
    power1.dataset.team = '1';
    fill1 = document.createElement('div');
    fill1.id = 'powerfill-1';
    fill1.className = 'power-fill';
    power1.append(fill1);
    power0.insertAdjacentElement('afterend', power1);
  }
  if (power0) {
    power0.classList.add('power-meter');
    power0.dataset.team = '0';
  }
  if (fill0) fill0.classList.add('power-fill');

  function humansOf(match) {
    if (Array.isArray(match.humans)) return [match.humans[0] ?? null, match.humans[1] ?? null];
    return [match.human ?? null, null];
  }

  function chargesOf(match) {
    if (Array.isArray(match.charges) && Array.isArray(match.chargings)) {
      return [
        { active: Boolean(match.chargings[0]), value: match.charges[0] ?? 0 },
        { active: Boolean(match.chargings[1]), value: match.charges[1] ?? 0 },
      ];
    }
    return [
      { active: Boolean(match.charging), value: match.charge ?? 0 },
      { active: false, value: 0 },
    ];
  }

  function update(match) {
    const humans = humansOf(match);
    const twoHumans = Boolean(humans[0] && humans[1]);
    root.dataset.humans = twoHumans ? '2' : '1';
    if (s0) s0.textContent = match.score[0];
    if (s1) s1.textContent = match.score[1];
    if (clock) {
      const c = Math.ceil(match.clock);
      clock.textContent = `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}`;
    }
    if (controlled0) {
      const name0 = humans[0]?.info.name ?? '';
      controlled0.textContent = twoHumans && name0 ? `P1 · ${name0}` : name0;
      controlled0.hidden = !name0;
    }
    if (controlled1) {
      const name1 = humans[1]?.info.name ?? '';
      controlled1.textContent = name1 ? `P2 · ${name1}` : '';
      controlled1.hidden = !name1;
    }
    const charges = chargesOf(match);
    if (power0 && fill0) {
      power0.style.visibility = charges[0].active ? 'visible' : 'hidden';
      fill0.style.width = `${Math.round(charges[0].value * 100)}%`;
    }
    if (power1 && fill1) {
      power1.hidden = !twoHumans;
      power1.style.visibility = twoHumans && charges[1].active ? 'visible' : 'hidden';
      fill1.style.width = `${Math.round(charges[1].value * 100)}%`;
    }
  }

  function showMove(symbol, name, team = 0) {
    if (!signal) return;
    signal.firstElementChild.textContent = symbol;
    signal.lastElementChild.textContent = name;
    signal.style.color = `var(--team-${team}, #ffe198)`;
  }

  return { update, showMove };
}
