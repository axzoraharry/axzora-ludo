/**
 * Axzora online Ludo — pure game rules.
 *
 * Kept free of networking so the rules can be tested without sockets: server.js
 * owns rooms and WebSockets, this file owns the board, the dice and the moves.
 * Everything here mutates the room object it is given and returns nothing
 * unless documented otherwise.
 *
 * The board is the standard 15x15 Ludo cross flattened to 52 main-loop cells.
 * Progress per token is -1 (still in the yard) .. 56 (home). 0 is the start
 * cell of the player's own arm; 51 is the last main-loop cell before the home
 * column, 52..56 are the five home-column cells.
 */

// ---- board geometry -------------------------------------------------------
const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],
  [13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],
  [8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
];

const SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const COLORS = ['r', 'g', 'y', 'b'];
const ENTRY = [0, 13, 26, 39];

const LOOP = PATH.length;      // 52
const HOME = 56;               // progress value of a token that has finished
const LAST_LOOP_PROG = 50;     // last progress that still sits on the main loop

// ---- room -----------------------------------------------------------------
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1

function makeCode(exists) {
  for (;;) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!exists || !exists(code)) return code;
  }
}

function newRoom(stake) {
  const s = Number(stake);
  return {
    code: '',
    players: [],
    turn: 0,
    dice: 0,
    phase: 'lobby',      // lobby | await_roll | await_move | over
    rolledSix: false,
    winner: -1,
    host: 0,
    stake: Number.isFinite(s) && s > 0 ? Math.floor(s) : 0,
    pot: 0,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
}

const seatOf = (room, ws) => room.players.findIndex(p => p.ws === ws);

// ---- rules ----------------------------------------------------------------
function canMove(player, prog, dice) {
  if (dice < 1 || dice > 6) return false;
  if (prog >= HOME) return false;          // already home
  if (prog < 0) return dice === 6;         // leaving the yard needs a six
  return prog + dice <= HOME;              // overshooting home is not allowed
}

/** Token indices the player is allowed to move with the current dice. */
function movable(room, seat) {
  const p = room.players[seat];
  if (!p) return [];
  return p.toks.map((_, i) => i).filter(i => canMove(p, p.toks[i], room.dice));
}

/** Main-loop cell of a seat's token, for progress 0..51. */
function loopCellIndex(seat, prog) {
  return (ENTRY[seat] + prog) % LOOP;
}

/**
 * Apply a move. Returns { captured: n, finished: bool } for the caller to log.
 */
function applyMove(room, seat, tokenIndex) {
  const p = room.players[seat];
  const dice = room.dice;
  let prog = p.toks[tokenIndex];
  prog = prog < 0 ? 0 : prog + dice;
  p.toks[tokenIndex] = prog;

  let captured = 0;
  // Captures only happen on the shared main loop; a token on a safe cell, or
  // one already in its home column (prog > 50), can never be taken.
  if (prog <= LAST_LOOP_PROG) {
    const idx = loopCellIndex(seat, prog);
    if (!SAFE.has(idx)) {
      const cell = PATH[idx];
      room.players.forEach((op, oj) => {
        if (oj === seat || !op) return;
        op.toks.forEach((opProg, oti) => {
          if (opProg < 0 || opProg > LAST_LOOP_PROG) return;
          const other = PATH[loopCellIndex(oj, opProg)];
          if (other[0] === cell[0] && other[1] === cell[1]) {
            op.toks[oti] = -1;
            captured++;
          }
        });
      });
    }
  }
  return { captured, finished: prog === HOME };
}

/** True when every token of that seat is home. */
function hasWon(room, seat) {
  const p = room.players[seat];
  return !!p && p.toks.every(t => t >= HOME);
}

function checkWin(room, seat) {
  if (!hasWon(room, seat)) return false;
  const p = room.players[seat];
  p.done = true;
  room.winner = seat;
  room.phase = 'over';
  room.lastActivity = Date.now();
  return true;
}

/**
 * Advance to the next seat that can still play. Returns false when nobody can,
 * which ends the game instead of looping forever.
 */
function nextTurn(room) {
  room.rolledSix = false;
  room.dice = 0;
  room.phase = 'await_roll';
  room.lastActivity = Date.now();

  const n = room.players.length;
  if (!n) return false;
  for (let step = 1; step <= n; step++) {
    const seat = (room.turn + step) % n;
    const p = room.players[seat];
    if (p && !p.done) { room.turn = seat; return true; }
  }
  room.phase = 'over';
  return false;
}

/** Seat index that should move next, or -1. */
function activeSeat(room) {
  return room.players.findIndex(p => p && !p.done);
}

/** Simple heuristic AI: prefer a capture, then leaving the yard, then progress. */
function aiPick(room, seat, moves) {
  if (!moves || !moves.length) return -1;
  const p = room.players[seat];
  let best = moves[0];
  let score = -Infinity;
  for (const i of moves) {
    const np = p.toks[i] < 0 ? 0 : p.toks[i] + room.dice;
    let sc = np;                                   // advance as far as possible
    if (p.toks[i] < 0) sc += 20;                   // freeing a token is good
    if (np >= HOME) sc += 60;                      // going home is better
    if (np <= LAST_LOOP_PROG) {
      const idx = loopCellIndex(seat, np);
      if (!SAFE.has(idx)) {
        const cell = PATH[idx];
        const hits = room.players.some((op, oj) => oj !== seat && op &&
          op.toks.some(t => t >= 0 && t <= LAST_LOOP_PROG &&
            PATH[loopCellIndex(oj, t)][0] === cell[0] &&
            PATH[loopCellIndex(oj, t)][1] === cell[1]));
        if (hits) sc += 100;                       // capture on offer
      }
    }
    if (sc > score) { score = sc; best = i; }
  }
  return best;
}

/** Seat a fresh game. `fillAI` pads the room with CPU opponents. */
function startGame(room, fillAI) {
  if (fillAI !== false) {
    while (room.players.length < 4) {
      room.players.push({
        ws: null,
        name: 'CPU ' + room.players.length,
        ai: true,
        toks: [-1, -1, -1, -1],
        done: false
      });
    }
  }
  room.players.forEach((p, i) => {
    p.seat = i;
    p.color = COLORS[i];
    p.toks = [-1, -1, -1, -1];
    p.done = false;
  });
  room.pot = room.stake * room.players.length;
  room.turn = 0;
  room.phase = 'await_roll';
  room.rolledSix = false;
  room.dice = 0;
  room.winner = -1;
  room.lastActivity = Date.now();
  return room;
}

/** Wire-safe snapshot of a room (never leaks sockets). */
function view(room) {
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    turn: room.turn,
    dice: room.dice,
    winner: room.winner,
    stake: room.stake,
    pot: room.pot,
    players: room.players.map((p, i) => ({
      // Lobby players are seated by position; an unfinished start leaves seat undefined.
      seat: typeof p.seat === 'number' ? p.seat : i,
      name: p.name,
      color: p.color,
      ai: !!p.ai,
      toks: p.toks,
      done: !!p.done
    }))
  };
}

module.exports = {
  PATH, SAFE, COLORS, ENTRY, LOOP, HOME, LAST_LOOP_PROG,
  makeCode, newRoom, seatOf,
  canMove, movable, loopCellIndex, applyMove, hasWon, checkWin,
  nextTurn, activeSeat, aiPick, startGame, view
};
