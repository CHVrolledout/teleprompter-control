// Internet relay fallback, used when a direct WebRTC link between the devices can't be made
// (phone on mobile data, Wi-Fi that blocks device-to-device traffic, carrier-grade NAT, …).
//
// Messages go through free public MQTT brokers over secure WebSockets. Every message is
// end-to-end encrypted (AES-GCM) with a key derived from the room code, and the topic name
// is derived from it too, so the broker never sees the room code or the script.
// Two brokers are used at once; duplicates are dropped, so either one being down is fine.

const MQTT_URL = 'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js';
const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const SALT = 'tprompt-remote-v1';
const ITERATIONS = 300000;

let mqttPromise = null;
function loadMqtt() {
  if (window.mqtt) return Promise.resolve();
  mqttPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = MQTT_URL;
    s.onload = resolve;
    s.onerror = () => { mqttPromise = null; reject(new Error('Could not load MQTT client')); };
    document.head.appendChild(s);
  });
  return mqttPromise;
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randId = () => hex(crypto.getRandomValues(new Uint8Array(6)));

async function deriveSecrets(room) {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(room), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(SALT), iterations: ITERATIONS }, base, 512);
  const key = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, topic: `${SALT}/${hex(bits.slice(32, 48))}` };
}

/**
 * side: 'host' (iPad) or 'ctl' (controller)
 * onMessage(obj) gets each decrypted message once; onChange() fires when broker links change.
 */
export async function openRelay(room, side, onMessage, onChange = () => {}) {
  if (!window.crypto?.subtle) throw new Error('Relay needs HTTPS');
  await loadMqtt();
  const { key, topic } = await deriveSecrets(room);
  const inTopic = `${topic}/${side === 'host' ? 'h' : 'c'}`;
  const outTopic = `${topic}/${side === 'host' ? 'c' : 'h'}`;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const me = randId();
  let n = 0;

  const seen = new Set();
  const seenOrder = [];
  const remember = (id) => {
    seen.add(id); seenOrder.push(id);
    if (seenOrder.length > 500) seen.delete(seenOrder.shift());
  };

  // Keep decrypt/encrypt in order (WebCrypto is async).
  let inQ = Promise.resolve(), outQ = Promise.resolve();

  const clients = BROKERS.map((url) => {
    const c = window.mqtt.connect(url, {
      clientId: 'tp_' + randId(), keepalive: 20, reconnectPeriod: 3000, connectTimeout: 8000, clean: true,
    });
    c.on('connect', () => { c.subscribe(inTopic, { qos: 0 }); onChange(); });
    c.on('close', onChange);
    c.on('error', () => {});
    c.on('message', (_t, buf) => {
      inQ = inQ.then(async () => {
        try {
          const bytes = new Uint8Array(buf);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
          const msg = JSON.parse(dec.decode(pt));
          if (!msg || seen.has(msg.i)) return;
          remember(msg.i);
          onMessage(msg.m);
        } catch { /* not ours / tampered — ignore */ }
      });
    });
    return c;
  });

  function send(m) {
    outQ = outQ.then(async () => {
      if (!clients.some((c) => c.connected)) return;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const body = enc.encode(JSON.stringify({ i: me + ':' + n++, m }));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
      const out = new Uint8Array(12 + ct.length);
      out.set(iv); out.set(ct, 12);
      for (const c of clients) if (c.connected) c.publish(outTopic, out, { qos: 0 });
    }).catch(() => {});
  }

  return {
    id: me,
    send,
    connected: () => clients.some((c) => c.connected),
    close: () => clients.forEach((c) => { try { c.end(true); } catch {} }),
  };
}
