#!/usr/bin/env node
/**
 * Post-deploy smoke test: create a room, join it, start a game and play six
 * turns against a *running* server (local or Render).
 *
 *   npm run smoke                          # http://127.0.0.1:8080
 *   npm run smoke -- https://host.onrender.com
 *
 * Exits 0 on success, 1 on failure — suitable as a Render post-deploy check.
 */
const WebSocket = require('ws');

const target = process.argv[2] || process.env.LUDO_URL || 'http://127.0.0.1:8080';
const httpUrl = target.replace(/^ws/, 'http').replace(/\/$/, '');
const wsUrl = httpUrl.replace(/^http/, 'ws');

const step = (label) => console.log('  · ' + label);

/** Connect and keep a permanent inbox so no broadcast is ever dropped. */
function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws._inbox = [];
    ws.on('message', (buf) => {
      try { ws._inbox.push(JSON.parse(buf.toString())); } catch (e) { /* ignore */ }
    });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

/** Resolve with the first queued message matching `match`, waiting if needed. */
function next(ws, match, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const poll = () => {
      const i = ws._inbox.findIndex(match);
      if (i >= 0) return resolve(ws._inbox.splice(i, 1)[0]);
      if (Date.now() > deadline) return reject(new Error('timed out waiting for a matching message'));
      setTimeout(poll, 25);
    };
    poll();
  });
}

const send = (ws, obj) => ws.send(JSON.stringify(obj));

const legalTokens = (state, seat) => state.players[seat].toks
  .map((prog, i) => ({ prog, i }))
  .filter(({ prog }) => (prog < 0 ? state.dice === 6 : prog + state.dice <= 56))
  .map(({ i }) => i);

(async () => {
  console.log('Axzora Ludo smoke test → ' + httpUrl);

  const health = await fetch(httpUrl + '/health').then((r) => r.json());
  step('health ok=' + health.ok + ' version=' + health.version + ' rooms=' + health.rooms);
  if (!health.ok) throw new Error('/health did not report ok');

  const host = await open();
  send(host, { t: 'create', name: 'smoke-host', stake: 5 });
  const joined = await next(host, (m) => m.t === 'joined');
  step('room created: ' + joined.code);

  const guest = await open();
  send(guest, { t: 'join', code: joined.code, name: 'smoke-guest' });
  const guestJoined = await next(guest, (m) => m.t === 'joined');
  step('second player seated at seat ' + guestJoined.seat);

  send(host, { t: 'start', fillAI: true });
  let state = await next(host, (m) => m.t === 'state' && m.phase === 'await_roll');
  step('game started with ' + state.players.length + ' players, pot ' + state.pot);

  // Drop states queued before the game started so the loop only sees fresh ones.
  host._inbox = host._inbox.filter((m) => m.t !== 'state');

  const clients = [host, guest];
  for (let turn = 0; turn < 12 && state.phase !== 'over'; turn++) {
    const seat = state.turn;
    const client = clients[seat];
    if (!client) {
      // AI seat: wait for it to play itself.
      state = await next(host, (m) => m.t === 'state' && (m.turn !== seat || m.phase === 'over'));
      continue;
    }
    if (state.phase === 'await_roll') {
      send(client, { t: 'roll' });
    } else if (state.phase === 'await_move') {
      send(client, { t: 'move', ti: legalTokens(state, seat)[0] });
    } else {
      break;
    }
    state = await next(host, (m) => m.t === 'state' && (m.turn !== seat || m.phase === 'over'));
  }
  step('played turns until phase=' + state.phase + ', dice=' + state.dice);
  if (state.phase === 'lobby') throw new Error('game never left the lobby');

  host.close();
  guest.close();
  console.log('Smoke test passed.');
  process.exit(0);
})().catch((error) => {
  console.error('Smoke test FAILED: ' + error.message);
  process.exit(1);
});
