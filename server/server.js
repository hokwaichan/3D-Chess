// Minimal relay for online games: pairs two players in a room and forwards
// their messages. Move legality is checked by each client, not here.
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const rooms = new Map(); // room code -> [{ ws, color }]

const send = (ws, message) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  let room = null;

  const opponent = () => rooms.get(room)?.find((p) => p.ws !== ws);

  ws.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === 'join' && !room) {
      const code = String(message.room ?? '').trim().slice(0, 32);
      if (!code) return send(ws, { type: 'error', text: 'Enter a room code.' });

      const players = rooms.get(code) ?? [];
      if (players.length >= 2) return send(ws, { type: 'full' });

      const color = players[0]?.color === 'w' ? 'b' : 'w';
      players.push({ ws, color });
      rooms.set(code, players);
      room = code;

      send(ws, { type: 'joined', color, opponent: players.length === 2 });
      if (players.length === 2) send(players[0].ws, { type: 'opponent-joined' });
    } else if (room && (message.type === 'move' || message.type === 'reset')) {
      const other = opponent();
      if (other) send(other.ws, message);
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const players = rooms.get(room).filter((p) => p.ws !== ws);
    if (players.length) {
      rooms.set(room, players);
      send(players[0].ws, { type: 'opponent-left' });
    } else {
      rooms.delete(room);
    }
  });
});

console.log(`Chess relay listening on ws://localhost:${PORT}`);
