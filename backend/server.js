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

const rooms             = new Map(); // code → { p1, p2, p1Name, p2Name, p1Avatar, p2Avatar, rematchReady }
const pendingActivities = new Map(); // instanceId → { socket, name, avatarUrl }

function makeCode() {
    let code;
    do { code = Math.random().toString(36).slice(2, 5).toUpperCase(); }
    while (rooms.has(code));
    return code;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/auth/discord', express.json(), async (req, res) => {
    const { code } = req.body || {};
    if (!code) return res.status(400).json({ error: 'Missing code' });
    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id:     process.env.DISCORD_CLIENT_ID || '1515199692793843712',
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type:    'authorization_code',
                code,
            }).toString(),
        });
        const token = await tokenRes.json();
        if (!token.access_token) return res.status(400).json({ error: 'Token exchange failed' });

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const user = await userRes.json();
        const defaultIdx = Number(BigInt(user.id) >> 22n) % 6;
        const avatarUrl  = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
            : `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
        res.json({ username: user.global_name || user.username, avatarUrl });
    } catch {
        res.status(500).json({ error: 'Auth failed' });
    }
});

io.on('connection', socket => {
    socket.data.roomCode          = null;
    socket.data.pendingInstanceId = null;

    socket.on('create-room', ({ name } = {}) => {
        const code = makeCode();
        rooms.set(code, { p1: socket.id, p2: null, p1Name: name || '', p1Avatar: '' });
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
        io.to(code).emit('game-start', { code, p1Name: room.p1Name, p2Name: room.p2Name, p1Avatar: '', p2Avatar: '' });
        console.log(`Room ${code}: ${room.p1} vs ${room.p2}`);
    });

    socket.on('join-activity', ({ instanceId, name, avatarUrl } = {}) => {
        if (!instanceId) return;
        name      = name      || '';
        avatarUrl = avatarUrl || '';
        const pending = pendingActivities.get(instanceId);
        if (!pending) {
            pendingActivities.set(instanceId, { socket, name, avatarUrl });
            socket.data.pendingInstanceId = instanceId;
            socket.emit('activity-waiting');
            return;
        }
        // Pair found — start immediately
        pendingActivities.delete(instanceId);
        const p1Socket = pending.socket;
        p1Socket.data.pendingInstanceId = null;
        const code = makeCode();
        rooms.set(code, { p1: p1Socket.id, p2: socket.id, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl });
        p1Socket.data.roomCode = code;
        socket.data.roomCode   = code;
        p1Socket.join(code);
        socket.join(code);
        p1Socket.emit('game-start', { code, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, role: 'p1' });
        socket.emit('game-start',   { code, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, role: 'p2' });
        console.log(`Activity room ${code}: ${p1Socket.id} vs ${socket.id}`);
    });

    socket.on('rematch-request', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;
        if (!room.rematchReady) {
            room.rematchReady = socket.id;
            socket.to(code).emit('rematch-requested');
            return;
        }
        if (room.rematchReady === socket.id) return;
        // Both agreed — swap sides and restart
        room.rematchReady = null;
        [room.p1,      room.p2     ] = [room.p2,      room.p1     ];
        [room.p1Name,  room.p2Name ] = [room.p2Name,  room.p1Name ];
        [room.p1Avatar,room.p2Avatar] = [room.p2Avatar,room.p1Avatar];
        io.to(code).emit('rematch-start', { p1Name: room.p1Name, p2Name: room.p2Name, p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '' });
    });

    socket.on('rematch-cancel', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room || room.rematchReady !== socket.id) return;
        room.rematchReady = null;
        socket.to(code).emit('rematch-cancelled');
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
