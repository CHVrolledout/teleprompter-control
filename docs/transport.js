// Connection layer. Two modes, same messages:
//
//  • "server": the page was opened from `node server.js` (Mac on the same Wi-Fi).
//              Server-Sent Events + POSTs to that server.
//  • "p2p":    the page was opened from static hosting (GitHub Pages).
//              The iPad runs the hub itself and the controller connects to it directly
//              over WebRTC. A free public PeerJS service is used only for the
//              ~2-second handshake; after that, data flows device-to-device.
//
// Both modes deliver messages to `on.message(event, data)` where event is
// 'script' | 'state' | 'pos' | 'cmd', and report link changes to `on.status(text, ok)`.

import { createHub } from './hub.js';

const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PEER_PREFIX = 'tprompt-remote-v1-';
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
const STATE_KEY = 'tp-state';
const ROOM_KEY = 'tp-room';

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

// The iPad: hosts the hub and accepts controller connections.
async function p2pHost(on) {
  let room = normalizeRoom(store.get(ROOM_KEY));
  if (room.length < 4) { room = makeRoom(); store.set(ROOM_KEY, room); }

  let initial = {};
  try { initial = JSON.parse(store.get(STATE_KEY) || '{}'); } catch {}

  const conns = new Set();
  const openConns = () => [...conns].filter((c) => c.open);
  const hub = createHub({
    initial,
    counts: () => ({ prompters: 1, controllers: openConns().length }),
    save: (s) => store.set(STATE_KEY, JSON.stringify(s)),
    emit: (event, data, role) => {
      if (role !== 'controller') on.message(event, data);
      if (role !== 'prompter') for (const c of openConns()) c.send({ ev: event, data });
    },
  });

  // Show the script immediately, even before any network.
  on.message('script', { script: hub.state.script });
  on.message('state', hub.publicState());

  let peer = null;
  let signal = 'Connecting…';
  const report = () => {
    const n = openConns().length;
    if (n) on.status(`Room ${room} · ${n} controller${n > 1 ? 's' : ''} connected`, true);
    else on.status(`Room ${room} · ${signal}`, false);
  };

  async function startPeer() {
    try { await loadPeerJS(); } catch { signal = 'No internet — can’t open room'; report(); return; }
    peer = new window.Peer(PEER_PREFIX + room, { debug: 1 });
    peer.on('open', () => { signal = 'waiting for controller'; report(); });
    peer.on('disconnected', () => { signal = 'handshake service offline (connected controllers keep working)'; report(); });
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
      if (err.type === 'unavailable-id') {
        // The previous session for this room hasn't timed out yet (e.g. right after a reload).
        signal = 'reopening room…';
        report();
        peer.destroy();
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) {
        signal = 'no internet for handshake — retrying…';
        report();
      }
    });
  }

  // Watchdog: keep the room registered with the handshake service.
  setInterval(() => {
    if (!peer || peer.destroyed) startPeer();
    else if (peer.disconnected) { try { peer.reconnect(); } catch {} }
  }, 4000);
  startPeer();
  report();

  return {
    mode: 'p2p',
    room,
    command: (body) => hub.command(body),
    position: (p) => hub.position(p),
  };
}

// The controller: connects to the iPad's room.
async function p2pClient(room, on) {
  let peer = null;
  let conn = null;
  let dialedAt = 0;
  let lastError = '';

  async function ensurePeer() {
    try { await loadPeerJS(); } catch { on.status('No internet — can’t reach the iPad yet', false); return; }
    if (!peer || peer.destroyed) {
      peer = new window.Peer({ debug: 1 });
      peer.on('open', dial);
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') lastError = `No iPad found in room ${room} — is the prompter open?`;
        else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(err.type)) lastError = 'No internet for handshake — retrying…';
        else lastError = 'Connection problem — retrying…';
        on.status(lastError, false);
      });
    } else if (peer.disconnected) {
      try { peer.reconnect(); } catch {}
    } else if (peer.open) dial();
  }

  function dial() {
    if (conn && (conn.open || Date.now() - dialedAt < 8000)) return;
    if (conn) try { conn.close(); } catch {}
    dialedAt = Date.now();
    on.status(`Connecting to room ${room}…`, false);
    const c = peer.connect(PEER_PREFIX + room, { reliable: true, serialization: 'json' });
    conn = c;
    c.on('open', () => { if (conn === c) on.status(`Connected · room ${room}`, true); });
    c.on('data', (m) => { if (conn === c && m && m.ev) on.message(m.ev, m.data); });
    const lost = () => {
      if (conn !== c) return;
      conn = null;
      on.status('Lost the iPad — reconnecting…', false);
      ensurePeer();
    };
    c.on('close', lost);
    c.on('error', lost);
  }

  setInterval(() => { if (!conn || !conn.open) ensurePeer(); }, 3000);
  ensurePeer();

  return {
    mode: 'p2p',
    room,
    command: (body) => { if (conn && conn.open) conn.send({ kind: 'cmd', body }); },
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
