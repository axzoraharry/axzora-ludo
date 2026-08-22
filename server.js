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
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;

// ---- Ludo board (same geometry as the AxzoraOS client) -------------------
const PATH = [
  [6,1],[6,2],[6,3],[6,4],[6,5],[5,6],[4,6],[3,6],[2,6],[1,6],[0,6],[0,7],
  [0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[6,9],[6,10],[6,11],[6,12],[6,13],[6,14],
  [7,14],[8,14],[8,13],[8,12],[8,11],[8,10],[8,9],[9,8],[10,8],[11,8],[12,8],
  [13,8],[14,8],[14,7],[14,6],[13,6],[12,6],[11,6],[10,6],[9,6],[8,5],[8,4],
  [8,3],[8,2],[8,1],[8,0],[7,0],[6,0]
];
const SAFE = new Set([0,8,13,21,26,34,39,47]);
const COLORS = ['r','g','y','b'];
const ENTRY  = [0,13,26,39];

const rooms = new Map();               // code -> room
const code4 = () => { let c=''; for(let i=0;i<4;i++) c+='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]; return rooms.has(c)?code4():c; };

function newRoom(stake) {
  return { code: code4(), players: [], turn: 0, dice: 0, phase: 'lobby',
           rolledSix: false, winner: -1, host: 0, stake: stake|0, pot: 0 };
}
function seatOf(room, ws) { return room.players.findIndex(p => p.ws === ws); }

// ---- rules ---------------------------------------------------------------
function canMove(p, prog, dice) {
  if (prog >= 56) return false;
  if (prog < 0) return dice === 6;
  return prog + dice <= 56;
}
function movable(room, seat) {
  const p = room.players[seat];
  return p.toks.map((_,i)=>i).filter(i => canMove(p, p.toks[i], room.dice));
}
function loopCellIndex(seat, prog) { return (ENTRY[seat] + prog) % 52; }

function applyMove(room, seat, ti) {
  const p = room.players[seat];
  let prog = p.toks[ti];
  prog = prog < 0 ? 0 : prog + diceClamp(room.dice);
  p.toks[ti] = prog;
  // capture on a non-safe main-loop cell
  if (prog <= 50) {
    const idx = loopCellIndex(seat, prog);
    if (!SAFE.has(idx)) {
      const [r,c] = PATH[idx];
      room.players.forEach((op,oj) => { if (oj===seat) return;
        op.toks.forEach((op2,oti) => { if (op2>=0 && op2<=50) {
          const [orr,occ] = PATH[loopCellIndex(oj, op2)];
          if (orr===r && occ===c) op.toks[oti] = -1;   // sent home
        }});
      });
    }
  }
}
function diceClamp(d){ return d; }

function nextTurn(room) {
  room.rolledSix = false; room.dice = 0; room.phase = 'await_roll';
  do { room.turn = (room.turn + 1) % room.players.length; }
  while (room.players[room.turn] && room.players[room.turn].done);
  scheduleAI(room);
}

function checkWin(room, seat) {
  const p = room.players[seat];
  if (p.toks.every(t => t >= 56)) { p.done = true; room.winner = seat; room.phase = 'over'; return true; }
  return false;
}

// ---- turn actions --------------------------------------------------------
function doRoll(room, seat) {
  if (room.phase !== 'await_roll' || room.turn !== seat) return;
  room.dice = 1 + Math.floor(Math.random()*6);
  room.rolledSix = (room.dice === 6);
  const moves = movable(room, seat);
  if (moves.length === 0) { broadcast(room); setTimeout(()=>{ nextTurn(room); broadcast(room); }, 700); return; }
  room.phase = 'await_move';
  broadcast(room);
  if (room.players[seat].ai) setTimeout(()=>doMove(room, seat, aiPick(room, seat, moves)), 550);
}
function doMove(room, seat, ti) {
  if (room.phase !== 'await_move' || room.turn !== seat) return;
  if (!movable(room, seat).includes(ti)) return;
  applyMove(room, seat, ti);
  if (checkWin(room, seat)) { broadcast(room); return; }
  if (room.rolledSix) { room.phase = 'await_roll'; broadcast(room);
    if (room.players[seat].ai) setTimeout(()=>doRoll(room, seat), 500);
  } else { nextTurn(room); broadcast(room); }
}
function aiPick(room, seat, moves) {
  const p = room.players[seat];
  let best = moves[0], score = -1;
  for (const i of moves) {
    let sc = p.toks[i];
    const np = p.toks[i] < 0 ? 0 : p.toks[i] + room.dice;
    if (np <= 50) { const [r,c] = PATH[loopCellIndex(seat, np)];
      const idx = loopCellIndex(seat, np);
      if (!SAFE.has(idx) && room.players.some((op,oj)=>oj!==seat && op.toks.some((t,ti)=>t>=0&&t<=50&&PATH[loopCellIndex(oj,t)][0]===r&&PATH[loopCellIndex(oj,t)][1]===c))) sc += 100; }
    if (p.toks[i] < 0) sc += 20;
    if (sc > score) { score = sc; best = i; }
  }
  return best;
}
function scheduleAI(room) {
  const p = room.players[room.turn];
  if (p && p.ai && room.phase === 'await_roll') setTimeout(()=>doRoll(room, room.turn), 600);
}

function startGame(room, fillAI) {
  if (fillAI) while (room.players.length < 4)
    room.players.push({ ws:null, name:'CPU '+(room.players.length), ai:true, toks:[-1,-1,-1,-1], done:false });
  room.players.forEach((p,i) => { p.seat = i; p.color = COLORS[i]; p.toks = [-1,-1,-1,-1]; p.done = false; });
  room.pot = room.stake * room.players.length;
  room.turn = 0; room.phase = 'await_roll'; room.winner = -1;
  broadcast(room); scheduleAI(room);
}

// ---- networking ----------------------------------------------------------
function view(room) {
  return { t:'state', code:room.code, phase:room.phase, turn:room.turn, dice:room.dice,
    winner:room.winner, stake:room.stake, pot:room.pot,
    players: room.players.map(p => ({ seat:p.seat, name:p.name, color:p.color, ai:!!p.ai,
      toks:p.toks, done:!!p.done })) };
}
function broadcast(room) {
  const msg = JSON.stringify(view(room));
  room.players.forEach(p => { if (p.ws && p.ws.readyState === 1) { try { p.ws.send(msg); } catch(e){} } });
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch(e){} }

const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"ok":true,"rooms":'+rooms.size+'}'); }
  res.writeHead(200, {'content-type':'text/plain'});
  res.end('Axzora Ludo server — connect over WebSocket. rooms='+rooms.size);
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch(e){ return; }
    if (m.t === 'create') {
      const room = newRoom(m.stake); room.players.push({ ws, name:(m.name||'Player').slice(0,16), ai:false, toks:[-1,-1,-1,-1], done:false });
      rooms.set(room.code, room); ws._room = room.code;
      send(ws, { t:'joined', code:room.code, seat:0, host:true }); broadcast(room); return;
    }
    if (m.t === 'join') {
      const room = rooms.get((m.code||'').toUpperCase());
      if (!room) return send(ws, { t:'error', msg:'Room not found' });
      if (room.phase !== 'lobby') return send(ws, { t:'error', msg:'Game already started' });
      if (room.players.filter(p=>!p.ai).length >= 4) return send(ws, { t:'error', msg:'Room full' });
      const seat = room.players.length;
      room.players.push({ ws, name:(m.name||'Player').slice(0,16), ai:false, toks:[-1,-1,-1,-1], done:false });
      ws._room = room.code;
      send(ws, { t:'joined', code:room.code, seat, host:false }); broadcast(room); return;
    }
    const room = rooms.get(ws._room); if (!room) return;
    const seat = seatOf(room, ws); if (seat < 0) return;
    if (m.t === 'start' && seat === room.host && room.phase === 'lobby') startGame(room, m.fillAI !== false);
    else if (m.t === 'roll') doRoll(room, seat);
    else if (m.t === 'move') doMove(room, seat, m.ti|0);
    else if (m.t === 'chat') broadcast_chat(room, room.players[seat].name, String(m.text||'').slice(0,140));
  });
  ws.on('close', () => {
    const room = rooms.get(ws._room); if (!room) return;
    const seat = seatOf(room, ws);
    if (seat >= 0) {
      if (room.phase === 'lobby') { room.players.splice(seat,1); room.players.forEach((p,i)=>p.seat=i); }
      else { room.players[seat].ai = true; room.players[seat].ws = null; } // hand the seat to AI
      if (room.players.filter(p=>!p.ai).length === 0) rooms.delete(room.code); else broadcast(room);
    }
  });
});
function broadcast_chat(room, from, text) {
  const msg = JSON.stringify({ t:'chat', from, text });
  room.players.forEach(p => { if (p.ws && p.ws.readyState===1) { try{p.ws.send(msg);}catch(e){} } });
}

server.listen(PORT, () => console.log('[axzora-ludo] listening on :' + PORT));
