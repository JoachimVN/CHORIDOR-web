const express  = require('express');
const { createServer } = require('http');
const { Server }       = require('socket.io');
const path     = require('path');

const app  = express();
const http = createServer(app);
const io   = new Server(http, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../frontend')));

// roomCode -> { p1: socketId, p2: socketId | null }
const rooms = new Map();

function makeCode() {
    let code;
    do { code = Math.random().toString(36).slice(2, 5).toUpperCase(); }
    while (rooms.has(code));
    return code;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', socket => {
    let roomCode = null;
    let role     = null;

    socket.on('create-room', () => {
        const code = makeCode();
        rooms.set(code, { p1: socket.id, p2: null });
        roomCode = code;
        role     = 'p1';
        socket.join(code);
        socket.emit('room-created', { code, role: 'p1' });
        console.log(`Room ${code} created by ${socket.id}`);
    });

    socket.on('join-room', code => {
        code = (code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room)    { socket.emit('room-error', 'Room not found'); return; }
        if (room.p2)  { socket.emit('room-error', 'Room is full');   return; }
        room.p2  = socket.id;
        roomCode = code;
        role     = 'p2';
        socket.join(code);
        socket.emit('room-joined', { code, role: 'p2' });
        io.to(code).emit('game-start', { code });
        console.log(`Room ${code}: ${room.p1} vs ${room.p2}`);
    });

    // Relay moves — payload: { type: 'pawn'|'wall', ...move fields }
    socket.on('move', data => {
        if (roomCode) socket.to(roomCode).emit('opponent-move', data);
    });

    socket.on('disconnect', () => {
        if (!roomCode) return;
        socket.to(roomCode).emit('opponent-left');
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} closed`);
    });
});

const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`CHORIDOR server on :${PORT}`));
