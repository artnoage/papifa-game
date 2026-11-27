export function teamStats() {
  return { shots: 0, onTarget: 0, passes: 0, completed: 0, through: 0, tackles: 0, saves: 0, possession: 0 };
}

// Count the resolved actions that reach the HUD and audio, including between video frames.
export function recordEvent(m, event) {
  m.events.push(event);
  if (m.phase === 'over') return;
  const team = m.stats[event.team];
  switch (event.type) {
    case 'kick':
      team.shots++;
      break;
    case 'pass':
      if (event.kind !== 'clear') team.passes++;
      if (event.kind === 'through') team.through++;
      break;
    case 'receive':
      team.completed++;
      break;
    case 'steal':
      team.tackles++;
      break;
    case 'catch':
    case 'parry':
      team.saves++;
      m.stats[1 - event.team].onTarget++;
      break;
    case 'goal':
      if (event.fromShot) team.onTarget++;
      break;
  }
}
