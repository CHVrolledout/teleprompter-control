// Teleprompter Control — optional local server (no dependencies).
// Use this when there's no internet: run `node server.js` on a computer on the same Wi-Fi.
// When the app is opened from GitHub Pages instead, the devices connect peer-to-peer
// and this file isn't used.
//
// Transport: Server-Sent Events (server -> devices) + small JSON POSTs (devices -> server).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHub } from './docs/hub.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const APP = path.join(ROOT, 'docs');
const STATE_FILE = path.join(ROOT, 'state.json');

const clients = new Set(); // { res, role, id }
const count = (role) => [...clients].filter((c) => c.role === role).length;

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// With several iPads, the first one connected is the "main" prompter: it scrolls and reports
// the position. The others follow it. If the main one leaves, the next one takes over.
let leadId = null;
function electLead() {
  const prompters = [...clients].filter((c) => c.role === 'prompter');
  if (!prompters.some((c) => c.id === leadId)) leadId = prompters[0]?.id ?? null;
  for (const c of prompters) send(c.res, 'role', { lead: c.id === leadId });
}

let initial = {};
try { initial = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

const hub = createHub({
  initial,
  counts: () => ({ prompters: count('prompter'), controllers: count('controller') }),
  emit: (event, data, role) => {
    for (const c of clients) if (!role || c.role === role) send(c.res, event, data);
  },
  save: (state) => fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), () => {}),
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new Error('too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(e); }
    });
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const ROUTES = { '/': 'index.html', '/prompter': 'prompter.html', '/controller': 'controller.html' };

function serveStatic(res, pathname) {
  const rel = ROUTES[pathname] || decodeURIComponent(pathname).slice(1);
  const file = path.normalize(path.join(APP, rel));
  if (!file.startsWith(APP + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/api/ping') { res.writeHead(200); return res.end('ok'); }

  if (url.pathname === '/api/events' && req.method === 'GET') {
    const role = url.searchParams.get('role') === 'prompter' ? 'prompter' : 'controller';
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1000\n\n');
    const id = url.searchParams.get('id') || Math.random().toString(36).slice(2);
    const client = { res, role, id };
    clients.add(client);
    send(res, 'script', { script: hub.state.script });
    electLead();
    hub.changed();
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      electLead();
      hub.changed();
    });
    return;
  }

  if (req.method === 'POST' && (url.pathname === '/api/cmd' || url.pathname === '/api/pos')) {
    try {
      const body = await readBody(req);
      if (url.pathname === '/api/cmd') hub.command(body);
      else if (!body.id || body.id === leadId) hub.position(body); // only the main iPad sets the position
      res.writeHead(204);
    } catch {
      res.writeHead(400);
    }
    return res.end();
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  res.writeHead(405);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log('\nTeleprompter Control (local server mode) is running.\n');
  for (const ip of ips.length ? ips : ['localhost']) {
    console.log(`  iPad (prompter):    http://${ip}:${PORT}/prompter`);
    console.log(`  Controller:         http://${ip}:${PORT}/controller\n`);
  }
  console.log('Both devices must be on the same Wi-Fi as this computer. Ctrl+C to stop.\n');
});
