/**
 * End-to-end protocol tests: a real HTTP + WebSocket server, real clients,
 * a full 4-player game played to a winner. Run with `npm test`.
 *
 * The server auto-listens on require, so PORT=0 (an ephemeral port) is set
 * before the module is loaded.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const G = require('../game');

process.env.PORT = '0';
const app = require('../server');

const baseUrl = () => 'http://127.0.0.1:' + app.server.address().port;
const wsUrl = () => 'ws://127.0.0.1:' + app.server.address().port;

async function connect() {
  const ws = new WebSocket(wsUrl());
  await once(ws, 'open');
  const inbox = [];
  const waiters = [];
  ws.on('message', (buf) => {
    const msg = JSON.parse(buf.toString());
    // Hand the message straight to a waiting assertion; otherwise queue it. A
    // message must never do both, or assertions see it twice.
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) { const [w] = waiters.splice(i, 1); w.resolve(msg); return; }
    inbox.push(msg);
  });
  const api = {
    ws,
    inbox,
    /** Resolve with the next message satisfying `match` (also checks the inbox). */
    next(match, timeout = 3000) {
      const found = inbox.find(match);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) { waiters.splice(i, 1); reject(new Error('timeout waiting for message')); }
        }, timeout).unref();
      });
    },
    state(predicate = () => true, timeout) {
      return api.next((m) => m.t === 'state' && predicate(m), timeout);
    },
    send(obj) { ws.send(JSON.stringify(obj)); },
    /** Drop queued messages so the next wait sees only fresh state. */
    drain() { inbox.length = 0; },
    close() { try { ws.close(); } catch (e) {} }
  };
  return api;
}

test.after(() => app.stop());

/** Wait until the room state actually changes after an action. */
async function waitAdvance(client, prev) {
  for (let i = 0; i < 20; i++) {
    const m = await client.state(() => true, 5000);
    if (m.phase !== 'lobby' && (m.phase !== prev.phase || m.turn !== prev.turn || m.dice !== prev.dice)) return m;
  }
  throw new Error('room state did not advance');
}

test('GET /health reports rooms and uptime', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get(baseUrl() + '/health', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data) }));
    }).on('error', reject);
  });
  assert.equal(body.status, 200);
  assert.equal(body.json.ok, true);
  assert.equal(typeof body.json.version, 'string');
  assert.ok(body.json.uptime >= 0);
});

test('create -> join -> start -> a full game reaches a winner', async () => {
  const host = await connect();
  host.send({ t: 'create', name: '<b>Host</b>', stake: 10 });
  const joined = await host.next((m) => m.t === 'joined');
  assert.equal(joined.seat, 0);
  assert.equal(joined.host, true);
  assert.match(joined.code, /^[A-HJ-NP-Z2-9]{4}$/);

  const lobby = await host.state();
  assert.equal(lobby.phase, 'lobby');
  assert.equal(lobby.stake, 10);
  assert.equal(lobby.players[0].name, 'bHost/b', 'angle brackets are stripped');

  const guests = [];
  for (let i = 0; i < 3; i++) {
    const g = await connect();
    guests.push(g);
    g.send({ t: 'join', code: joined.code.toLowerCase(), name: 'G' + i });
    const ok = await g.next((m) => m.t === 'joined');
    assert.equal(ok.seat, i + 1);
    assert.equal(ok.host, false);
  }

  // A fifth player is rejected.
  const extra = await connect();
  extra.send({ t: 'join', code: joined.code, name: 'late' });
  const err = await extra.next((m) => m.t === 'error');
  assert.match(err.msg, /full/i);
  extra.close();

  // Only the host may start.
  guests[0].send({ t: 'start' });
  const notHost = await guests[0].next((m) => m.t === 'error');
  assert.match(notHost.msg, /host/i);

  host.send({ t: 'start', fillAI: false });
  let st = await host.state((m) => m.phase === 'await_roll');
  assert.equal(st.players.length, 4);
  assert.equal(st.pot, 40);
  assert.equal(st.turn, 0);

  // Play the whole game: whoever is on turn rolls, then moves if allowed.
  const clients = [host, ...guests];
  let over = null;
  for (let guard = 0; guard < 5000 && !over; guard++) {
    const current = st.turn;
    const client = clients[current];
    client.drain();
    if (st.phase === 'await_roll') {
      client.send({ t: 'roll' });
    } else if (st.phase === 'await_move') {
      const player = st.players[current];
      const legal = player.toks
        .map((prog, i) => ({ prog, i }))
        .filter(({ prog }) => G.canMove({}, prog, st.dice))
        .map(({ i }) => i);
      assert.ok(legal.length > 0, 'phase await_move must have at least one legal token');
      client.send({ t: 'move', ti: legal[0] });
    } else {
      break;
    }
    st = await waitAdvance(host, st);
    if (st.phase === 'over') over = st;
  }

  assert.ok(over, 'the game finished');
  assert.ok(over.winner >= 0, 'there is a winner');
  assert.equal(over.players[over.winner].toks.every((t) => t >= 56), true);

  clients.forEach((c) => c.close());
});

test('malformed input is rejected without killing the connection', async () => {
  const client = await connect();
  client.send({ t: 'join', code: 'ZZZZ' });
  assert.match((await client.next((m) => m.t === 'error')).msg, /not found/i);

  client.ws.send('not json');
  assert.match((await client.next((m) => m.t === 'error')).msg, /JSON/i);

  client.send({ t: 'nonsense' });
  assert.match((await client.next((m) => m.t === 'error')).msg, /not in a room/i);

  client.send({ t: 'ping' });
  assert.equal((await client.next((m) => m.t === 'pong')).t, 'pong');

  client.close();
});

test('a player leaving the lobby empties the room; leaving mid-game hands the seat to the AI', async () => {
  const a = await connect();
  a.send({ t: 'create', name: 'A' });
  const { code } = await a.next((m) => m.t === 'joined');

  const b = await connect();
  b.send({ t: 'join', code, name: 'B' });
  await b.next((m) => m.t === 'joined');

  b.close();
  const afterLeave = await a.state((m) => m.players.length === 1);
  assert.equal(afterLeave.players.length, 1, 'lobby seat is freed immediately');

  a.send({ t: 'start', fillAI: true });
  let st = await a.state((m) => m.phase === 'await_roll');
  assert.equal(st.players.length, 4, 'AI fills the empty seats');

  a.close();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(app.rooms.has(code), false, 'room with no humans left is deleted');
});
