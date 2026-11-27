import { AI_LEVELS, TEAMS } from './config.js';
import { FIELDS } from './fields.js';
import { createOnlineSession } from './online-session.js';
import { createPeerLink, relayUrl } from './p2p.js';
import { packInvite, packReply, unpackCode } from './invite-code.js';
import { startAudio } from './audio.js';

const PROTOCOL_VERSION = 3;
const FALLBACK_DELAY_MS = 6500;
const DIRECT_FAIL_MS = 15000;
const DIRECT_FAIL_MESSAGE =
  "Couldn't connect directly — some networks (mobile data, strict office/school Wi-Fi) block it. Try another network.";

const netModes = () => new Set(new URLSearchParams(location.search).getAll('net').flatMap((v) => v.split(',')));
const forceRelay = () => netModes().has('relay') || typeof RTCPeerConnection !== 'function';
const blockDirect = () => netModes().has('block-direct');

const validSetup = (s) =>
  s && [3, 5].includes(s.size) && Object.hasOwn(FIELDS, s.field) &&
  TEAMS.some((team) => team.id === s.kit) && Object.hasOwn(AI_LEVELS, s.level);

// Pure fallback timing / eligibility logic exported for unit testing.
export function decideDirectTimeout({ hasRelayFallback, elapsedMs, directAlive, fallbackStarted, iceFailed = false }) {
  if (directAlive) return 'direct';
  if (hasRelayFallback) {
    if (!fallbackStarted && (iceFailed || elapsedMs >= FALLBACK_DELAY_MS)) return 'fallback';
    return 'wait';
  }
  if (iceFailed || elapsedMs >= DIRECT_FAIL_MS) return 'fail';
  return 'wait';
}

async function copyText(text, button, fallbackInput) {
  const original = button.textContent;
  let ok = false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {}
  }
  if (!ok && fallbackInput) {
    fallbackInput.focus();
    fallbackInput.select();
    try { ok = document.execCommand('copy'); } catch {}
  }
  button.textContent = ok ? 'Copied!' : 'Select & copy';
  setTimeout(() => { button.textContent = original; }, 1600);
}

// Unified invite-code online lobby (all builds).
// Builds configured with a relay silently fall back to the relay if direct WebRTC does not open within ~6.5 s
// or drops mid-match, with no visible difference to players. Builds without a relay are direct-only.
export function createRoomLobby(getSetup, startMatch) {
  const el = (id) => document.getElementById(id);
  const hostPanel = el('invite-host');
  const guestPanel = el('invite-guest');
  const inviteOut = el('invite-code-out');
  const copyInviteBtn = el('copy-invite');
  const hostReplyForm = el('host-reply-form');
  const replyIn = el('reply-code-in');
  const connectReplyBtn = el('connect-reply');

  const guestInviteForm = el('guest-invite-form');
  const inviteIn = el('invite-code-in');
  const createReplyBtn = el('create-reply');
  const guestReplyBox = el('guest-reply-box');
  const matchSummary = el('invite-match-summary');
  const replyOut = el('reply-code-out');
  const copyReplyBtn = el('copy-reply');

  const status = el('room-status');
  const overlay = el('network-status');
  const retry = el('rejoin-room');

  let role = null;
  let settings = null;
  let sessionId = '';
  let token = '';
  let session = null;
  let link = null;
  let socket = null;
  let playing = false;
  let launching = false;
  let guestReadySent = false;
  let peerReady = false;
  let fallbackTimer = null;
  let failTimer = null;
  let reconnectTimer = null;
  let fallbackStarted = false;
  let directDisabled = false;
  let attemptId = 0;

  const say = (text) => { status.textContent = text; };

  function networkNotice(text, canRetry = false) {
    overlay.querySelector('p').textContent = text;
    retry.hidden = !canRetry;
    retry.disabled = false;
    overlay.hidden = false;
  }

  function clearTimers() {
    clearTimeout(fallbackTimer); fallbackTimer = null;
    clearTimeout(failTimer); failTimer = null;
    clearTimeout(reconnectTimer); reconnectTimer = null;
  }

  function closeSocket() {
    const old = socket;
    socket = null;
    session?.detachSocket();
    if (old && old.readyState < WebSocket.CLOSING) old.close();
  }

  function closeLink() {
    const old = link;
    link = null;
    old?.close();
    session?.setLink(null);
  }

  function getConfiguredRelay() {
    return relayUrl();
  }

  function leave() {
    attemptId++;
    clearTimers();
    closeLink();
    closeSocket();
    session?.dispose();
    session = null;
    settings = null;
    sessionId = '';
    token = '';
    playing = false;
    launching = false;
    guestReadySent = false;
    peerReady = false;
    fallbackStarted = false;
    directDisabled = false;
    overlay.hidden = true;
  }

  // Expose live transport & test hooks for automated CDP verification.
  globalThis.__papifaNet = {
    transport: () => session?.transport ?? null,
    stats: () => (session ? JSON.parse(JSON.stringify(session.stats)) : null),
    hasFallback: () => getConfiguredRelay() !== null,
    dropDirect: () => {
      directDisabled = true;
      closeLink();
      handleDirectDrop();
    },
  };

  function sendGuestReady() {
    if (role !== 'guest' || guestReadySent) return;
    if (link?.alive && link.send('sure', '{"type":"ready"}')) {
      guestReadySent = true;
      return;
    }
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'ready' }));
      guestReadySent = true;
    }
  }

  async function launch(myAttempt) {
    if (launching || playing || !session || !settings) return;
    launching = true;
    try {
      say('Loading pitch…');
      await startMatch(settings, session, () => myAttempt === attemptId && session !== null);
      if (myAttempt !== attemptId || !session) return;
      playing = true;
      overlay.hidden = true;
      if (role === 'guest') sendGuestReady();
    } catch {
      if (myAttempt === attemptId) {
        if (playing) networkNotice('The pitch could not load.', false);
        else say('The pitch could not load. Try again.');
      }
    } finally {
      launching = false;
    }
  }

  function onTransportLive(myAttempt) {
    if (myAttempt !== attemptId || !session) return;
    clearTimers();
    session.setPeerConnected(true);
    if (playing) {
      overlay.hidden = true;
      if (role === 'guest') sendGuestReady();
      return;
    }
    if (role === 'guest') {
      launch(myAttempt);
    } else if (peerReady) {
      launch(myAttempt);
    } else {
      say('Connecting…');
    }
  }

  function startSilentRelayFallback(myAttempt) {
    if (myAttempt !== attemptId) return;
    const url = getConfiguredRelay();
    if (!url || !sessionId || !token || !session) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    fallbackStarted = true;
    clearTimeout(fallbackTimer); fallbackTimer = null;

    if (playing) {
      networkNotice('Connecting…', false);
    } else if (role === 'host') {
      say('Connecting…');
    }

    let ws;
    try { ws = new WebSocket(url); } catch {
      scheduleRelayReconnect(myAttempt);
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      if (ws !== socket || myAttempt !== attemptId) return;
      ws.send(JSON.stringify({
        type: 'pair',
        version: PROTOCOL_VERSION,
        session: sessionId,
        role,
        token,
      }));
    });

    ws.addEventListener('message', ({ data }) => {
      if (ws !== socket || myAttempt !== attemptId || typeof data !== 'string' || data.length > 2048) return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'error') {
        closeSocket();
        if (msg.code === 'version') {
          if (playing) networkNotice('A new version of Papifa is out. Reload to play online.', false);
          else say('A new version of Papifa is out. Reload to play online.');
        } else if (!playing && !link?.alive) {
          say(DIRECT_FAIL_MESSAGE);
          connectReplyBtn.disabled = false;
        }
        return;
      }
      if (msg.type === 'paired') {
        if (playing) session.attachSocket(ws);
        else session.replaceSocket(ws);
        if (msg.peer) {
          onTransportLive(myAttempt);
          if (playing && role === 'guest') {
            ws.send(JSON.stringify({ type: 'ready' }));
          }
        }
      } else if (msg.type === 'peer-joined') {
        if (playing) session.attachSocket(ws);
        onTransportLive(myAttempt);
        if (playing && role === 'guest') {
          ws.send(JSON.stringify({ type: 'ready' }));
        }
      } else if (msg.type === 'peer-ready' && role === 'host') {
        peerReady = true;
        if (!playing && (link?.alive || socket?.readyState === WebSocket.OPEN)) launch(myAttempt);
      } else if (msg.type === 'peer-left') {
        if (!link?.alive) {
          session?.setPeerConnected(false);
          if (playing) networkNotice('Connecting…', false);
        }
      }
    });

    ws.addEventListener('close', () => {
      if (ws !== socket || myAttempt !== attemptId) return;
      socket = null;
      session?.detachSocket();
      if (!link?.alive) {
        session?.setPeerConnected(false);
        if (playing) {
          networkNotice('Connecting…', false);
          scheduleRelayReconnect(myAttempt);
        }
      }
    });
  }

  function scheduleRelayReconnect(myAttempt) {
    if (myAttempt !== attemptId || !getConfiguredRelay() || !playing) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      if (myAttempt === attemptId && playing && !link?.alive && !socket) {
        startSilentRelayFallback(myAttempt);
      }
    }, 1500);
  }

  function handleDirectDrop() {
    if (!playing) return;
    const hasFallback = getConfiguredRelay() !== null;
    if (hasFallback) {
      if (socket?.readyState === WebSocket.OPEN) {
        session?.attachSocket(socket);
        overlay.hidden = true;
      } else {
        session?.setPeerConnected(false);
        startSilentRelayFallback(attemptId);
      }
    } else {
      session?.setPeerConnected(false);
      networkNotice('Connection lost — make a new invite', false);
    }
  }

  function handleDirectFailure(myAttempt) {
    if (myAttempt !== attemptId || playing || link?.alive) return;
    if (getConfiguredRelay()) {
      startSilentRelayFallback(myAttempt);
    } else {
      clearTimers();
      closeLink();
      say(DIRECT_FAIL_MESSAGE);
      if (role === 'host') connectReplyBtn.disabled = false;
    }
  }

  function armConnectionTimers(myAttempt, { startFailTimer = true } = {}) {
    clearTimers();
    const hasFallback = getConfiguredRelay() !== null;
    if (hasFallback) {
      fallbackTimer = setTimeout(() => {
        if (myAttempt === attemptId && !link?.alive && !playing) {
          startSilentRelayFallback(myAttempt);
        }
      }, FALLBACK_DELAY_MS);
    }
    if (!hasFallback && startFailTimer) {
      failTimer = setTimeout(() => {
        handleDirectFailure(myAttempt);
      }, DIRECT_FAIL_MS);
    }
  }

  function createManualLink(myAttempt, peerRole) {
    const peerLink = createPeerLink({
      role: peerRole,
      onMessage: (text) => {
        if (myAttempt !== attemptId) return;
        if (text === '{"type":"ready"}') {
          if (peerRole === 'host') {
            peerReady = true;
            if (!playing && (link?.alive || socket?.readyState === WebSocket.OPEN)) launch(myAttempt);
          }
          return;
        }
        session?.receiveDirect(text);
      },
      onChange: (alive) => {
        if (myAttempt !== attemptId) return;
        if (alive) {
          if (directDisabled) {
            peerLink.close();
            return;
          }
          if (socket) closeSocket();
          session?.setLink(peerLink);
          onTransportLive(myAttempt);
        } else if (playing) {
          handleDirectDrop();
        }
      },
      onFailed: () => {
        if (myAttempt !== attemptId) return;
        if (playing) handleDirectDrop();
        else handleDirectFailure(myAttempt);
      },
    });
    return peerLink;
  }

  async function beginHostInvite(myAttempt) {
    settings = getSetup();
    if (!validSetup(settings)) {
      say('Invalid match settings.');
      return;
    }
    inviteOut.value = '';
    copyInviteBtn.disabled = true;
    connectReplyBtn.disabled = true;
    replyIn.value = '';
    say('Preparing invite code…');

    session = createOnlineSession(null, 'host');
    session.setPeerConnected(false);
    link = createManualLink(myAttempt, 'host');

    try {
      const offerSdp = await link.createOfferSdp();
      if (myAttempt !== attemptId) return;
      const packed = packInvite({ sdp: offerSdp, setup: settings });
      sessionId = packed.sessionId;
      token = packed.token;
      inviteOut.value = packed.code;
      copyInviteBtn.disabled = false;
      connectReplyBtn.disabled = false;
      say('Copy the invite code above, send it to your opponent, and paste their reply below.');
    } catch {
      if (myAttempt !== attemptId) return;
      say('Could not prepare an invite code in this browser.');
    }
  }

  function open(mode) {
    leave();
    const myAttempt = attemptId;
    role = mode === 'host' ? 'host' : 'guest';
    const hosting = role === 'host';
    el('room-title').textContent = hosting ? 'Host a match' : 'Join a match';
    hostPanel.hidden = !hosting;
    guestPanel.hidden = hosting;
    if (hosting) {
      beginHostInvite(myAttempt);
    } else {
      inviteIn.value = '';
      replyOut.value = '';
      guestReplyBox.hidden = true;
      createReplyBtn.disabled = false;
      say('Paste your host’s invite code to generate a reply.');
    }
  }

  copyInviteBtn.addEventListener('click', () => {
    if (inviteOut.value) copyText(inviteOut.value, copyInviteBtn, inviteOut);
  });

  copyReplyBtn.addEventListener('click', () => {
    if (replyOut.value) copyText(replyOut.value, copyReplyBtn, replyOut);
  });

  hostReplyForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (role !== 'host' || connectReplyBtn.disabled || !sessionId || !token) return;
    const myAttempt = attemptId;
    const unpacked = unpackCode(replyIn.value, {
      expectedKind: 'reply',
      expectedSessionId: sessionId,
      expectedToken: token,
    });
    if (!unpacked.ok) {
      say(unpacked.error);
      replyIn.focus();
      return;
    }
    startAudio();
    connectReplyBtn.disabled = true;
    say('Connecting…');

    if (forceRelay() || blockDirect()) {
      directDisabled = true;
      closeLink();
      if (getConfiguredRelay()) {
        startSilentRelayFallback(myAttempt);
      } else {
        // Public no-relay build with direct link blocked: surface clear failure after short beat.
        failTimer = setTimeout(() => handleDirectFailure(myAttempt), 400);
      }
      return;
    }

    try {
      await link.acceptAnswerSdp(unpacked.sdp);
      if (myAttempt !== attemptId) return;
      armConnectionTimers(myAttempt, { startFailTimer: true });
    } catch {
      if (myAttempt !== attemptId) return;
      handleDirectFailure(myAttempt);
    }
  });

  guestInviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (role !== 'guest' || createReplyBtn.disabled) return;
    const myAttempt = attemptId;
    const unpacked = unpackCode(inviteIn.value, { expectedKind: 'invite' });
    if (!unpacked.ok || !validSetup(unpacked.setup)) {
      say(unpacked.ok ? 'This invite code has invalid match settings.' : unpacked.error);
      inviteIn.focus();
      return;
    }
    startAudio();
    createReplyBtn.disabled = true;
    guestReplyBox.hidden = true;
    say('Preparing reply code…');

    settings = unpacked.setup;
    sessionId = unpacked.sessionId;
    token = unpacked.token;

    closeLink();
    closeSocket();
    session?.dispose();
    session = createOnlineSession(null, 'guest');
    session.setPeerConnected(false);
    link = createManualLink(myAttempt, 'guest');

    try {
      const answerSdp = await link.acceptOfferSdp(unpacked.sdp);
      if (myAttempt !== attemptId) return;
      const replyCode = packReply({ sdp: answerSdp, sessionId, token });
      const fieldName = FIELDS[settings.field]?.name ?? settings.field;
      const hostTeam = TEAMS.find((t) => t.id === settings.kit)?.name ?? settings.kit;
      const guestTeam = TEAMS.find((t) => t.id !== settings.kit)?.name ?? 'Away';
      matchSummary.textContent = `${settings.size}v${settings.size} · ${fieldName} · You play ${guestTeam} vs ${hostTeam}`;
      replyOut.value = replyCode;
      guestReplyBox.hidden = false;
      say('Copy the reply code and send it to your host.');

      if (forceRelay() || blockDirect()) {
        directDisabled = true;
        closeLink();
        if (getConfiguredRelay()) {
          startSilentRelayFallback(myAttempt);
        } else {
          failTimer = setTimeout(() => handleDirectFailure(myAttempt), 400);
        }
        return;
      }

      // On relay-configured builds, silently pair on the relay if direct link does not open within ~6.5 s.
      // On no-relay builds, keep waiting while the host pastes the reply (fail on ICE failure).
      armConnectionTimers(myAttempt, { startFailTimer: false });
    } catch {
      if (myAttempt !== attemptId) return;
      createReplyBtn.disabled = false;
      say('Could not prepare a reply code in this browser.');
    }
  });

  retry.addEventListener('click', () => {
    if (getConfiguredRelay()) startSilentRelayFallback(attemptId);
  });
  el('leave-room').addEventListener('click', () => { leave(); location.reload(); });
  addEventListener('pagehide', leave);
  return { open, leave };
}
