import { choosePrayer, createMatch, setDifficulty, step } from './sim.js';
import { createRenderer } from './render.js';
import { createInput } from './input.js';
import { createMatchGuide, defaultControlDevice } from './control-guide.js';
import { createMatchHud } from './match-hud.js';
import { createPrayerHud } from './prayer-hud.js';
import { createPrayerApparition } from './prayer-apparition.js';
import { createCameoOverlay } from './cameo.js';
import { createTouchControls } from './touch.js';
import { resolveLevel, teamsForKit } from './config.js';
import { readPreference, savePreference } from './preferences.js';
import { initAudio, narrationVolume, playEvents, setNarrationVolume } from './audio.js';
import { createMatchNarration, narrationLang, setNarrationLang } from './narration.js';
import { showResults } from './results.js';
import { FIELDS } from './fields.js';
import { MATCH } from './config.js';
import { createTutorialRunner } from './tutorial.js';
import { createTutorialUi } from './tutorial-ui.js';

const $ = (id) => document.getElementById(id);

export function startGame({ size = 5, field = 'courtyard', devices = [defaultControlDevice()], online = null, kit, level, tutorial = false } = {}, buildVenue) {
  const params = new URLSearchParams(location.search);
  const netDebug = params.getAll('net').some(v => v.split(',').includes('debug'));
  // ?cameo=always shows the goal/catch cameo on every trigger instead of 1 in 5 (for trying it out).
  if (params.get('cameo') === 'always') window.__papifaCameoForceProb = 1;
  // ?prayer=george (or jesus / mary / phanourios / ready) starts a match with a prayer ready or active at kick-off.
  const prayerSwitch = params.get('prayer')?.toLowerCase() ?? null;
  const applyPrayerSwitch = (m) => {
    if (guest || !m?.prayersEnabled || !prayerSwitch) return;
    const pr = m.prayers[0];
    if (!pr) return;
    if (prayerSwitch === 'ready') {
      pr.ready = true; pr.charge = 1;
    } else if (['jesus', 'mary', 'george', 'phanourios'].includes(prayerSwitch)) {
      pr.ready = true; pr.charge = 1;
      choosePrayer(m, 0, prayerSwitch);
      pr.remaining = 2; // keep full match allowance for repeat testing
    }
  };
  const guest = online?.role === 'guest';
  const localDevices = guest ? [null, devices.find(Boolean)] : devices;
  const teams = teamsForKit(kit ?? params.get('kit'));
  teams.forEach((team, i) => {
    $('name' + i).textContent = team.name;
    $('match-shell').style.setProperty('--team-' + i, '#' + team.ring.toString(16).padStart(6, '0'));
  });
  const newMatch = level => {
    const m = createMatch(undefined, { level, size, field, humans: online ? [true, true] : devices.map(Boolean) });
    applyPrayerSwitch(m);
    return m;
  };
  const initialLevel = level !== undefined
    ? resolveLevel(level, 'normal')
    : params.has('level')
      ? resolveLevel(params.get('level'), 'normal')
      : resolveLevel(readPreference('level.v1'), 'normal');
  let match = newMatch(initialLevel);
  const view = createRenderer($('match-shell'), teams, { buildVenue, touchTeam: guest ? 1 : 0 });
  const hud = createMatchHud($('match-shell'));
  const prayerHud = createPrayerHud($('match-shell'), localDevices);
  const prayerApparition = createPrayerApparition($('match-shell'));
  const cameo = createCameoOverlay($('match-shell'), { isGuest: guest });
  view.setPostRender((renderer, rdt) => cameo.renderOn(renderer, rdt, view.opening() || match.phase === 'over'));
  const narration = createMatchNarration({
    teams,
    localTeam: guest ? 1 : 0,
    isLocal2P: !online && devices.filter(Boolean).length >= 2,
  });
  const hasDevice = type => devices.some(device => device?.type === type);
  const touch = hasDevice('touch') ? createTouchControls($('touch-controls')) : null;
  const help = $('move-help');
  const pauseMenu = $('pause-menu'), pauseButton = $('pause-button');
  const results = $('results-card');
  const liveMatch = () => match.phase === 'play' && !pauseMenu.open && !help.open && !view.opening() && !view.replaying() ? match : null;
  const owners = localDevices.flatMap((device, team) => device ? [{
    device, team, control: createInput(device, { touch, pitchTarget: view.pitchTarget, liveMatch, team }),
  }] : []);
  const keyboardOwner = owners.find(({ device }) => device.type === 'keyboard');
  if (keyboardOwner) view.pitchTarget.setColor(teams[keyboardOwner.team].ring);
  const updateControlHint = createMatchGuide(owners);
  // Gamepad tutorial: scripted demos, then the player's turn, one control at a time (clock frozen, no cameos or narration).
  $('match-shell').classList.toggle('tutorial', !!tutorial);
  $('quit-tutorial').hidden = !tutorial;
  const tutorialUi = tutorial ? createTutorialUi($('match-shell'), { padIndex: devices[0]?.index ?? 0 }) : null;
  const tutor = tutorial ? createTutorialRunner() : null;
  const leaveTutorial = () => location.reload();
  tutorialUi?.onMenu(leaveTutorial);
  $('quit-tutorial').addEventListener('click', leaveTutorial);
  let tutorInput = null;
  const resetInputs = () => owners.forEach(({ control }) => control.reset());
  function clearActions() {
    owners.forEach(({ control }) => control.clearActions());
    online?.clearRemoteActions();
  }
  function clearCharge() {
    match.chargings.fill(false);
    match.charges.fill(0);
  }
  const levels = [...$('difficulty').querySelectorAll('input')];
  levels.find(option => option.value === match.level).checked = true;
  const syncPauseNarration = () => {
    const lang = narrationLang();
    const r = $('pause-narration-lang')?.querySelector(`input[value="${lang}"]`);
    if (r) r.checked = true;
    const pct = Math.round(narrationVolume() * 100);
    if ($('pause-narration-vol')) $('pause-narration-vol').value = String(pct);
    if ($('pause-narration-vol-value')) $('pause-narration-vol-value').textContent = `${pct}%`;
  };
  syncPauseNarration();
  $('pause-narration-lang')?.addEventListener('change', event => {
    setNarrationLang(event.target.value);
    syncPauseNarration();
  });
  $('pause-narration-vol')?.addEventListener('input', event => {
    setNarrationVolume(Number(event.target.value) / 100);
    syncPauseNarration();
  });

  function chooseLevel(level) {
    setDifficulty(match, level);
    savePreference('level.v1', match.level);
    levels.find(option => option.value === match.level).checked = true;
    const url = new URL(location.href);
    url.searchParams.set('level', match.level);
    history.replaceState(history.state, '', url);
  }
  function setPaused(open) {
    if (open === pauseMenu.open) return;
    resetInputs();
    clearCharge();
    if (open) {
      help.open = false;
      syncPauseNarration();
      narration.stop();
      cameo.stop();
      const finished = match.phase === 'over';
      $('pause-title').textContent = finished ? 'Match difficulty' : 'Paused';
      $('resume-button').textContent = finished ? 'Back to results' : 'Resume';
      $('pad-pause-hint').textContent = tutorial ? 'A to resume · View to quit the tutorial'
        : finished ? 'D-pad to choose · A to return' : 'D-pad to choose · A to resume';
      tutor?.notePaused();
      $('pad-pause-hint').hidden = !hasDevice('gamepad');
      $('pause-connection').hidden = !online || !netDebug;
      if (online && netDebug) $('pause-connection').textContent = online.transport === 'direct' ? 'Connection: direct (P2P)' : 'Connection: via server';
      pauseMenu.showModal();
    } else {
      pauseMenu.close();
      if (document.activeElement === pauseButton) pauseButton.blur();
    }
  }
  let guestPauseRequest = false;
  pauseButton.addEventListener('click', () => { if (guest) guestPauseRequest = true; else setPaused(true); });
  $('change-level').addEventListener('click', () => setPaused(true));
  $('rematch-button').addEventListener('click', rematch);
  results.addEventListener('keydown', event => {
    if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation();
  });
  pauseButton.addEventListener('keydown', event => {
    if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation();
  });
  $('resume-button').addEventListener('click', () => setPaused(false));
  $('difficulty').addEventListener('change', event => chooseLevel(event.target.value));
  pauseMenu.addEventListener('cancel', event => { event.preventDefault(); setPaused(false); });
  pauseMenu.addEventListener('keydown', event => {
    if (event.code !== 'KeyM') event.stopPropagation();
    if (hasDevice('keyboard') && event.code === 'KeyP' && !event.repeat) { event.preventDefault(); setPaused(false); }
  });
  help.addEventListener('keydown', (event) => {
    if (event.code === 'Escape' && help.open) {
      help.open = false;
      help.querySelector('summary').blur();
      event.stopPropagation();
    }
    if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation();
  });
  initAudio();
  const DT = 1 / 60;
  let acc = 0, last = performance.now(), bannerT = 0;
  let goalAt = null;          // match time of the last goal, until its slow-motion replay has been shown
  let signalT = 0;
  const signal = $('move-signal');
  const intro = $('venue-intro');
  $('venue-name').textContent = FIELDS[field].name;
  if (guest) {
    $('change-level').hidden = true;
    $('rematch-button').hidden = true;
    $('skip-intro').hidden = true;
  }

  function updateScoreboard() {
    hud.update(match);
  }
  function startOpening() {
    updateScoreboard();
    intro.hidden = !view.startOpening(match);
    if (intro.hidden) {
      prayerApparition.preload();
      cameo.preload();
      narration.beginMatch();
      reportEvents(match.events);
    }
  }
  function finishOpening() {
    view.skipOpening();
    intro.hidden = true;
    resetInputs();
    acc = 0;
    prayerApparition.preload();
    if (!tutorial) { cameo.preload(); narration.beginMatch(); }
    reportEvents(match.events);
    if (document.activeElement === $('skip-intro')) $('match-shell').focus({ preventScroll: true });
  }
  function skipFromInput(event) {
    if (guest || !view.opening()) return;
    if (!hasDevice(event.pointerType === 'touch' ? 'touch' : 'keyboard')) return;
    if (event.type === 'keydown' && (event.metaKey || event.ctrlKey || event.altKey)) return;
    if (event.type === 'pointermove' && ((!event.movementX && !event.movementY) || event.target === $('skip-intro'))) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
    finishOpening();
  }
  for (const type of ['keydown', 'pointerdown', 'pointermove', 'wheel']) {
    addEventListener(type, skipFromInput, { capture: true, passive: false });
  }
  $('skip-intro').addEventListener('click', () => { if (view.opening()) finishOpening(); });

  function showMove(symbol, name, team = 0) {
    hud.showMove(symbol, name, team);
    signalT = 1.1;
  }

  function clashBannerText() {
    const pref = narrationLang();
    const lang = pref === 'el' || pref === 'en' ? pref
      : (navigator.language || '').toLowerCase().startsWith('el') ? 'el' : 'en';
    return lang === 'el' ? 'Ο καθένας είναι το αγαπημένο παιδί του Θεού!' : "Everyone is God's favorite child";
  }

  function banner(text, secs = 1.6, team, clash = false) {
    const message = $('banner');
    message.textContent = text;
    message.classList.toggle('clash-banner', Boolean(clash));
    message.style.color = team === undefined ? '' : `var(--team-${team})`;
    bannerT = secs;
  }

  function rematch() {
    if (guest) return;
    online?.newRound();
    match = newMatch(match.level);
    results.hidden = true;
    resetInputs();
    signalT = 0;
    goalAt = null;
    acc = 0;
    prayerApparition.reset();
    cameo.reset(match.seed);
    narration.resetMatch();
    banner('Kick-off!');
    startOpening();
  }

  function reportEvents(events) {
    playEvents(events);
    if (!tutorial) {
      cameo.handleEvents(events, match);
      narration.handleEvents(events, match);
    }
    view.recordPrayerEvents(match, events);
    prayerApparition.recordEvents(match, events);
    for (const e of events) {
      if (online?.role === 'host' && (['goal', 'kickoff', 'fulltime', 'prayer', 'clash', 'maryBlock'].includes(e.type) || (e.type === 'kick' && e.jesus))) {
        online.hostSnapshot(match, 'live', true);
      }
      online?.hostEvent(e);
      if (e.human && e.type === 'pass' && e.kind === 'through') showMove('➜', 'Through ball', e.team);
      if (e.human && e.type === 'kick' && e.kind === 'chip') showMove('↷', 'Chip shot', e.team);
      if (e.type === 'clash') banner(clashBannerText(), 3.2, undefined, true);
      if (e.type === 'goal') {
        banner(`GOAL! ${teams[e.team].name}`, 2, e.team);
        if (!guest && !tutorial) goalAt = match.t;
      }
      if (e.type === 'fulltime') showFullTime();
      if (e.type === 'parry') banner('Saved!', 0.8);
      if (e.type === 'replay' && view.startReplay(e.from, e.to)) { banner('', 0); $('replay').hidden = false; }
      if (e.type === 'replayEnd') view.skipReplay();
    }
  }
  function showFullTime() {
    banner('', 0);
    help.open = false;
    cameo.stop();
    showResults(results, match, teams);
  }

  let guestRound = 0, guestView = '', connected = true, hostReplay = false;
  function guestFrame(dt) {
    const inp = owners[0].control.poll();
    if (guestPauseRequest) { inp.pausePressed = true; guestPauseRequest = false; }
    online.guestInput(inp);
    clearActions();
    if (online.round !== guestRound) {
      guestRound = online.round;
      guestView = '';
      match = newMatch(match.level);
      results.hidden = true;
      prayerApparition.reset();
      cameo.reset(match.seed);
      narration.resetMatch();
      view.skipReplay();
    }
    const frame = online.present(match);
    if (!frame) { view.render(match, 0); return; }
    if (guestView !== frame.view) {
      if (!guestView) banner('', 0);
      if (frame.view === 'opening') intro.hidden = !view.startOpening(match);
      else { intro.hidden = true; view.skipOpening(); prayerApparition.preload(); cameo.preload(); narration.beginMatch(); }
      if (['replay', 'replayPaused'].includes(guestView) && !['replay', 'replayPaused'].includes(frame.view)) view.skipReplay();
      const paused = frame.view === 'pause' || frame.view === 'replayPaused';
      if (paused) { narration.stop(); cameo.stop(); banner('Paused', Infinity); }
      else if (pauseButton.textContent === 'Resume') {
        banner('', 0);
        if (document.activeElement === pauseButton) $('match-shell').focus({ preventScroll: true });
      }
      pauseButton.textContent = paused ? 'Resume' : 'Pause';
      guestView = frame.view;
    }
    reportEvents(frame.events);
    if (frame.view === 'live') narration.observeMatch(match);
    if (results.hidden && match.phase === 'over') showFullTime();
    drawMatch(dt, frame.view === 'pause' || frame.view === 'replayPaused', [null, inp]);
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (online && !online.connected) {
      if (connected) { resetInputs(); clearCharge(); banner(guest ? 'Connection lost' : 'Waiting for guest', Infinity); }
      connected = false;
      view.render(match, 0);
      requestAnimationFrame(frame);
      return;
    }
    if (!connected) { connected = true; banner('', 0); acc = 0; }
    if (guest) { guestFrame(dt); requestAnimationFrame(frame); return; }
    if (view.opening()) {
      if (owners.some(({ control }) => control.padActive())) finishOpening();
      view.render(match, dt);
      if (!intro.hidden && !view.opening()) finishOpening();
      online?.hostSnapshot(match, view.opening() ? 'opening' : 'live');
      requestAnimationFrame(frame);
      return;
    }
    const inputs = owners.map(({ control }) => control.poll());
    if (online) inputs[1] = online.remoteInput();
    if (tutor) {
      const pad = tutorialUi.pollButtons();
      if (pad.view && pauseMenu.open) { leaveTutorial(); return; }
      if (tutor.state().phase === 'complete' && (pad.a || inputs[0].passPressed)) { leaveTutorial(); return; }
      if (pad.view && !pauseMenu.open) { tutor.skip(match); resetInputs(); }
    }
    const pausePressed = inputs.some(input => input.pausePressed);
    const menuStep = inputs.find(input => input.menuStep)?.menuStep;
    if (pausePressed) setPaused(!pauseMenu.open);
    else if (pauseMenu.open && inputs.some(input => input.menuConfirm)) setPaused(false);
    else if (pauseMenu.open && menuStep) {
      const index = levels.findIndex(option => option.checked);
      chooseLevel(levels[(index + menuStep + levels.length) % levels.length].value);
    }
    const paused = pauseMenu.open;
    if (paused || pausePressed) {
      clearActions();
      clearCharge();
    }

    // Goal replay: near the end of the live celebration the simulation holds while the renderer replays the goal.
    if (!paused && goalAt !== null && match.phase === 'goal' && match.phaseT < 0.3) {
      const from = goalAt - 3.2, to = goalAt + 1.0;
      if (view.startReplay(from, to)) {
        banner('', 0); $('replay').hidden = false;
        online?.hostEvent({ type: 'replay', from, to });
        hostReplay = true;
      }
      goalAt = null;
    }
    if (view.replaying()) {
      if (inputs.some(input => input.passPressed || input.shootReleased)) view.skipReplay();
      clearActions();
      acc = 0;
      if (!view.replaying()) $('replay').hidden = true;
    } else if (!paused) {
      if (match.phase === 'over' && (online ? [inputs[0]] : inputs).some(input => input.passPressed || input.shootReleased)) {
        rematch();
        requestAnimationFrame(frame);
        return;
      }
      acc += dt;
      while (acc >= DT) {
        let stepInputs = inputs;
        if (tutor) {
          match.clock = MATCH.seconds;
          tutorInput = tutor.input(match, inputs[0]);
          stepInputs = [tutorInput, ...inputs.slice(1)];
        }
        step(match, stepInputs, DT);
        clearActions();
        acc -= DT;
        reportEvents(match.events);
        tutor?.after(match, match.events, tutorInput, DT);
        if (!tutorial) narration.observeMatch(match);
      }
    }

    drawMatch(dt, paused, tutor && tutorInput ? [tutorInput, ...inputs.slice(1)] : inputs);
    if (hostReplay && !view.replaying()) { online?.hostEvent({ type: 'replayEnd' }); hostReplay = false; }
    if (online) {
      const presentation = view.replaying() ? (paused ? 'replayPaused' : 'replay') : (paused ? 'pause' : 'live');
      online.hostSnapshot(match, presentation);
    }
    requestAnimationFrame(frame);
  }

  // Where each controlled priest's next pass or shot goes: the aim point, else the stick, else his facing.
  function controlArrow(inp, h) {
    if (!inp || !h) return null;
    const auto = !!inp.autoRun;
    if (inp.aim) {
      const dx = inp.aim.x - h.pos.x, dz = inp.aim.z - h.pos.z, d = Math.hypot(dx, dz);
      if (d > 0.3) return { x: dx / d, z: dz / d, auto };
    }
    const L = Math.hypot(inp.move.x, inp.move.z);
    if (L > 0.2) return { x: inp.move.x / L, z: inp.move.z / L, auto };
    return auto ? { x: Math.cos(h.facing ?? 0), z: Math.sin(h.facing ?? 0), auto } : null;
  }

  // Small debug badge in online matches (shown only with ?net=debug): P2P vs Server.
  const netBadge = $('net-badge');
  function showTransport() {
    if (!online || !netDebug) { netBadge.hidden = true; return; }
    const t = online.transport;
    if (netBadge.dataset.transport === t && !netBadge.hidden) return;
    netBadge.hidden = false;
    netBadge.dataset.transport = t;
    netBadge.textContent = t === 'direct' ? 'P2P' : 'Server';
    netBadge.title = t === 'direct' ? 'Connected directly to the other player' : 'Connected through the match server';
  }

  function drawMatch(dt, paused, inputs) {
    showTransport();
    view.setControlArrows([0, 1].map(t => controlArrow(inputs?.[t], match.humans?.[t])));
    view.render(match, paused ? 0 : dt);
    if (!view.replaying()) $('replay').hidden = true;
    if (touch) {
      let label = 'Pass';
      if (view.replaying()) label = 'Skip';
      else if (match.phase === 'over' && !guest) label = 'Restart';
      else if (match.phase === 'play' && match.ball.owner !== match.humans[owners[0].team]) label = 'Tackle';
      touch.setPassLabel(label);
      touch.updatePrayer(match.prayers?.[owners[0].team], match.prayersEnabled && match.phase === 'play' && !view.replaying());
    }
    updateScoreboard();
    prayerHud.update(match, { hidden: view.opening() || view.replaying(), lang: narrationLang() });
    const displayT = view.replaying() ? view.replayTime() : match.t;
    prayerApparition.update(displayT, { hidden: view.opening() || match.phase === 'over', lang: narrationLang() });
    updateControlHint(match, inputs);
    tutorialUi?.update(tutor.state(), tutor.padState());
    if (!paused) signalT = Math.max(0, signalT - dt);
    signal.hidden = paused || signalT === 0 || match.phase !== 'play' || view.replaying();
    if (!paused && bannerT > 0) {
      bannerT -= dt;
      if (bannerT <= 0) { $('banner').textContent = ''; $('banner').classList.remove('clash-banner'); }
    }
  }
  if (guest) banner('Waiting for host', Infinity);
  else if (tutor) { updateScoreboard(); finishOpening(); tutor.begin(match, 0); }
  else startOpening();
  requestAnimationFrame(frame);
}
