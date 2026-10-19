#!/usr/bin/env node
/**
 * Axzora online Ludo — authoritative room server.
 *
 * Original code (MIT). The server owns the game state and the rules, so no
 * client can cheat: it seats players into rooms (create / join by 4-letter
 * code), rolls the dice, validates every move, resolves captures, and syncs
 * the full state to everyone in real time over WebSockets. Empty seats can be
 * filled by AI so a solo player can still start. Happy Paisa staking is carried
 * as room metadata (stake + pot) — settlement is confirmed by the app's wallet.
 *
 * The rules themselves live in game.js so they can be tested without sockets.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const G = require('./game');

const PORT = process.env.PORT === undefined || process.env.PORT === '' ? 8080 : Number(process.env.PORT);
const HOST = process.env.HOST || '0.0.0.0';
const VERSION = require('./package.json').version;

// ---- limits ---------------------------------------------------------------
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const MAX_CONNECTIONS = Number(process.env.MAX_CONNECTIONS) || 2000;
const MAX_PAYLOAD = 2048;                  // bytes per client message
const MAX_NAME = 16;
const MAX_CHAT = 140;
const LOBBY_IDLE_MS = 15 * 60 * 1000;      // empty/lobby rooms are dropped after 15 min
const GAME_IDLE_MS = 60 * 60 * 1000;       // abandoned games after 1 h
const SWEEP_MS = 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;

const rooms = new Map();                   // code -> room
let connectionCount = 0;

// ---- helpers --------------------------------------------------------------
const send = (ws, obj) => { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {} };
const fail = (ws, msg) => send(ws, { t: 'error', msg });

function broadcast(room) {
  const msg = JSON.stringify(G.view(room));
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) { try { p.ws.send(msg); } catch (e) {} }
  }
}

function broadcastChat(room, from, text) {
  const msg = JSON.stringify({ t: 'chat', from, text });
  for (const p of room.players) {
    if (p.ws && p.ws.readyState === 1) { try { p.ws.send(msg); } catch (e) {} }
  }
}

const sanitiseName = (name) => {
  const s = String(name == null ? 'Player' : name).replace(/[\u0000-\u001f<>&]/g, '').trim();
  return (s || 'Player').slice(0, MAX_NAME);
};

// ---- turn engine ----------------------------------------------------------
function scheduleAI(room) {
  const p = room.players[room.turn];
  if (p && p.ai && room.phase === 'await_roll') {
    const seat = room.turn;
    setTimeout(() => { if (rooms.get(room.code) === room) doRoll(room, seat); }, 600);
  }
}

function doRoll(room, seat) {
  if (room.phase !== 'await_roll' || room.turn !== seat) return;
  room.dice = 1 + Math.floor(Math.random() * 6);
  room.rolledSix = room.dice === 6;
  room.lastActivity = Date.now();

  const moves = G.movable(room, seat);
  if (moves.length === 0) {
    broadcast(room);
    setTimeout(() => {
      if (rooms.get(room.code) !== room || room.phase !== 'await_roll') return;
      G.nextTurn(room);
      broadcast(room);
      scheduleAI(room);
    }, 700);
    return;
  }

  room.phase = 'await_move';
  broadcast(room);
  const p = room.players[seat];
  if (p.ai) setTimeout(() => {
    if (rooms.get(room.code) !== room || room.phase !== 'await_move' || room.turn !== seat) return;
    doMove(room, seat, G.aiPick(room, seat, G.movable(room, seat)));
  }, 550);
}

function doMove(room, seat, tokenIndex) {
  if (room.phase !== 'await_move' || room.turn !== seat) return;
  if (!G.movable(room, seat).includes(tokenIndex)) return;

  const result = G.applyMove(room, seat, tokenIndex);
  room.lastActivity = Date.now();

  if (G.checkWin(room, seat)) { broadcast(room); return; }

  if (result.captured > 0) {
    broadcastChat(room, 'table', room.players[seat].name + ' sent ' + result.captured + ' token(s) home');
  }

  if (room.rolledSix) {
    // Rolling a six earns another roll instead of passing the turn on.
    room.phase = 'await_roll';
    room.dice = 0;
    broadcast(room);
    scheduleAI(room);
  } else {
    G.nextTurn(room);
    broadcast(room);
    scheduleAI(room);
  }
}

// ---- room lifecycle -------------------------------------------------------
function createRoom(ws, msg) {
  if (rooms.size >= MAX_ROOMS) return fail(ws, 'Server is at capacity, try again shortly');
  const room = G.newRoom(msg.stake);
  room.code = G.makeCode((c) => rooms.has(c));
  room.players.push({ ws, seat: 0, color: G.COLORS[0], name: sanitiseName(msg.name), ai: false, toks: [-1, -1, -1, -1], done: false });
  rooms.set(room.code, room);
  ws._room = room.code;

  send(ws, { t: 'joined', code: room.code, seat: 0, host: true });
  broadcast(room);
}

function joinRoom(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return fail(ws, 'Room not found');
  if (room.phase !== 'lobby') return fail(ws, 'Game already started');
  if (room.players.filter((p) => !p.ai).length >= 4) return fail(ws, 'Room full');

  const seat = room.players.length;
  room.players.push({ ws, seat, color: G.COLORS[seat % 4], name: sanitiseName(msg.name), ai: false, toks: [-1, -1, -1, -1], done: false });
  room.lastActivity = Date.now();
  ws._room = room.code;

  send(ws, { t: 'joined', code: room.code, seat, host: seat === room.host });
  broadcast(room);
}

function handleMessage(ws, buf) {
  if (buf.length > MAX_PAYLOAD) return fail(ws, 'Message too large');

  let msg;
  try { msg = JSON.parse(buf.toString()); } catch (e) { return fail(ws, 'Malformed JSON'); }
  if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return fail(ws, 'Malformed message');

  if (msg.t === 'ping') return send(ws, { t: 'pong', ts: Date.now() });

  if (msg.t === 'create') {
    if (ws._room) return fail(ws, 'Already in a room');
    return createRoom(ws, msg);
  }
  if (msg.t === 'join') {
    if (ws._room) return fail(ws, 'Already in a room');
    return joinRoom(ws, msg);
  }

  const room = rooms.get(ws._room);
  if (!room) return fail(ws, 'Not in a room');
  const seat = G.seatOf(room, ws);
  if (seat < 0) return fail(ws, 'Not seated in this room');

  switch (msg.t) {
    case 'start':
      if (seat !== room.host) return fail(ws, 'Only the host can start');
      if (room.phase !== 'lobby') return fail(ws, 'Game already started');
      G.startGame(room, msg.fillAI !== false);
      if (!room.players.length) return;
      broadcast(room);
      scheduleAI(room);
      return;

    case 'roll':
      return doRoll(room, seat);

    case 'move': {
      const ti = Number(msg.ti);
      if (!Number.isInteger(ti) || ti < 0 || ti > 3) return fail(ws, 'Invalid token');
      return doMove(room, seat, ti);
    }

    case 'chat':
      return broadcastChat(room, room.players[seat].name, String(msg.text || '').slice(0, MAX_CHAT));

    default:
      return fail(ws, 'Unknown message type: ' + msg.t.slice(0, 24));
  }
}

function handleClose(ws) {
  const room = rooms.get(ws._room);
  if (!room) return;
  const seat = G.seatOf(room, ws);
  if (seat < 0) return;

  if (room.phase === 'lobby') {
    room.players.splice(seat, 1);
    // Re-seat and re-colour the survivors, and keep host pointing at a live seat.
    room.players.forEach((p, i) => { p.seat = i; p.color = G.COLORS[i]; });
    if (room.host >= room.players.length) room.host = 0;
  } else {
    // Hand the seat to the AI so the other players are not stuck.
    room.players[seat].ai = true;
    room.players[seat].ws = null;
  }
  room.lastActivity = Date.now();

  if (room.players.filter((p) => !p.ai).length === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room);
    scheduleAI(room);
  }
}

// ---- http + websocket -----------------------------------------------------
const startedAt = Date.now();

// ---- static client --------------------------------------------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  // Reject anything that escapes public/ after resolution.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('Forbidden');
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      rooms: rooms.size,
      connections: connectionCount,
      uptime: Math.round((Date.now() - startedAt) / 1000)
    }));
  }
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('Method not allowed');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });

wss.on('connection', (ws) => {
  if (connectionCount >= MAX_CONNECTIONS) { try { ws.close(1013, 'Server busy'); } catch (e) {} return; }
  connectionCount++;
  ws.isAlive = true;

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    try { handleMessage(ws, buf); } catch (error) {
      console.error('[axzora-ludo] handler error:', error && error.message);
      fail(ws, 'Internal error');
    }
  });
  ws.on('close', () => { connectionCount--; try { handleClose(ws); } catch (e) {} });
  ws.on('error', () => {});
});

// Drop sockets that stopped answering, so rooms do not fill with ghosts.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, HEARTBEAT_MS);

// Reap abandoned rooms.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const humans = room.players.filter((p) => !p.ai && p.ws).length;
    const idle = now - room.lastActivity;
    const limit = (room.phase === 'lobby' || humans === 0) ? LOBBY_IDLE_MS : GAME_IDLE_MS;
    if (idle > limit) {
      for (const p of room.players) { if (p.ws) { try { p.ws.close(1001, 'Room expired'); } catch (e) {} } }
      rooms.delete(code);
    }
  }
}, SWEEP_MS);

wss.on('close', () => { clearInterval(heartbeat); clearInterval(sweeper); });

function stop(callback) {
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const ws of wss.clients) { try { ws.close(1001, 'Server shutting down'); } catch (e) {} }
  try { wss.close(); } catch (e) {}
  server.close(() => { if (callback) callback(); });
}

const shutdown = () => {
  stop(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, HOST, () => console.log('[axzora-ludo] v' + VERSION + ' listening on ' + HOST + ':' + PORT));

module.exports = { server, wss, rooms, stop };
