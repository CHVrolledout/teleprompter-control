// Connection layer. Two modes, same messages:
//
//  • "server": the page was opened from `node server.js` (Mac on the same Wi-Fi).
//              Server-Sent Events + POSTs to that server.
//  • "p2p":    the page was opened from static hosting (GitHub Pages).
//              The iPad runs the hub itself. Controllers reach it two ways at once:
//                1. direct WebRTC link (PeerJS handles the handshake) — fastest, stays local
//                2. encrypted internet relay (relay.js) — works on any network
//              Commands use the direct link whenever it's open, the relay otherwise.
//
// Both modes deliver messages to `on.message(event, data)` where event is
// 'script' | 'state' | 'pos' | 'cmd', and report link changes to `on.status(text, ok)`.

import { createHub } from './hub.js';
import { openRelay } from './relay.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PEER_PREFIX = 'tprompt-remote-v1-';
// Public STUN only: PeerJS's own default TURN relay servers no longer exist.
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const STATE_KEY = 'tp-state';
const ROOM_KEY = 'tp-room';
const NET_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed'];

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

export const normalizeRoom = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

export async function detectMode() {
  const forced = new URLSearchParams(location.search).get('mode');
  if (forced === 'p2p' || forced === 'server') return forced;
  if (location.protocol === 'file:') return 'p2p';
  try {
    const r = await fetch('api/ping', { cache: 'no-store' });
    if (r.ok && (await r.text()) === 'ok') return 'server';
  } catch {}
  return 'p2p';
}

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {});
}

/* ---------------- Server mode ---------------- */
function serverTransport(role, on) {
  const es = new EventSource(`api/events?role=${role}`);
  for (const ev of ['script', 'state', 'pos', 'cmd']) {
    es.addEventListener(ev, (e) => on.message(ev, JSON.parse(e.data)));
  }
  es.onopen = () => on.status('Connected to local server', true);
  es.onerror = () => on.status('Local server offline — reconnecting…', false);
  return {
    mode: 'server',
    command: (body) => post('api/cmd', body),
    position: (p) => post('api/pos', p),
  };
}

/* ---------------- Peer-to-peer mode ---------------- */
let peerjsPromise = null;
function loadPeerJS() {
  if (window.Peer) return Promise.resolve();
  peerjsPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PEERJS_URL;
    s.onload = resolve;
    s.onerror = () => { peerjsPromise = null; reject(new Error('Could not load PeerJS (no internet?)')); };
    document.head.appendChild(s);
  });
  return peerjsPromise;
}

function makeRoom() {
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map((n) => ROOM_CHARS[n % ROOM_CHARS.length]).join('');
}

// Retry opening the relay until it works (e.g. internet comes back).
function keepRelay(room, side, onMessage, onChange, onReady) {
  let tries = 0;
  const attempt = () => openRelay(room, side, onMessage, onChange)
    .then(onReady)
    .catch(() => setTimeout(attempt, Math.min(15000, 2000 * ++tries)));
  attempt();
}

// The iPad: hosts the hub and accepts controllers over both paths.
async function p2pHost(on) {
  let room = normalizeRoom(store.get(ROOM_KEY));
  if (room.length < 4) { room = makeRoom(); store.set(ROOM_KEY, room); }

  let initial = {};
  try { initial = JSON.parse(store.get(STATE_KEY) || '{}'); } catch {}

  const conns = new Set();                 // direct PeerJS connections
  const relayCtls = new Map();             // controller id -> { last, direct }
  let relay = null;
  let lastRelayPos = 0;

  const openConns = () => [...conns].filter((c) => c.open);
  const relayOnly = () => [...relayCtls.values()].filter((c) => !c.direct).length;

  const hub = createHub({
    initial,
    counts: () => ({ prompters: 1, controllers: openConns().length + relayOnly() }),
    save: (s) => store.set(STATE_KEY, JSON.stringify(s)),
    emit: (event, data, role) => {
      if (role !== 'controller') on.message(event, data);
      if (role === 'prompter') return;
      for (const c of openConns()) c.send({ ev: event, data });
      if (relay && relayOnly()) {
        if (event === 'pos' && !data.seek) {             // relay: ~6 position updates/sec is plenty
          const now = Date.now();
          if (now - lastRelayPos < 150) return;
          lastRelayPos = now;
        }
        relay.send({ ev: event, data });
      }
    },
  });

  // Show the script immediately, even before any network.
  on.message('script', { script: hub.state.script });
  on.message('state', hub.publicState());

  let signal = 'Connecting…';
  const report = () => {
    const d = openConns().length, r = relayOnly(), n = d + r;
    if (n) {
      const how = r && !d ? 'via internet' : d && !r ? 'direct' : 'direct + internet';
      on.status(`Room ${room} · ${n} controller${n > 1 ? 's' : ''} connected (${how})`, true);
    } else {
      on.status(`Room ${room} · ${signal}`, false);
    }
  };

  /* Path 1: direct WebRTC */
  let peer = null;
  async function startPeer() {
    try { await loadPeerJS(); } catch { signal = 'no internet — retrying…'; report(); return; }
    peer = new window.Peer(PEER_PREFIX + room, { debug: 1, config: ICE });
    peer.on('open', () => { signal = 'waiting for controller'; report(); });
    peer.on('connection', (conn) => {
      conns.add(conn);
      conn.on('open', () => {
        conn.send({ ev: 'script', data: { script: hub.state.script } });
        hub.changed();
        report();
      });
      conn.on('data', (msg) => { if (msg && msg.kind === 'cmd') hub.command(msg.body); });
      const drop = () => { if (conns.delete(conn)) { hub.changed(); report(); } };
      conn.on('close', drop);
      conn.on('error', drop);
    });
    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') peer.destroy(); // old session still registered; watchdog retries
    });
  }
  setInterval(() => {
    if (!peer || peer.destroyed) startPeer();
    else if (peer.disconnected) { try { peer.reconnect(); } catch {} }
  }, 4000);
  startPeer();

  /* Path 2: encrypted internet relay */
  keepRelay(room, 'host', (m) => {
    if (!m || !m.id) return;
    if (m.kind === 'bye') {
      if (relayCtls.delete(m.id)) { hub.changed(); report(); }
      return;
    }
    const known = relayCtls.get(m.id);
    const wasCounted = known && !known.direct;
    relayCtls.set(m.id, { last: Date.now(), direct: !!m.direct });
    if (m.kind === 'hello') {
      if (!m.direct && (!known || m.want)) relay?.send({ ev: 'script', data: { script: hub.state.script } });
      if (wasCounted !== !m.direct) { hub.changed(); report(); }
      else if (!m.direct) relay?.send({ ev: 'state', data: hub.publicState() });
    }
    if (m.kind === 'cmd') hub.command(m.body);
  }, () => {}, (r) => { relay = r; signal = 'waiting for controller'; report(); });

  // Forget relay controllers that stopped saying hello.
  setInterval(() => {
    let changed = false;
    for (const [id, c] of relayCtls) if (Date.now() - c.last > 15000) { relayCtls.delete(id); changed = true; }
    if (changed) { hub.changed(); report(); }
  }, 5000);

  report();
  return {
    mode: 'p2p',
    room,
    command: (body) => hub.command(body),
    position: (p) => hub.position(p),
  };
}

// The controller: connects to the iPad's room over both paths.
async function p2pClient(room, on) {
  let peer = null;
  let conn = null;
  let dialedAt = 0;
  let relay = null;
  let relayHeardAt = 0;   // last message from the iPad via the relay
  let problem = '';

  const direct = () => !!(conn && conn.open);
  const viaRelay = () => !direct() && Date.now() - relayHeardAt < 6000;

  function report() {
    if (direct()) on.status(`Connected · room ${room} (direct)`, true);
    else if (viaRelay()) on.status(`Connected · room ${room} (via internet)`, true);
    else on.status(problem || `Connecting to room ${room}…`, false);
  }

  const hello = (want = false) => relay?.send({ kind: 'hello', id: relay.id, direct: direct(), want });

  /* Path 1: direct WebRTC */
  async function ensurePeer() {
    try { await loadPeerJS(); } catch { return; }
    if (!peer || peer.destroyed) {
      peer = new window.Peer({ debug: 1, config: ICE });
      peer.on('open', dial);
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') problem = `No iPad found in room ${room} — is the prompter open?`;
        else if (NET_ERRORS.includes(err.type)) problem = 'Waiting for internet…';
        report();
      });
    } else if (peer.disconnected) {
      try { peer.reconnect(); } catch {}
    } else if (peer.open) dial();
  }

  function dial() {
    if (conn && (conn.open || Date.now() - dialedAt < 10000)) return;
    if (conn) try { conn.close(); } catch {}
    dialedAt = Date.now();
    const c = peer.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => { if (conn === c) { problem = ''; report(); hello(); } });
    c.on('data', (m) => { if (conn === c && m && m.ev) on.message(m.ev, m.data); });
    const lost = () => {
      if (conn !== c) return;
      conn = null;
      hello(true);  // fall back to the relay right away
      report();
      ensurePeer();
    };
    c.on('close', lost);
    c.on('error', lost);
  }
  // `?relay=only` disables the direct link (for testing the fallback).
  if (new URLSearchParams(location.search).get('relay') !== 'only') {
    setInterval(() => { if (!direct()) ensurePeer(); }, 4000);
    ensurePeer();
  }

  /* Path 2: encrypted internet relay */
  keepRelay(room, 'ctl', (m) => {
    if (!m || !m.ev || direct()) return;  // direct link wins when it's up
    const was = viaRelay();
    relayHeardAt = Date.now();
    problem = '';
    if (!was) report();
    on.message(m.ev, m.data);
  }, () => {}, (r) => { relay = r; hello(true); });
  setInterval(() => { hello(); report(); }, 3000);
  addEventListener('pagehide', () => relay?.send({ kind: 'bye', id: relay.id }));

  report();
  return {
    mode: 'p2p',
    room,
    command: (body) => {
      if (direct()) conn.send({ kind: 'cmd', body });
      else relay?.send({ kind: 'cmd', id: relay.id, body });
    },
    position: () => {},
  };
}

/**
 * role: 'prompter' | 'controller'
 * opts.room: room code (controller in p2p mode)
 */
export async function connect(role, on, opts = {}) {
  const mode = opts.mode || (await detectMode());
  if (mode === 'server') return serverTransport(role, on);
  return role === 'prompter' ? p2pHost(on) : p2pClient(normalizeRoom(opts.room), on);
}

export const rememberRoom = (room) => store.set('tp-last-room', room);
export const lastRoom = () => normalizeRoom(store.get('tp-last-room'));
