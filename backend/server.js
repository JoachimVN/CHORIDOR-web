const { randomInt, createHmac, timingSafeEqual } = require('node:crypto');
const express  = require('express');
const { createServer } = require('node:http');
const { Server }       = require('socket.io');
const path     = require('node:path');
const analytics = require('./analytics');
const db        = require('./db');

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

// code -> { p1, p2, p1Name, p2Name, p1Avatar, p2Avatar, spectators, snapshot, rematchReady, instanceId,
//           p1Token, p2Token,
//           reconnect: null | { slot, token, timer, oldSocketId },
//           pendingPromotion: null | { spectator, slot, accepted: Set, needed: [id,id], remainingId, steppingAsideId } }
const rooms             = new Map();
const pendingActivities = new Map(); // instanceId -> { socket, name, avatarUrl }
const activityRooms     = new Map(); // instanceId -> code (for spectator lookup)

const RECONNECT_GRACE_MS = 12_000;

function makeToken() {
    return Array.from({ length: 16 }, () => randomInt(16).toString(16)).join('');
}

function makeCode() {
    let code;
    do { code = Array.from({ length: 3 }, () => randomInt(36).toString(36)).join('').toUpperCase(); }
    while (rooms.has(code));
    return code;
}

// --- Analytics helpers ---------------------------------------------------
// A "match" is one game played in a room. Each gets a fresh id so events from
// the same game correlate in PostHog. source distinguishes web vs Discord.
function beginMatch(room, source) {
    room.matchId   = makeToken();
    room.startedAt = Date.now();
    room.source    = source || room.source || 'unknown';
    room.completed = false;
    analytics.capture('game_started', { source: room.source }, room.matchId);
}

function finishMatch(room, reason, winnerRole) {
    if (!room?.matchId || room.completed) return;
    room.completed = true;
    // The snapshot is the server's authoritative game state (updated on every
    // relayed move), so derive move/wall counts from it rather than the client.
    const snap    = room.snapshot;
    const movesP1 = snap?.movesP1 ?? null;
    const movesP2 = snap?.movesP2 ?? null;
    analytics.capture('game_completed', {
        source:      room.source,
        reason,                       // 'reached-goal' | 'surrender'
        winner_role: winnerRole || null,
        duration_ms: room.startedAt ? Date.now() - room.startedAt : null,
        moves_p1:    movesP1,
        moves_p2:    movesP2,
        total_moves: (movesP1 != null && movesP2 != null) ? movesP1 + movesP2 : null,
        walls_used:  snap ? snap.walls.length : null,
    }, room.matchId);
}

// A started game that ended without a result (someone left and nobody could
// take their place). Guarded so completed games and never-started rooms skip.
function abandonMatch(room, reason) {
    if (!room?.matchId || room.completed) return;
    room.completed = true;
    analytics.capture('game_abandoned', {
        source:      room.source,
        reason,                       // 'closed'
        duration_ms: room.startedAt ? Date.now() - room.startedAt : null,
    }, room.matchId);
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

// Emit spectator promotion offers to remaining/staying player and first spectator.
// Returns false if no live spectators found.
function offerSpectatorPromotion(room, io, code, slot, steppingAsideId = null, steppingAsideName = null, steppingAsideAvatar = null) {
    let spectator = null;
    while (room.spectators.length > 0) {
        const candidate = room.spectators[0];
        if (io.sockets.sockets.get(candidate.socketId)) { spectator = candidate; break; }
        room.spectators.shift(); // stale socket, skip
    }
    if (!spectator) return false;

    const remainingId   = slot === 'p1' ? room.p2 : room.p1;
    const remainingName = slot === 'p1' ? room.p2Name : room.p1Name;

    room.pendingPromotion = {
        spectator,
        slot,
        accepted:             new Set([spectator.socketId]), // spectator pre-accepted
        needed:               [remainingId],                  // only remaining player must confirm
        remainingId,
        steppingAsideId:      steppingAsideId || null,
        steppingAsideName:    steppingAsideName || null,
        steppingAsideAvatar:  steppingAsideAvatar || null,
    };

    io.sockets.sockets.get(remainingId)
        ?.emit('spectator-offer', { name: spectator.name, avatarUrl: spectator.avatarUrl, opponentSteppingAside: !!steppingAsideId });
    io.sockets.sockets.get(spectator.socketId)
        ?.emit('spectator-slot-offer', { opponentName: remainingName });

    console.log(`Room ${code}: offered spectator promotion for ${slot}`);
    return true;
}

// Complete an accepted promotion: move spectator into slot, notify all parties.
function completePromotion(room, io, code) {
    const { spectator, slot, remainingId, steppingAsideId, steppingAsideName, steppingAsideAvatar } = room.pendingPromotion;
    room.pendingPromotion = null;
    room.rematchReady = null; // clear stale rematch state so the new player isn't auto-matched
    room.spectators = room.spectators.filter(s => s.socketId !== spectator.socketId);

    const newToken = makeToken();
    if (slot === 'p1') { room.p1 = spectator.socketId; room.p1Name = spectator.name; room.p1Avatar = spectator.avatarUrl; room.p1Token = newToken; }
    else               { room.p2 = spectator.socketId; room.p2Name = spectator.name; room.p2Avatar = spectator.avatarUrl; room.p2Token = newToken; }
    room.snapshot = makeSnapshot();

    if (steppingAsideId) {
        const stepSock = io.sockets.sockets.get(steppingAsideId);
        if (stepSock) {
            const queuePos = room.spectators.push({ socketId: steppingAsideId, name: steppingAsideName || '', avatarUrl: steppingAsideAvatar || '' });
            stepSock.emit('spectate-start', {
                p1Name:         room.p1Name,   p2Name:   room.p2Name,
                p1Avatar:       room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
                snapshot:       room.snapshot,
                queuePosition:  queuePos,
                spectatorCount: room.spectators.length,
                steppedAside:   true,
            });
        }
    }

    io.sockets.sockets.get(spectator.socketId)?.emit('become-player', {
        role:     slot,
        p1Name:   room.p1Name, p2Name:   room.p2Name,
        p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
        code,
        token:    newToken,
    });

    io.sockets.sockets.get(remainingId)?.emit('opponent-rejoined', { name: spectator.name, avatar: spectator.avatarUrl });

    // Reset the board for spectators who are still watching (stepping-aside player already got spectate-start)
    room.spectators.forEach(s => {
        if (s.socketId === steppingAsideId) return;
        io.sockets.sockets.get(s.socketId)?.emit('rematch-start', {
            p1Name: room.p1Name, p2Name: room.p2Name,
            p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
        });
    });

    broadcastQueuePositions(room);
    io.to(code).emit('spectator-count', room.spectators.length);
    console.log(`Room ${code}: spectator promoted to ${slot}`);
}

// Cancel a pending promotion and clean up.
function cancelPromotion(room, io, code) {
    if (!room.pendingPromotion) return;
    const { spectator, remainingId, steppingAsideId, slot } = room.pendingPromotion;
    room.pendingPromotion = null;

    io.sockets.sockets.get(spectator.socketId)?.emit('spectator-offer-cancelled');
    io.sockets.sockets.get(remainingId)?.emit('spectator-offer-cancelled');
    if (steppingAsideId) io.sockets.sockets.get(steppingAsideId)?.emit('step-aside-declined');

    return { slot, remainingId };
}

function closeRoom(room, code, notifySocketId) {
    abandonMatch(room, 'closed');
    if (room.reconnect) { clearTimeout(room.reconnect.timer); room.reconnect = null; }
    if (notifySocketId) io.sockets.sockets.get(notifySocketId)?.emit('opponent-left');
    if (room.instanceId) activityRooms.delete(room.instanceId);
    rooms.delete(code);
    console.log(`Room ${code} closed`);
}

// Start a fresh game between the first two live spectators; the rest keep watching.
function recycleSpectatorsIntoGame(room, code, live) {
    abandonMatch(room, 'closed');
    const [a, b] = live;
    room.spectators = live.slice(2);
    const p1Token = makeToken();
    const p2Token = makeToken();
    room.p1 = a.socketId; room.p1Name = a.name; room.p1Avatar = a.avatarUrl; room.p1Token = p1Token;
    room.p2 = b.socketId; room.p2Name = b.name; room.p2Avatar = b.avatarUrl; room.p2Token = p2Token;
    room.snapshot     = makeSnapshot();
    room.rematchReady = null;

    for (const [id, role, token] of [[a.socketId, 'p1', p1Token], [b.socketId, 'p2', p2Token]]) {
        const sock = io.sockets.sockets.get(id);
        if (!sock) continue;
        sock.data.roomCode           = code;
        sock.data.activityInstanceId = room.instanceId || null;
        sock.emit('become-player', {
            role,
            p1Name: room.p1Name,         p2Name:   room.p2Name,
            p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
            code, token,
        });
    }

    // Reset the boards of any spectators still watching.
    room.spectators.forEach(s => {
        io.sockets.sockets.get(s.socketId)?.emit('rematch-start', {
            p1Name: room.p1Name, p2Name: room.p2Name,
            p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
        });
    });
    broadcastQueuePositions(room);
    io.to(code).emit('spectator-count', room.spectators.length);
    beginMatch(room, room.source);
    console.log(`Room ${code}: recycled into a fresh game between two spectators`);
}

// A lone spectator is left: drop the room and park them in the activity's
// matchmaking queue so the next person to join the activity pairs with them.
function parkSpectatorInQueue(room, code, spec) {
    const instanceId = room.instanceId;
    room.spectators = room.spectators.filter(s => s.socketId !== spec.socketId);
    closeRoom(room, code, null); // deletes the room and the activityRooms mapping

    const sock = io.sockets.sockets.get(spec.socketId);
    if (!sock) return;
    sock.leave(code);
    sock.data.roomCode           = null;
    sock.data.activityInstanceId = null;
    sock.data.pendingInstanceId  = instanceId;
    pendingActivities.set(instanceId, { socket: sock, name: spec.name, avatarUrl: spec.avatarUrl });
    sock.emit('activity-waiting');
    console.log(`Room ${code}: lone spectator parked back in matchmaking`);
}

// The last player has left. Keep the activity alive for any spectators rather
// than deleting it out from under them; only close when nobody is left.
function recycleOrClose(room, code, notifySocketId) {
    if (room.reconnect) { clearTimeout(room.reconnect.timer); room.reconnect = null; }
    room.pendingPromotion = null;

    if (room.instanceId) {
        const live = room.spectators.filter(s => io.sockets.sockets.get(s.socketId));
        if (live.length >= 2) { recycleSpectatorsIntoGame(room, code, live); return; }
        if (live.length === 1) { parkSpectatorInQueue(room, code, live[0]); return; }
    }
    closeRoom(room, code, notifySocketId);
}

function broadcastQueuePositions(room) {
    room.spectators.forEach((s, idx) => {
        io.sockets.sockets.get(s.socketId)?.emit('queue-position', idx + 1);
    });
}

// Send an event to every live spectator of a room (players are excluded).
function notifySpectators(room, event, payload) {
    room.spectators.forEach(s => io.sockets.sockets.get(s.socketId)?.emit(event, payload));
}

function removeSpectator(room, code, socketId) {
    room.spectators = room.spectators.filter(s => s.socketId !== socketId);
    broadcastQueuePositions(room);
    io.to(code).emit('spectator-count', room.spectators.length);
}

function handleSpectatorDisconnect(room, code, socketId) {
    if (room.pendingPromotion?.spectator.socketId !== socketId) {
        removeSpectator(room, code, socketId);
        return;
    }
    // The offered spectator left — cancel and try the next one
    const { slot, remainingId } = room.pendingPromotion;
    cancelPromotion(room, io, code);
    removeSpectator(room, code, socketId);

    if (!offerSpectatorPromotion(room, io, code, slot)) {
        const slotEmpty = slot === 'p1' ? !room.p1 : !room.p2;
        if (slotEmpty) closeRoom(room, code, remainingId);
    }
}

function handlePlayerDisconnect(room, code, socket, isP1) {
    const slot        = isP1 ? 'p1' : 'p2';
    const remainingId = isP1 ? room.p2 : room.p1;

    // No active opponent to wait for — recycle for spectators or close (e.g. p2 never joined)
    if (!remainingId) {
        if (room.pendingPromotion) cancelPromotion(room, io, code);
        recycleOrClose(room, code, null);
        return;
    }

    // If a grace period is already running for the OTHER slot, both players are gone
    if (room.reconnect && room.reconnect.slot !== slot) {
        if (room.pendingPromotion) cancelPromotion(room, io, code);
        clearTimeout(room.reconnect.timer);
        room.reconnect = null;
        recycleOrClose(room, code, null);
        return;
    }

    // Duplicate disconnect for the same slot — ignore
    if (room.reconnect?.slot === slot) return;

    if (room.pendingPromotion) cancelPromotion(room, io, code);

    const token = isP1 ? room.p1Token : room.p2Token;
    const timer  = setTimeout(() => {
        room.reconnect = null;
        if (isP1) room.p1 = null; else room.p2 = null;
        const remId = isP1 ? room.p2 : room.p1;
        if (!offerSpectatorPromotion(room, io, code, slot)) {
            closeRoom(room, code, remId);
        }
    }, RECONNECT_GRACE_MS);

    room.reconnect = { slot, token, timer, oldSocketId: socket.id };

    io.sockets.sockets.get(remainingId)?.emit('opponent-reconnecting', { graceSecs: RECONNECT_GRACE_MS / 1000 });
    notifySpectators(room, 'spectator-player-disconnected', {
        name: isP1 ? room.p1Name : room.p2Name,
        graceSecs: RECONNECT_GRACE_MS / 1000,
    });
    console.log(`Room ${code}: ${slot} disconnected — grace period started`);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Short signed token so a client can mark its own per-user flags without us
// trusting a raw client-supplied id or re-hitting Discord on every write.
const AUTH_SECRET = process.env.AUTH_SIGNING_SECRET || '';
function signUserToken(id) {
    if (!AUTH_SECRET) return null;
    const sig = createHmac('sha256', AUTH_SECRET).update(String(id)).digest('hex');
    return `${id}.${sig}`;
}
function verifyUserToken(token) {
    if (!AUTH_SECRET || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const id  = token.slice(0, dot);
    const got = Buffer.from(token.slice(dot + 1), 'hex');
    const exp = createHmac('sha256', AUTH_SECRET).update(id).digest();
    return got.length === exp.length && timingSafeEqual(got, exp) ? id : null;
}

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
        const id = String(user.id);
        let htpSeen = false;
        try { await db.ensurePlayer(id); htpSeen = await db.getHtpSeen(id); }
        catch (err) { console.warn('DB htp lookup failed:', err.message); }
        res.json({ id, username: user.global_name || user.username, handle: user.username, avatarUrl, access_token: token.access_token, htpSeen, htpToken: signUserToken(id) });
    } catch {
        res.status(500).json({ error: 'Auth failed' });
    }
});

// Persist that this player has dismissed the tutorial, so it does not reappear
// on their next launch even when the Discord sandbox has wiped localStorage.
app.post('/htp-seen', express.json(), async (req, res) => {
    const id = verifyUserToken(req.body?.token);
    if (!id) return res.status(401).json({ error: 'Invalid token' });
    try { await db.markHtpSeen(id); res.json({ ok: true }); }
    catch (err) { console.warn('DB markHtpSeen failed:', err.message); res.status(500).json({ error: 'Save failed' }); }
});

io.on('connection', socket => {
    socket.data.roomCode          = null;
    socket.data.pendingInstanceId = null;
    socket.data.activityInstanceId = null;

    socket.on('create-room', ({ name } = {}) => {
        const code = makeCode();
        rooms.set(code, { p1: socket.id, p2: null, p1Name: name || '', p1Avatar: '', spectators: [], snapshot: null, rematchReady: null, instanceId: null, pendingPromotion: null, p1Token: null, p2Token: null, reconnect: null, source: 'web-private' });
        socket.data.roomCode = code;
        socket.join(code);
        socket.emit('room-created', { code, role: 'p1' });
        analytics.capture('room_created', { source: 'web-private' }, code);
        console.log(`Room ${code} created by ${socket.id}`);
    });

    socket.on('join-room', ({ code, name } = {}) => {
        code = (code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) { socket.emit('room-error', 'Room not found'); return; }
        // Already in this room (e.g. rejoin completed before manual join fires)
        if (socket.data.roomCode === code) return;
        // Treat a grace-period slot as occupied so the reconnecting player's spot is held
        const effectivelyFull = (room.p1 || room.reconnect?.slot === 'p1') &&
                                (room.p2 || room.reconnect?.slot === 'p2');
        if (effectivelyFull) {
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
            analytics.capture('spectator_joined', { source: room.source || 'web-private' }, code);
            return;
        }
        room.p2      = socket.id;
        room.p2Name  = name || '';
        room.snapshot = makeSnapshot();
        room.p1Token  = makeToken();
        room.p2Token  = makeToken();
        socket.data.roomCode = code;
        socket.join(code);
        socket.emit('room-joined', { code, role: 'p2' });
        beginMatch(room, room.source);
        io.to(code).emit('game-start', { code, matchId: room.matchId, p1Name: room.p1Name, p2Name: room.p2Name, p1Avatar: '', p2Avatar: '' });
        io.sockets.sockets.get(room.p1)?.emit('session-token', { token: room.p1Token, role: 'p1', code });
        socket.emit('session-token', { token: room.p2Token, role: 'p2', code });
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
            const activityFull = room && (room.p1 || room.reconnect?.slot === 'p1') &&
                                         (room.p2 || room.reconnect?.slot === 'p2');
            if (activityFull) {
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
                analytics.capture('spectator_joined', { source: 'discord' }, existingCode);
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
        const code     = makeCode();
        const snapshot = makeSnapshot();
        const p1Token  = makeToken();
        const p2Token  = makeToken();
        rooms.set(code, { p1: p1Socket.id, p2: socket.id, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, spectators: [], snapshot, rematchReady: null, instanceId, pendingPromotion: null, p1Token, p2Token, reconnect: null });
        activityRooms.set(instanceId, code);
        p1Socket.data.roomCode           = code;
        socket.data.roomCode             = code;
        p1Socket.data.activityInstanceId = instanceId;
        socket.data.activityInstanceId   = instanceId;
        p1Socket.join(code);
        socket.join(code);
        const room = rooms.get(code);
        beginMatch(room, 'discord');
        p1Socket.emit('game-start', { code, matchId: room.matchId, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, role: 'p1' });
        socket.emit('game-start',   { code, matchId: room.matchId, p1Name: pending.name, p2Name: name, p1Avatar: pending.avatarUrl, p2Avatar: avatarUrl, role: 'p2' });
        p1Socket.emit('session-token', { token: p1Token, role: 'p1', code });
        socket.emit('session-token',   { token: p2Token, role: 'p2', code });
        console.log(`Activity room ${code}: ${p1Socket.id} vs ${socket.id}`);
    });

    socket.on('surrender', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;
        const isP1 = room.p1 === socket.id;
        if (!isP1 && room.p2 !== socket.id) return;
        const winnerRole = isP1 ? 'p2' : 'p1';
        const winnerName = isP1 ? room.p2Name : room.p1Name;
        io.to(code).emit('game-surrendered', { winnerRole, winnerName });
        finishMatch(room, 'surrender', winnerRole);
    });

    // Natural win (pawn reached goal) is detected client-side, so the client
    // reports it. Both players may emit; finishMatch dedups via room.completed.
    socket.on('report-win', ({ winnerRole } = {}) => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;
        if (room.p1 !== socket.id && room.p2 !== socket.id) return; // players only
        finishMatch(room, 'reached-goal', winnerRole === 'p2' ? 'p2' : 'p1');
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
        [room.p1Token, room.p2Token] = [room.p2Token, room.p1Token];
        beginMatch(room, room.source);
        io.to(code).emit('rematch-start', { matchId: room.matchId, p1Name: room.p1Name, p2Name: room.p2Name, p1Avatar: room.p1Avatar || '', p2Avatar: room.p2Avatar || '' });
        io.sockets.sockets.get(room.p1)?.emit('session-token', { token: room.p1Token, role: 'p1', code });
        io.sockets.sockets.get(room.p2)?.emit('session-token', { token: room.p2Token, role: 'p2', code });
    });

    socket.on('rematch-cancel', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (room?.rematchReady !== socket.id) return;
        room.rematchReady = null;
        socket.to(code).emit('rematch-cancelled');
    });

    // Player wants to step aside for the first queued spectator (after game end).
    socket.on('step-aside', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room || room.pendingPromotion) return;

        const isP1 = room.p1 === socket.id;
        const isP2 = room.p2 === socket.id;
        if (!isP1 && !isP2) return;

        const slot        = isP1 ? 'p1' : 'p2';
        const stepName    = isP1 ? room.p1Name   : room.p2Name;
        const stepAvatar  = isP1 ? room.p1Avatar : room.p2Avatar;
        if (!offerSpectatorPromotion(room, io, code, slot, socket.id, stepName, stepAvatar)) return;

        socket.emit('step-aside-waiting');
    });

    // Accept a pending spectator promotion (used by both the remaining/staying player and the spectator).
    socket.on('accept-spectator', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room?.pendingPromotion) return;

        room.pendingPromotion.accepted.add(socket.id);
        const { accepted, needed } = room.pendingPromotion;

        if (needed.every(id => accepted.has(id))) {
            completePromotion(room, io, code);
        }
    });

    // Decline a pending spectator promotion.
    socket.on('decline-spectator', () => {
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room?.pendingPromotion) return;

        const { slot, spectator } = room.pendingPromotion;
        const isSpectatorDeclining = socket.id === spectator.socketId;
        cancelPromotion(room, io, code);

        // If the slot was vacated by a disconnect, try the next queued spectator
        const slotEmpty = slot === 'p1' ? !room.p1 : !room.p2;
        if (slotEmpty) {
            // Move the decliner to the back so the next spectator gets a chance
            if (isSpectatorDeclining) {
                const decliner = room.spectators.shift();
                if (decliner) room.spectators.push(decliner);
                broadcastQueuePositions(room);
            }
            const remainingId = slot === 'p1' ? room.p2 : room.p1;
            if (!offerSpectatorPromotion(room, io, code, slot)) {
                closeRoom(room, code, remainingId);
            }
        }
    });

    socket.on('rejoin-room', ({ code, role, token } = {}) => {
        code = (code || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room?.reconnect?.token || room.reconnect.slot !== role || room.reconnect.token !== token) {
            socket.emit('rejoin-failed');
            return;
        }

        const { timer, oldSocketId } = room.reconnect;
        clearTimeout(timer);
        room.reconnect = null;

        if (role === 'p1') room.p1 = socket.id;
        else               room.p2 = socket.id;

        // Keep rematchReady consistent if the rejoining player had voted for rematch
        if (room.rematchReady === oldSocketId) room.rematchReady = socket.id;

        socket.data.roomCode           = code;
        socket.data.activityInstanceId = room.instanceId || null;
        socket.join(code);

        socket.emit('rejoin-success', {
            role,
            matchId:   room.matchId,
            startedAt: room.startedAt,
            snapshot:  room.snapshot,
            p1Name:    room.p1Name,         p2Name:   room.p2Name,
            p1Avatar:  room.p1Avatar || '', p2Avatar: room.p2Avatar || '',
            code,
        });

        const remainingId = role === 'p1' ? room.p2 : room.p1;
        if (remainingId) io.sockets.sockets.get(remainingId)?.emit('opponent-reconnected');
        notifySpectators(room, 'spectator-player-reconnected', { name: role === 'p1' ? room.p1Name : room.p2Name });

        console.log(`Room ${code}: ${role} rejoined (was ${oldSocketId})`);
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
        if (socket.data.pendingInstanceId) pendingActivities.delete(socket.data.pendingInstanceId);
        const code = socket.data.roomCode;
        if (!code) return;
        const room = rooms.get(code);
        if (!room) return;

        const isP1 = room.p1 === socket.id;
        const isP2 = room.p2 === socket.id;

        if (!isP1 && !isP2) { handleSpectatorDisconnect(room, code, socket.id); return; }
        handlePlayerDisconnect(room, code, socket, isP1);
    });
});

db.init();
const PORT = process.env.PORT || 3001;
http.listen(PORT, () => console.log(`CHORIDOR server on :${PORT}`));

// Flush buffered analytics before exiting so in-flight events aren't lost.
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
        await analytics.shutdown();
        process.exit(0);
    });
}
