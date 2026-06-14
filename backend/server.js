const { randomInt } = require('node:crypto');
const express  = require('express');
const { createServer } = require('node:http');
const { Server }       = require('socket.io');
const path     = require('node:path');

const app  = express();
const http = createServer(app);
const io   = new Server(http, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, '../frontend'), {
    setHeaders(res, filePath) {
        if (/\.(html|js|css)$/.test(filePath)) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        }
    }
}));

// code -> { p1, p2, p1Name, p2Name, p1Avatar, p2Avatar, spectators, snapshot, rematchReady, instanceId }
const rooms             = new Map();
const pendingActivities = new Map(); // instanceId -> { socket, name, avatarUrl }
const activityRooms     = new Map(); // instanceId -> code (for spectator lookup)

function makeCode() {
    let code;
    do { code = Array.from({ length: 3 }, () => randomInt(36).toString(36)).join('').toUpperCase(); }
    while (rooms.has(code));
    return code;
}

function makeSnapshot() {
    return {
        walls: [],
        p1Pawn: { row: 8, col: 4 },
        p2Pawn: { row: 0, col: 4 },
        wallCounts: { p1: 10, p2: 10 },
        currentPlayer: 'p1',
        movesP1: 0,
        movesP2: 0,
    };
}

function applyMoveToSnapshot(snapshot, moverRole, data) {
    if (data.type === 'pawn') {
        if (moverRole === 'p1') { snapshot.p1Pawn = { row: data.row, col: data.col }; snapshot.movesP1++; }
        else                   { snapshot.p2Pawn = { row: data.row, col: data.col }; snapshot.movesP2++; }
    } else if (data.type === 'wall') {
        snapshot.walls.push({ row: data.row, col: data.col, orientation: data.orientation, owner: moverRole });
        snapshot.wallCounts[moverRole]--;
        if (moverRole === 'p1') snapshot.movesP1++; else snapshot.movesP2++;
    }
    snapshot.currentPlayer = moverRole === 'p1' ? 'p2' : 'p1';
}

function promoteSpectatorToPlayer(room, io, code, isP1) {
    let promoted = null;
    let promotedSocket = null;
    while (room.spectators.length > 0) {
        const candidate = room.spectators.shift();
        const sock = io.sockets.sockets.get(candidate.socketId);
        if (sock) { promoted = candidate; promotedSocket = sock; break; }
    }
    if (!promoted) return false;

    if (isP1) { room.p1 = promoted.socketId; room.p1Name = promoted.name; room.p1Avatar = promoted.avatarUrl; }
    else      { room.p2 = promoted.socketId; room.p2Name = promoted.name; room.p2Avatar = promoted.avatarUrl; }

    room.snapshot = makeSnapshot();

    promotedSocket.emit('become-player', {
        role:     isP1 ? 'p1' : 'p2',
        p1Name:   room.p1Name, p2Name:   room.p2Name,
        p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
    });

    const remainingSocket = io.sockets.sockets.get(isP1 ? room.p2 : room.p1);
    if (remainingSocket) {
        remainingSocket.emit('opponent-rejoined', { name: promoted.name, avatar: promoted.avatarUrl });
    }

    io.to(code).emit('spectator-count', room.spectators.length);
    console.log(`Room ${code}: spectator promoted to ${isP1 ? 'p1' : 'p2'}`);
    return true;
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
                redirect_uri:  process.env.DISCORD_REDIRECT_URI || 'https://1515199692793843712.discordsays.com/',
                code,
            }).toString(),
        });
        const token = await tokenRes.json();
        if (!token.access_token) return res.status(400).json({ error: `Token exchange failed: ${JSON.stringify(token)}` });

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const user = await userRes.json();
        const defaultIdx = Number(BigInt(user.id) >> 22n) % 6;
        const avatarUrl  = user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
            : `https://cdn.discordapp.com/embed/avatars/${defaultIdx}.png`;
        res.json({ username: user.global_name || user.username, handle: user.username, avatarUrl, access_token: token.access_token });
    } catch {
        res.status(500).json({ error: 'Auth failed' });
    }
});

io.on('connection', socket => {
    socket.data.roomCode          = null;
    socket.data.pendingInstanceId = null;
    socket.data.activityInstanceId = null;

    socket.on('create-room', ({ name } = {}) => {
        const code = makeCode();
        rooms.set(code, { p1: socket.id, p2: null, p1Name: name || '', p1Avatar: '', spectators: [], snapshot: null, rematchReady: null, instanceId: null });
        socket.data.roomCode = code;
        socket.join(code);
        socket.emit('room-created', { code, role: 'p1' });
        console.log(`Room ${code} created by ${socket.id}`);
    });

    socket.on('join-room', ({ code, name } = {}) => {
        code = (code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { socket.emit('room-error', 'Room not found'); return; }
        if (room.p2) {
            // Room full - join as spectator
            const queuePos = room.spectators.push({ socketId: socket.id, name: name || '', avatarUrl: '' });
            socket.data.roomCode = code;
            socket.join(code);
            socket.emit('spectate-start', {
                p1Name: room.p1Name, p2Name: room.p2Name,
                p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
                snapshot: room.snapshot,
                queuePosition: queuePos,
                spectatorCount: room.spectators.length,
            });
            io.to(code).emit('spectator-count', room.spectators.length);
            return;
        }
        room.p2     = socket.id;
        room.p2Name = name || '';
        room.snapshot = makeSnapshot();
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

        // Check if there is already a full room for this instance
        const existingCode = activityRooms.get(instanceId);
        if (existingCode) {
            const room = rooms.get(existingCode);
            if (room?.p1 && room?.p2) {
                const queuePos = room.spectators.push({ socketId: socket.id, name, avatarUrl });
                socket.data.roomCode = existingCode;
                socket.join(existingCode);
                socket.emit('spectate-start', {
                    p1Name: room.p1Name, p2Name: room.p2Name,
                    p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
                    snapshot: room.snapshot,
                    queuePosition: queuePos,
                    spectatorCount: room.spectators.length,
                });
                io.to(existingCode).emit('spectator-count', room.spectators.length);
                return;
            }
            activityRooms.delete(instanceId);
        }

        const pending = pendingActivities.get(instanceId);
        if (!pending) {
            pendingActivities.set(instanceId, { socket, name, avatarUrl });
            socket.data.pendingInstanceId = instanceId;
            socket.emit('activity-waiting');
            return;
        }
        // Pair found - start immediately
        pendingActivities.delete(instanceId);
        const p1Socket = pending.socket;
        p1Socket.data.pendingInstanceId = null;
        const code = makeCode();
        const snapshot = makeSnapshot();
        rooms.set(code, { p1: p1Socket.id, p2: socket.id, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, spectators: [], snapshot, rematchReady: null, instanceId });
        activityRooms.set(instanceId, code);
        p1Socket.data.roomCode          = code;
        socket.data.roomCode            = code;
        p1Socket.data.activityInstanceId = instanceId;
        socket.data.activityInstanceId  = instanceId;
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
        if (room.p1 !== socket.id && room.p2 !== socket.id) return; // spectators cannot request rematch
        if (!room.rematchReady) {
            room.rematchReady = socket.id;
            socket.to(code).emit('rematch-requested');
            return;
        }
        if (room.rematchReady === socket.id) return;
        // Both agreed - swap sides and restart
        room.rematchReady = null;
        room.snapshot = makeSnapshot();
        [room.p1,      room.p2     ] = [room.p2,      room.p1     ];
        [room.p1Name,  room.p2Name ] = [room.p2Name,  room.p1Name ];
        [room.p1Avatar,room.p2Avatar] = [room.p2Avatar,room.p1Avatar];
        io.to(code).emit('rematch-start', { p1Name: room.p1Name, p2Name: room.p2Name, p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '' });
    });

    socket.on('rematch-cancel', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (room?.rematchReady !== socket.id) return;
        room.rematchReady = null;
        socket.to(code).emit('rematch-cancelled');
    });

    socket.on('move', data => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;
        if (room.snapshot) {
            const moverRole = room.p1 === socket.id ? 'p1' : 'p2';
            applyMoveToSnapshot(room.snapshot, moverRole, data);
        }
        socket.to(code).emit('opponent-move', data);
    });

    socket.on('disconnect', () => {
        if (socket.data.pendingInstanceId) {
            pendingActivities.delete(socket.data.pendingInstanceId);
        }
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;

        const isP1 = room.p1 === socket.id;
        const isP2 = room.p2 === socket.id;

        if (!isP1 && !isP2) {
            room.spectators = room.spectators.filter(s => s.socketId !== socket.id);
            io.to(code).emit('spectator-count', room.spectators.length);
            return;
        }

        if (!promoteSpectatorToPlayer(room, io, code, isP1)) {
            socket.to(code).emit('opponent-left');
            if (room.instanceId) activityRooms.delete(room.instanceId);
            rooms.delete(code);
            console.log(`Room ${code} closed`);
        }
    });
});

const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`CHORIDOR server on :${PORT}`));
