# Axzora Ludo Server

Original MIT-licensed real-time multiplayer Ludo server for AxzoraOS.
The **server is authoritative**: it owns the board, the dice and every rule, so a
modified client cannot cheat. Players create a room, share a 4-character code,
and empty seats can be filled by AI so a solo player can still start.

- **Rules & protocol:** `game.js` (pure rules, no sockets) + `server.js` (rooms, WebSockets)
- **Tests:** 17 tests, no network flakiness — `npm test`
- **Deploy:** `render.yaml` included (Render free plan, `/health` check)
- **Client:** `public/index.html` — open it in any browser to play

## Run it

```bash
npm ci
npm start                 # http://localhost:8080  (PORT / HOST env)
npm test                  # rules + full-game protocol tests
npm run smoke             # post-deploy check against a running server
npm run smoke -- https://axzora-ludo.onrender.com
```

Then open <http://localhost:8080/> and press **Create room**. On another
device open `http://<lan-ip>:8080/`, type the code, press **Join**.

## Protocol

Connect with a WebSocket to the same host. Client → server:

| Message | Purpose |
|---|---|
| `{"t":"create","name":"Asha","stake":10}` | New room; you become seat 0 and host. Reply `{"t":"joined","code":"J2HW","seat":0,"host":true}` |
| `{"t":"join","code":"J2HW","name":"Ravi"}` | Join an existing lobby. Reply `joined` with your seat |
| `{"t":"start","fillAI":true}` | Host only. Pads the room to 4 players with CPU seats |
| `{"t":"roll"}` | Roll the dice on your turn |
| `{"t":"move","ti":2}` | Move token index `0..3` |
| `{"t":"chat","text":"hi"}` | 140-character chat, broadcast to the room |
| `{"t":"ping"}` | Keep-alive; reply `{"t":"pong","ts":…}` |

Server → client: `state` (full snapshot, sent after every change), `joined`,
`chat`, `pong`, `error` (`{"t":"error","msg":"…"}`).

A `state` snapshot:

```json
{"t":"state","code":"J2HW","phase":"await_move","turn":1,"dice":6,
 "winner":-1,"stake":10,"pot":40,
 "players":[{"seat":0,"name":"Asha","color":"r","ai":false,
             "toks":[-1,-1,-1,-1],"done":false}, …]}
```

`phase` is `lobby` → `await_roll` ↔ `await_move` → `over`.

## Rules as implemented

- Board is the standard 15×15 cross flattened to **52 main-loop cells**; each
  seat enters 13 cells apart (`ENTRY = [0, 13, 26, 39]`).
- Token progress: `-1` = yard, `0` = own start cell, `51` = last loop cell,
  `52..56` = home column, `56` = home.
- Leaving the yard requires a **6**. Overshooting home is not allowed
  (`prog + dice <= 56`), so a token at 54 cannot move on a 6.
- Rolling a 6 grants **another roll** rather than passing the turn.
- A token landing on an occupied **non-safe** loop cell sends every enemy token
  on that cell back to the yard. Safe cells (`SAFE`) and the home column can
  never be captured.
- A seat with all four tokens home wins; the game then stops (`phase: "over"`).
- Disconnecting mid-game hands the seat to the AI instead of freezing the table;
  a room with no human players left is deleted.

## Operational limits

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `HOST` | `0.0.0.0` | Bind address |
| `MAX_ROOMS` | `500` | Refuse new rooms past this |
| `MAX_CONNECTIONS` | `2000` | Refuse new sockets past this |

- Messages are capped at **2 KB**; anything larger is rejected before parsing.
- Sockets are pinged every 30 s and terminated when they stop answering.
- Lobby rooms are dropped after 15 minutes idle, running games after 1 hour.
- Only `/health` and a plain-text banner answer HTTP; there is no JSON API.

## Happy Paisa

`stake` and `pot` are carried as **room metadata only**. The server never signs,
holds or moves funds; settlement is confirmed by the AxzoraOS wallet after the
winner is known. Treat `code` + `winner` as the claim ticket.

## License

MIT — see `LICENSE`.
