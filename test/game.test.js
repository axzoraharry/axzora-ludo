/**
 * Rules tests — no sockets, no timing. Run with `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../game');

function room4() {
  const room = G.newRoom(0);
  room.code = 'TEST';
  G.startGame(room, true);
  return room;
}

test('board: 52 unique main-loop cells, one per square', () => {
  assert.equal(G.PATH.length, 52);
  const seen = new Set(G.PATH.map(([r, c]) => r + ',' + c));
  assert.equal(seen.size, 52, 'no duplicate cells');
  for (const [r, c] of G.PATH) {
    assert.ok(r >= 0 && r <= 14 && c >= 0 && c <= 14, `cell ${r},${c} inside the 15x15 board`);
  }
});

test('safe cells are a subset of the loop and every arm entry is safe', () => {
  for (const idx of G.SAFE) assert.ok(idx >= 0 && idx < 52);
  for (const entry of G.ENTRY) assert.ok(G.SAFE.has(entry), `entry ${entry} is safe`);
  assert.equal(G.ENTRY.length, 4);
});

test('canMove: yard needs a six, overshooting home is illegal, home is terminal', () => {
  assert.equal(G.canMove({}, -1, 6), true);
  assert.equal(G.canMove({}, -1, 5), false);
  assert.equal(G.canMove({}, 50, 6), true);    // exactly 56 = home
  assert.equal(G.canMove({}, 51, 6), false);   // 57 overshoots
  assert.equal(G.canMove({}, 56, 6), false);   // already home
  assert.equal(G.canMove({}, 3, 0), false);    // no dice value 0
});

test('movable lists only legal tokens', () => {
  const room = room4();
  room.players[0].toks = [-1, 10, 54, 56];
  room.dice = 6;
  // token 0 leaves the yard, token 1 advances 10 -> 16, token 2 would overshoot
  // home (54 + 6), token 3 is already home.
  assert.deepEqual(G.movable(room, 0), [0, 1]);
});

test('loopCellIndex wraps around the 52-cell loop from each seat entry', () => {
  assert.equal(G.loopCellIndex(0, 0), 0);
  assert.equal(G.loopCellIndex(1, 0), 13);
  assert.equal(G.loopCellIndex(3, 51), (39 + 51) % 52);
});

test('applyMove captures an enemy on an unsafe cell and sends it home', () => {
  const room = room4();
  room.dice = 3;
  // Seat 0 at progress 0 -> cell 0 (safe). Pick progress that is unsafe: 1.
  room.players[0].toks = [1, -1, -1, -1];
  // Seat 1 wants to land on seat 0's cell: seat0 prog1 => cell 1.
  // seat1 entry 13, so prog = (1 - 13 + 52) % 52 = 40
  room.players[1].toks = [37, -1, -1, -1];   // 37 + 3 = 40 -> (13+40)%52 = 1
  assert.ok(!G.SAFE.has(1));
  const res = G.applyMove(room, 1, 0);
  assert.equal(res.captured, 1);
  assert.equal(room.players[1].toks[0], 40);
  assert.equal(room.players[0].toks[0], -1, 'victim sent back to the yard');
});

test('applyMove never captures on a safe cell', () => {
  const room = room4();
  room.dice = 2;
  room.players[0].toks = [0, -1, -1, -1];   // cell 0, safe
  // Land seat 1 on cell 0 (a safe cell): (13 + prog + 2) % 52 === 0 => prog = 37
  room.players[1].toks = [37, -1, -1, -1];
  const res = G.applyMove(room, 1, 0);
  assert.equal(res.captured, 0);
  assert.equal(room.players[0].toks[0], 0, 'token on a safe cell survives');
});

test('a token that reaches exactly 56 is home and the seat wins', () => {
  const room = room4();
  room.dice = 2;
  room.players[0].toks = [54, 56, 56, 56];
  const res = G.applyMove(room, 0, 0);
  assert.equal(res.finished, true);
  assert.equal(room.players[0].toks[0], 56);
  assert.equal(G.checkWin(room, 0), true);
  assert.equal(room.winner, 0);
  assert.equal(room.phase, 'over');
});

test('nextTurn skips finished seats and never loops forever', () => {
  const room = room4();
  room.players[1].done = true;
  room.turn = 0;
  assert.equal(G.nextTurn(room), true);
  assert.equal(room.turn, 2);
  assert.equal(room.dice, 0);
  assert.equal(room.phase, 'await_roll');

  room.players.forEach((p) => { p.done = true; });
  assert.equal(G.nextTurn(room), false);
  assert.equal(room.phase, 'over');
});

test('aiPick prefers a capture over a plain advance', () => {
  const room = room4();
  room.dice = 1;
  room.players[0].toks = [5, 1, -1, -1];       // token 0 -> 6, token 1 -> 2
  room.players[1].toks = [6, -1, -1, -1];      // (13+6)%52 = 19 ...
  // Put an enemy exactly on the cell seat 0 reaches with token 1: prog 2 -> cell 2
  room.players[2].toks = [28, -1, -1, -1];     // (26+28)%52 = 2
  assert.ok(!G.SAFE.has(2));
  const choice = G.aiPick(room, 0, G.movable(room, 0));
  assert.equal(choice, 1, 'captures the token sitting on cell 2');
});

test('view() exposes state but never sockets', () => {
  const room = room4();
  room.players[0].ws = { secret: true };
  const snapshot = G.view(room);
  assert.equal(snapshot.t, 'state');
  assert.equal(snapshot.players.length, 4);
  assert.equal(snapshot.players[0].ws, undefined);
  assert.ok(!JSON.stringify(snapshot).includes('secret'));
});

test('makeCode uses an unambiguous 4-character alphabet', () => {
  for (let i = 0; i < 200; i++) {
    const code = G.makeCode();
    assert.equal(code.length, 4);
    assert.match(code, /^[A-HJ-NP-Z2-9]{4}$/);
  }
  const taken = new Set(['AAAA']);
  assert.notEqual(G.makeCode((c) => taken.has(c)), 'AAAA');
});

test('newRoom sanitises the stake', () => {
  assert.equal(G.newRoom(100).stake, 100);
  assert.equal(G.newRoom(-5).stake, 0);
  assert.equal(G.newRoom('abc').stake, 0);
  assert.equal(G.newRoom(1e12).stake, 1e12);
  assert.equal(G.newRoom(undefined).stake, 0);
});
