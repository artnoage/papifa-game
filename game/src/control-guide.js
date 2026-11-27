const byId = id => document.getElementById(id);

export function defaultControlDevice() {
  return { type: navigator.maxTouchPoints && matchMedia('(pointer: coarse)').matches ? 'touch' : 'keyboard' };
}

export function showControlDevice(device) {
  byId('controls-page').dataset.guide = device.type;
  byId('move-help').dataset.guide = device.type;
  document.body.classList.toggle('touch-enabled', device.type === 'touch');
}

export function createMatchGuide(owners) {
  showControlDevice(owners[0].device);
  const select = byId('guide-owner').querySelector('select');
  if (owners.length > 1 && owners[0].device.type !== owners[1].device.type) {
    for (const { team, device } of owners) {
      const label = device.type === 'keyboard' ? 'Keyboard & mouse' : 'Controller';
      select.add(new Option('P' + (team + 1) + ' · ' + label, device.type));
    }
    byId('guide-owner').hidden = false;
    select.addEventListener('change', () => { byId('move-help').dataset.guide = select.value; });
  }

  const help = byId('help'), first = help.firstElementChild;
  const lines = owners.map(({ device, team }, i) => {
    const row = i ? first.cloneNode(true) : first;
    if (i) {
      for (const el of row.querySelectorAll('[id]')) el.removeAttribute('id');
      help.append(row);
    }
    row.dataset.guide = device.type;
    row.querySelector('[data-player]').textContent = owners.length > 1 ? 'P' + (team + 1) + ' · ' : '';
    return { type: device.type, team, hints: [...row.querySelectorAll('[data-hint]')], current: null };
  });
  const skip = { keyboard: 'Space', gamepad: 'A', touch: 'Tap Skip' };
  const buttons = [...new Set(owners.map(({ device }) => skip[device.type]))];
  byId('replay-hint').textContent = buttons[0] === 'Tap Skip' ? buttons[0] : buttons.join(' / ') + ' to skip';
  return (match, inputs) => {
    for (const line of lines) {
      if (line.type === 'touch') continue;
      const human = match.humans?.[line.team] ?? match.human;
      const attacking = !!human && match.ball.owner === human, keeper = attacking && human.isGK;
      const aiming = inputs[line.team]?.aim;
      let hint;
      if (line.type === 'gamepad') hint = keeper ? 'padKeeper' : 'pad';
      else if (keeper) hint = aiming ? 'keeperAim' : 'keeperKeys';
      else if (aiming) hint = attacking ? 'attack' : 'defend';
      else hint = 'keys';
      if (line.current === hint) continue;
      line.current = hint;
      for (const el of line.hints) el.hidden = el.dataset.hint !== hint;
    }
  };
}
