const express  = require('express');
const { createServer } = require('node:http');
const { Server }       = require('socket.io');
const path     = require('node:path');

const app  = express();
const http = createServer(app);
const io   = new Server(http, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../frontend')));

const rooms             = new Map(); // code → { p1, p2, p1Name, p2Name }
const pendingActivities = new Map(); // instanceId → { socket, name }

function makeCode() {
    let code;
    do { code = Math.random().toString(36).slice(2, 5).toUpperCase(); }
    while (rooms.has(code));
    return code;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

io.on('connection', socket => {
    socket.data.roomCode          = null;
    socket.data.pendingInstanceId = null;

    socket.on('create-room', ({ name } = {}) => {
        const code = makeCode();
        rooms.set(code, { p1: socket.id, p2: null, p1Name: name || '' });
        socket.data.roomCode = code;
        socket.join(code);
        socket.emit('room-created', { code, role: 'p1' });
        console.log(`Room ${code} created by ${socket.id}`);
    });

    socket.on('join-room', ({ code, name } = {}) => {
        code = (code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room)    { socket.emit('room-error', 'Room not found'); return; }
        if (room.p2)  { socket.emit('room-error', 'Room is full');   return; }
        room.p2     = socket.id;
        room.p2Name = name || '';
        socket.data.roomCode = code;
        socket.join(code);
        socket.emit('room-joined', { code, role: 'p2' });
        io.to(code).emit('game-start', { code, p1Name: room.p1Name, p2Name: room.p2Name });
        console.log(`Room ${code}: ${room.p1} vs ${room.p2}`);
    });

    socket.on('join-activity', ({ instanceId, name } = {}) => {
        if (!instanceId) return;
        name = name || '';
        const pending = pendingActivities.get(instanceId);
        if (!pending) {
            pendingActivities.set(instanceId, { socket, name });
            socket.data.pendingInstanceId = instanceId;
            socket.emit('activity-waiting');
            return;
        }
        // Pair found — start immediately
        pendingActivities.delete(instanceId);
        const p1Socket = pending.socket;
        p1Socket.data.pendingInstanceId = null;
        const code = makeCode();
        rooms.set(code, { p1: p1Socket.id, p2: socket.id });
        p1Socket.data.roomCode = code;
        socket.data.roomCode   = code;
        p1Socket.join(code);
        socket.join(code);
        p1Socket.emit('game-start', { code, p1Name: pending.name, p2Name: name, role: 'p1' });
        socket.emit('game-start',   { code, p1Name: pending.name, p2Name: name, role: 'p2' });
        console.log(`Activity room ${code}: ${p1Socket.id} vs ${socket.id}`);
    });

    socket.on('move', data => {
        if (socket.data.roomCode) socket.to(socket.data.roomCode).emit('opponent-move', data);
    });

    socket.on('disconnect', () => {
        if (socket.data.pendingInstanceId) {
            pendingActivities.delete(socket.data.pendingInstanceId);
        }
        const code = socket.data.roomCode;
        if (!code) return;
        socket.to(code).emit('opponent-left');
        rooms.delete(code);
        console.log(`Room ${code} closed`);
    });
});

const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`CHORIDOR server on :${PORT}`));
