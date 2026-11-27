import { ROSTER, SQUADS, TEAMS, resolveLevel, teamsForKit } from './config.js';
import { narrationVolume, setNarrationVolume, setSoundEnabled, soundEnabled, startAudio } from './audio.js';
import { narrationLang, narrationLangLabel, setNarrationLang } from './narration.js';
import { readPreference, savePreference } from './preferences.js';
import { FIELDS, matchSetup } from './fields.js';
import { defaultControlDevice, showControlDevice } from './control-guide.js';
import { createDeviceClaim, deviceLabel, isTouchOnlyDevice } from './device-claim.js';
import { createRoomLobby } from './online-room.js';

const $ = id => document.getElementById(id);
const front = $('front');
const params = new URLSearchParams(location.search);
const onlineEnabled = params.get('net') !== '0';
for (const option of $('play-mode').querySelectorAll('[data-online-mode]')) {
  option.hidden = !onlineEnabled;
  option.querySelector('input').disabled = !onlineEnabled;
}
let level = params.has('level')
  ? resolveLevel(params.get('level'), 'normal')
  : resolveLevel(readPreference('level.v1'), 'normal');
let team = teamsForKit(params.get('kit'))[0];
const setup = matchSetup(params);
let titlePreview;
let starting = false;
let teamsPadRaf = 0;
let tutorialPadRaf = 0;
// Papifa is made for a gamepad: say so before the match (not on phones and tablets, where touch is the only way).
const touchOnly = isTouchOnlyDevice();
for (const el of document.querySelectorAll('[data-pad-advice]')) el.hidden = touchOnly;
$('menu-tutorial').hidden = touchOnly;
const PAD_ADVICE = $('claim-pad-advice').textContent;

function setParam(name, value) {
  const url = new URL(location.href);
  if (url.searchParams.get(name) === value) return;
  url.searchParams.set(name, value);
  history.replaceState(history.state, '', url);
}

// ---------- "Who's playing?" device claim ----------
function promptForSlot(st, slotIndex) {
  if (st.slots[slotIndex]) {
    if (st.mode === 'join') return 'Ready to paste the host’s invite.';
    if (st.mode === 'host') return 'Ready to choose your kit and pitch.';
    if (st.mode === 'ai') return st.touchOnly ? 'Ready. Choose teams to kick off.' : 'Ready. Choose teams or switch to Local 2P.';
    return st.ready ? 'Ready for kick-off.' : 'Waiting for the other player to claim.';
  }
  if (st.touchOnly) return 'Tap here to play.';
  if (st.mode === 'ai') {
    const hasTouch = (navigator.maxTouchPoints || 0) > 0;
    return hasTouch
      ? 'Click here, tap, or press Space · Press A or Start on a controller.'
      : 'Click here or press Space · Press A or Start on a controller.';
  }
  const other = st.slots[slotIndex === 0 ? 1 : 0];
  if (other?.type === 'keyboard') return 'Press A or Start on a controller.';
  if (other?.type === 'gamepad') return 'Click here or press Space · or press A / Start on a second controller.';
  return 'Click here or press Space · or press A / Start on a controller.';
}

function renderClaimState(st) {
  const page = $('players-page');
  if (!page) return;
  page.dataset.mode = st.mode;
  const localOption = $('local-mode-option');
  if (localOption) localOption.hidden = st.touchOnly;
  const modeInput = $('play-mode')?.querySelector(`input[value="${st.mode}"]`);
  if (modeInput) modeInput.checked = true;

  const hint = $('claim-hint');
  if (hint) {
    if (st.mode === 'host' || st.mode === 'join') hint.textContent = 'Claim the device you’ll use for this online match.';
    else if (st.touchOnly) hint.textContent = 'Tap to claim Player 1, then pick your kit.';
    else if (st.mode === 'local') hint.textContent = 'Two devices needed: two controllers, or keyboard + mouse and a controller.';
    else hint.textContent = 'First device to claim plays as Player 1. Switch to Local 2P for two players.';
  }

  for (let i = 0; i < 2; i++) {
    const card = $('claim-slot-' + i);
    if (!card) continue;
    card.hidden = i === 1 && st.mode !== 'local';
    if (i === 0) {
      card.querySelector('h2').textContent = st.mode === 'join' ? 'Guest' : 'Player 1';
      card.querySelector('.claim-slot-role').textContent = st.mode === 'join' ? 'Team 2' : 'Team 1';
    }
    const dev = st.slots[i];
    card.dataset.state = dev ? 'claimed' : 'waiting';
    card.querySelector('[data-slot-device]').textContent = dev ? deviceLabel(dev) : 'Waiting for device…';
    card.querySelector('[data-slot-prompt]').textContent = promptForSlot(st, i);
    card.querySelector('[data-clear-slot]').hidden = !dev;
  }

  const advice = $('claim-pad-advice');
  const keyboardClaimed = st.slots.some(d => d?.type === 'keyboard');
  advice.classList.toggle('strong', keyboardClaimed);
  advice.textContent = keyboardClaimed
    ? '🎮 Keyboard and mouse work, but Papifa plays much better with a gamepad. Plug one in and press A on it.'
    : PAD_ADVICE;

  const swapBtn = $('claim-swap');
  if (swapBtn) swapBtn.hidden = st.mode !== 'local' || (!st.slots[0] && !st.slots[1]);
  const notice = $('claim-notice');
  if (notice) notice.textContent = st.notice;
  const cont = $('claim-continue');
  if (cont) cont.disabled = !st.ready;
  $('claim-next').textContent = st.mode === 'join' ? 'Paste invite' : 'Choose teams';
}

const claim = createDeviceClaim({
  touchOnly: isTouchOnlyDevice(),
  onClaim(device) {
    showControlDevice(device);
  },
  onChange: renderClaimState,
  onContinue() {
    if (front.dataset.page === 'players' && !starting) afterClaim();
  },
});

// Online matches are 2-human (CPU level is unused); invite codes pack all 5 difficulty levels cleanly.
const room = createRoomLobby(() => ({ ...setup, kit: team.id, level }), async (settings, online, current) => {
  const [{ startGame }, buildVenue] = await Promise.all([import('./main.js'), FIELDS[settings.field].load()]);
  if (!current()) return;
  front.hidden = true;
  $('match-shell').hidden = false;
  try {
    startGame({ ...settings, devices: claim.devices(), online }, buildVenue);
    $('match-shell').focus({ preventScroll: true });
  } catch (error) {
    front.hidden = false;
    $('match-shell').hidden = true;
    throw error;
  }
});

function openRoom(mode) {
  room.open(mode);
  showPage('room');
}
function afterClaim() {
  if (claim.state().mode === 'join') openRoom('join');
  else showPage('teams');
}

function stopTeamsPadPoll() {
  if (teamsPadRaf) cancelAnimationFrame(teamsPadRaf);
  teamsPadRaf = 0;
}

function startTeamsPadPoll() {
  stopTeamsPadPoll();
  const st = claim.state();
  const padIndices = st.devices.filter(d => d?.type === 'gamepad').map(d => d.index);
  if (!padIndices.length) return;
  const prev = new Map();
  const readButtons = (pad) => ({
    a: Boolean(pad?.buttons?.[0]?.pressed),
    start: Boolean(pad?.buttons?.[9]?.pressed),
    left: Boolean(pad?.buttons?.[14]?.pressed),
    right: Boolean(pad?.buttons?.[15]?.pressed),
  });
  for (const idx of padIndices) prev.set(idx, readButtons(navigator.getGamepads?.()[idx]));

  const tick = () => {
    if (front.dataset.page !== 'teams' || front.hidden) { stopTeamsPadPoll(); return; }
    const pads = navigator.getGamepads?.() ?? [];
    for (const idx of padIndices) {
      const cur = readButtons(pads[idx]);
      const old = prev.get(idx) ?? { a: false, start: false, left: false, right: false };
      prev.set(idx, cur);
      if ((cur.left && !old.left) || (cur.right && !old.right)) {
        const nextKit = team.id === 'gold' ? 'blue' : 'gold';
        team = teamsForKit(nextKit)[0];
        setParam('kit', team.id);
        showTeam();
      }
      if ((cur.a && !old.a) || (cur.start && !old.start)) {
        kickOff();
        return;
      }
    }
    teamsPadRaf = requestAnimationFrame(tick);
  };
  teamsPadRaf = requestAnimationFrame(tick);
}

function showTeam() {
  const st = claim.state();
  const isLocal = st.mode === 'local';
  const choice = $('kit-options');
  const pair = teamsForKit(team.id);
  const heading = $('team-title');
  const hint = $('teams-page')?.querySelector('.selection-hint');
  if (heading) heading.textContent = isLocal ? 'Choose kits' : 'Choose your team';
  if (hint) {
    hint.textContent = isLocal
      ? 'Pick Player 1’s kit. Player 2 wears the other.'
      : st.mode === 'host' ? 'Pick your kit. Your guest wears the other.' : 'Pick your kit. The CPU wears the other.';
  }
  const p1Badge = isLocal ? `P1 · ${deviceLabel(st.devices[0])}` : 'You';
  const p2Badge = isLocal ? `P2 · ${deviceLabel(st.devices[1])}` : st.mode === 'host' ? 'Guest' : 'CPU';
  $('kickoff-label').textContent = st.mode === 'host' ? 'Create invite' : 'Kick off';
  for (const input of choice.querySelectorAll('input')) {
    input.checked = input.value === team.id;
    input.closest('label').querySelector('small').textContent = input.checked ? p1Badge : p2Badge;
  }
  $('selected-kit').textContent = isLocal
    ? `P1 ${pair[0].name} vs P2 ${pair[1].name}`
    : 'Playing as ' + team.name;
}

function buildLineup() {
  if ($('lineup').childElementCount) return;
  for (const kit of TEAMS) {
    const squad = new Image(900, 420);
    squad.className = 'squad-shot';
    squad.loading = 'lazy';
    squad.alt = 'All five priests in the ' + kit.name + ' kit';
    squad.src = 'assets/ui/lineup_' + kit.kit + '.webp';
    const trio = document.createElement('span');
    trio.className = 'squad-trio';
    for (const slot of SQUADS[3]) {
      const img = new Image(360, 480);
      img.loading = 'lazy';
      img.src = 'assets/ui/' + ROSTER[slot].id + '_' + kit.kit + '.webp';
      img.alt = ROSTER[slot].name + ' in ' + kit.name;
      trio.append(img);
    }
    $('kit-options').querySelector('input[value="' + kit.id + '"]').parentElement.append(squad, trio);
  }
  for (const p of ROSTER) {
    const item = document.createElement('li');
    const pair = document.createElement('div');
    pair.className = 'kit-pair';
    for (const kit of TEAMS) {
      const img = new Image(360, 480);
      img.loading = 'lazy';
      img.src = 'assets/ui/' + p.id + '_' + kit.kit + '.webp';
      img.alt = p.name + ' in ' + kit.name;
      pair.append(img);
    }
    const label = document.createElement('div');
    label.className = 'priest-label';
    const name = document.createElement('strong'), role = document.createElement('small');
    name.textContent = p.name;
    role.textContent = p.role;
    label.append(name, role);
    item.append(pair, label);
    $('lineup').append(item);
  }
}

function showLineup() {
  const lineup = $('lineup');
  $('teams-page').dataset.size = String(setup.size);
  lineup.setAttribute('aria-label', setup.size + ' starters in both kits');
  for (const [slot, item] of [...lineup.children].entries()) item.hidden = !SQUADS[setup.size].includes(slot);
}

function goBack() {
  if (starting) return;
  if (front.dataset.page === 'room') {
    room.leave();
    showPage(claim.state().mode === 'host' ? 'teams' : 'players');
  } else if (front.dataset.page === 'teams') showPage('players');
  else showPage('title');
}

// ---------- Gamepad tutorial ----------
function stopTutorialPadPoll() {
  if (tutorialPadRaf) cancelAnimationFrame(tutorialPadRaf);
  tutorialPadRaf = 0;
}
function startTutorialPadPoll() {
  stopTutorialPadPoll();
  const held = new Set();                              // a button already down when the page opened must be released first
  const pressedA = pad => Boolean(pad?.buttons?.[0]?.pressed);
  for (const pad of navigator.getGamepads?.() ?? []) if (pad && pressedA(pad)) held.add(pad.index);
  let seen = false;
  const tick = () => {
    if (front.dataset.page !== 'tutorial' || front.hidden || starting) { stopTutorialPadPoll(); return; }
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean);
    if (pads.length && !seen) { seen = true; $('tutorial-status').innerHTML = `${pads[0].id ? 'Controller found. ' : ''}Press <b>A</b> to start.`; }
    for (const pad of pads) {
      if (!pressedA(pad)) { held.delete(pad.index); continue; }
      if (held.has(pad.index)) continue;
      startTutorial(pad.index);
      return;
    }
    tutorialPadRaf = requestAnimationFrame(tick);
  };
  tutorialPadRaf = requestAnimationFrame(tick);
}
async function startTutorial(padIndex) {
  if (starting) return;
  starting = true;
  stopTutorialPadPoll();
  startAudio();
  $('tutorial-status').textContent = 'Loading pitch…';
  $('tutorial-error').textContent = '';
  try {
    const [{ startGame }, buildVenue] = await Promise.all([import('./main.js'), FIELDS.courtyard.load()]);
    front.hidden = true;
    $('match-shell').hidden = false;
    startGame({ size: 5, field: 'courtyard', kit: team.id, level: 'normal', devices: [{ type: 'gamepad', index: padIndex }, null], tutorial: true }, buildVenue);
    $('match-shell').focus({ preventScroll: true });
  } catch {
    front.hidden = false;
    $('match-shell').hidden = true;
    $('tutorial-error').textContent = 'The pitch could not load. Check your connection and reload to try again.';
  } finally {
    starting = false;
  }
}

function showPage(page, focus = true) {
  titlePreview?.abort();
  titlePreview = null;
  if (page !== 'players') claim.deactivate();
  if (page !== 'teams') stopTeamsPadPoll();
  if (page !== 'tutorial') stopTutorialPadPoll();
  front.dataset.page = page;
  for (const section of front.querySelectorAll('.front-page')) section.hidden = section.id !== page + '-page';
  $('menu-back').hidden = page === 'title';
  if (page === 'players') claim.activate();
  if (page === 'teams') { buildLineup(); showLineup(); showTeam(); startTeamsPadPoll(); }
  if (page === 'tutorial') startTutorialPadPoll();
  front.scrollTop = 0;
  if (focus) $(page + '-page').querySelector('h1').focus({ preventScroll: true });
  if (page === 'title' && !navigator.maxTouchPoints && matchMedia('(min-width: 701px) and (prefers-reduced-motion: no-preference)').matches) {
    titlePreview = new AbortController();
    const { signal } = titlePreview;
    import('./title-preview.js').then(({ showPriest }) => {
      if (!signal.aborted) return showPriest(document.querySelector('.portrait-model'), signal);
    }).catch(() => { /* The roster poster is already visible when WebGL is unavailable. */ });
  }
}

function showSound() {
  const on = soundEnabled();
  $('menu-sound').setAttribute('aria-pressed', String(on));
  $('sound-state').textContent = on ? 'On' : 'Off';
}

function showNarration() {
  const lang = narrationLang();
  const radio = $('menu-narration-lang')?.querySelector(`input[value="${lang}"]`);
  if (radio) radio.checked = true;
  if ($('narration-state')) $('narration-state').textContent = narrationLangLabel(lang);
  const pct = Math.round(narrationVolume() * 100);
  if ($('menu-narration-vol')) $('menu-narration-vol').value = String(pct);
  if ($('menu-narration-vol-value')) $('menu-narration-vol-value').textContent = `${pct}%`;
}

function showLevel() {
  const option = $('menu-levels').querySelector('input[value="' + level + '"]');
  option.checked = true;
  $('menu-level').textContent = option.parentElement.textContent.trim();
}

async function kickOff() {
  if (starting) return;
  if (claim.state().mode === 'host') { startAudio(); openRoom('host'); return; }
  starting = true;
  stopTeamsPadPoll();
  startAudio();  // The kickoff gesture unlocks audio before loading the venue.
  $('kick-off').disabled = true;
  $('kit-options').disabled = true;
  $('match-size').disabled = $('match-field').disabled = true;
  $('kickoff-label').textContent = 'Loading pitch…';
  $('kickoff-error').textContent = '';
  front.setAttribute('aria-busy', 'true');
  // Keep the plain game URL for default matches and normalize incoming aliases.
  if (params.has('kit')) setParam('kit', team.id);
  if (params.has('level')) setParam('level', level);
  if (params.has('size')) setParam('size', String(setup.size));
  if (params.has('field')) setParam('field', setup.field);
  const st = claim.state();
  const devices = st.ready ? st.devices : [defaultControlDevice(), null];
  try {
    const [{ startGame }, buildVenue] = await Promise.all([import('./main.js'), FIELDS[setup.field].load()]);
    front.hidden = true;
    $('match-shell').hidden = false;
    startGame({ ...setup, mode: st.mode, devices, level }, buildVenue);
    $('match-shell').focus({ preventScroll: true });
  } catch {
    front.hidden = false;
    $('match-shell').hidden = true;
    $('kickoff-error').textContent = 'The pitch could not load. Check your connection and reload to try again.';
  } finally {
    starting = false;
    $('kick-off').disabled = false;
    $('kit-options').disabled = false;
    $('match-size').disabled = $('match-field').disabled = false;
    $('kickoff-label').textContent = 'Kick off';
    front.removeAttribute('aria-busy');
  }
}

showControlDevice(defaultControlDevice());
$('front-moves').append($('move-help').querySelector('dl').cloneNode(true));
$('new-game').addEventListener('click', () => showPage('players'));
for (const button of front.querySelectorAll('button[data-page]')) {
  button.addEventListener('click', () => showPage(button.dataset.page));
}
$('menu-back').addEventListener('click', goBack);
front.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('menu-back').hidden && !starting) { e.preventDefault(); goBack(); }
});

// Claim screen interactions
$('play-mode')?.addEventListener('change', e => {
  claim.setMode(e.target.value);
});
$('players-page')?.addEventListener('pointerdown', e => {
  if (front.dataset.page !== 'players' || front.hidden) return;
  if (e.target.closest('button, input, label, select, a')) return;
  if (e.pointerType === 'touch') {
    claim.claim({ type: 'touch' });
  } else if (e.pointerType === 'mouse' && e.button === 0) {
    claim.claim({ type: 'keyboard' });
  }
});
$('players-page')?.addEventListener('click', e => {
  const clearBtn = e.target.closest('[data-clear-slot]');
  if (clearBtn) {
    claim.clearSlot(Number(clearBtn.dataset.clearSlot));
    return;
  }
});
$('claim-swap')?.addEventListener('click', () => claim.swapSlots());
$('claim-continue')?.addEventListener('click', () => {
  if (claim.ready()) afterClaim();
});
addEventListener('keydown', e => {
  if (front.hidden || front.dataset.page !== 'players' || starting) return;
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  const onButton = Boolean(e.target?.closest?.('button, select, a'));
  if (e.code === 'Space' && !onButton) {
    e.preventDefault();
    claim.claim({ type: 'keyboard' });
  } else if (e.code === 'Enter' && claim.ready() && !onButton) {
    e.preventDefault();
    afterClaim();
  }
});

$('menu-sound').addEventListener('click', () => { setSoundEnabled(!soundEnabled()); showSound(); });
$('menu-narration-lang')?.addEventListener('change', e => {
  setNarrationLang(e.target.value);
  showNarration();
});
$('menu-narration-vol')?.addEventListener('input', e => {
  setNarrationVolume(Number(e.target.value) / 100);
  showNarration();
});
$('menu-levels').addEventListener('change', e => {
  level = resolveLevel(e.target.value, 'normal');
  savePreference('level.v1', level);
  setParam('level', level);
  showLevel();
});
$('kit-options').addEventListener('change', e => { team = teamsForKit(e.target.value)[0]; setParam('kit', team.id); showTeam(); });
for (const [id, field] of Object.entries(FIELDS)) $('match-field').add(new Option(field.name, id));
$('match-field').value = setup.field;
$('match-size').querySelector('input[value="' + setup.size + '"]').checked = true;
$('match-field').addEventListener('change', e => { setup.field = e.target.value; setParam('field', setup.field); });
$('match-size').addEventListener('change', e => {
  setup.size = Number(e.target.value);
  setParam('size', e.target.value);
  showLineup();
});
$('kick-off').addEventListener('click', kickOff);
showSound();
showNarration();
showLevel();
showPage('title', false);
// Buttons are wired from here on (the title page is already visible in the HTML).
front.dataset.ready = 'true';
