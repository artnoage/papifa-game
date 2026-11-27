import { TEAMS } from './config.js';

export function resultRows(match) {
  const teams = match.stats;
  const total = teams[0].possession + teams[1].possession;
  const homePercent = total ? Math.round(100 * teams[0].possession / total) : 0;
  return [
    ['Goals', match.score],
    ['Shots (on target)', teams.map(s => `${s.shots} (${s.onTarget})`)],
    ['Possession', total ? [`${homePercent}%`, `${100 - homePercent}%`] : ['—', '—']],
    ['Passes completed / attempted', teams.map(s => `${s.completed} / ${s.passes}`)],
    ['Through balls', teams.map(s => s.through)],
    ['Tackles won', teams.map(s => s.tackles)],
    ['Saves', teams.map(s => s.saves)],
  ];
}

export function showResults(card, match, teams = TEAMS) {
  const headers = card.querySelectorAll('thead th[scope=col]');
  teams.forEach((team, index) => { headers[index].textContent = team.name; });
  const rows = resultRows(match).map(([name, values]) => {
    const row = document.createElement('tr');
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = name;
    row.insertCell().textContent = values[0];
    row.append(label);
    row.insertCell().textContent = values[1];
    return row;
  });
  card.querySelector('tbody').replaceChildren(...rows);
  card.hidden = false;
  card.querySelector('#rematch-button').focus({ preventScroll: true });
}
