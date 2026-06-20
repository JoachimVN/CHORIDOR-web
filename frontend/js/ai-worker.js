const BOARD_SIZE = 9;
const WIN = 4 * BOARD_SIZE * BOARD_SIZE + 1; // 325 — exceeds any heuristic score
const DEFAULT_DEPTH = 2;
const TIME_LIMIT_MS = 1500;
const WALL_RESERVE_WEIGHT = 1;
const DIRS = [[-1,0],[1,0],[0,-1],[0,1]];

// Compact wall key: "H3,4" or "V3,4"
function wk(row, col, o) { return `${o}${row},${col}`; }

function hasWall(walls, o, row, col) { return walls.has(wk(row, col, o)); }

function isEdgeBlocked(walls, from, to) {
    const dr = to.row - from.row, dc = to.col - from.col;
    if (dc === 0) {
        const er = Math.min(from.row, to.row);
        return hasWall(walls, 'H', er, from.col) || hasWall(walls, 'H', er, from.col - 1);
    }
    const ec = Math.min(from.col, to.col);
    return hasWall(walls, 'V', from.row, ec) || hasWall(walls, 'V', from.row - 1, ec);
}

// BFS shortest path to goal row, respecting jump-over-opponent rule
function bfsDist(state, player) {
    const pos = player === 'p1' ? state.p1 : state.p2;
    const opp = player === 'p1' ? state.p2 : state.p1;
    const goalRow = player === 'p1' ? 0 : BOARD_SIZE - 1;
    if (pos.row === goalRow) return 0;
    const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    visited[pos.row * BOARD_SIZE + pos.col] = 1;
    let queue = [pos];
    let dist = 0;
    while (queue.length > 0) {
        dist++;
        const next = [];
        for (const cur of queue) {
            for (const [dr, dc] of DIRS) {
                const nr = cur.row + dr, nc = cur.col + dc;
                if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
                if (isEdgeBlocked(state.walls, cur, {row: nr, col: nc})) continue;
                if (nr === opp.row && nc === opp.col) {
                    // Jump over opponent
                    const sr = nr + dr, sc = nc + dc;
                    if (sr >= 0 && sr < BOARD_SIZE && sc >= 0 && sc < BOARD_SIZE &&
                        !isEdgeBlocked(state.walls, {row: nr, col: nc}, {row: sr, col: sc})) {
                        if (sr === goalRow) return dist;
                        if (!visited[sr * BOARD_SIZE + sc]) { visited[sr * BOARD_SIZE + sc] = 1; next.push({row: sr, col: sc}); }
                    } else {
                        for (const [pd, qd] of DIRS) {
                            if ((pd === dr && qd === dc) || (pd === -dr && qd === -dc)) continue;
                            const dr2 = nr + pd, dc2 = nc + qd;
                            if (dr2 < 0 || dr2 >= BOARD_SIZE || dc2 < 0 || dc2 >= BOARD_SIZE) continue;
                            if (isEdgeBlocked(state.walls, {row: nr, col: nc}, {row: dr2, col: dc2})) continue;
                            if (dr2 === goalRow) return dist;
                            if (!visited[dr2 * BOARD_SIZE + dc2]) { visited[dr2 * BOARD_SIZE + dc2] = 1; next.push({row: dr2, col: dc2}); }
                        }
                    }
                } else {
                    if (nr === goalRow) return dist;
                    if (!visited[nr * BOARD_SIZE + nc]) { visited[nr * BOARD_SIZE + nc] = 1; next.push({row: nr, col: nc}); }
                }
            }
        }
        queue = next;
    }
    return Infinity;
}

// Simple BFS (no jumps) for wall legality check — faster, position-independent
function hasPath(walls, start, goalRow) {
    if (start.row === goalRow) return true;
    const visited = new Uint8Array(BOARD_SIZE * BOARD_SIZE);
    visited[start.row * BOARD_SIZE + start.col] = 1;
    let queue = [start];
    while (queue.length > 0) {
        const next = [];
        for (const cur of queue) {
            for (const [dr, dc] of DIRS) {
                const nr = cur.row + dr, nc = cur.col + dc;
                if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
                if (isEdgeBlocked(walls, cur, {row: nr, col: nc})) continue;
                if (nr === goalRow) return true;
                if (!visited[nr * BOARD_SIZE + nc]) { visited[nr * BOARD_SIZE + nc] = 1; next.push({row: nr, col: nc}); }
            }
        }
        queue = next;
    }
    return false;
}

function getPawnMoves(state) {
    const mover = state.current;
    const pos = mover === 'p1' ? state.p1 : state.p2;
    const opp = mover === 'p1' ? state.p2 : state.p1;
    const moves = [];
    for (const [dr, dc] of DIRS) {
        const nr = pos.row + dr, nc = pos.col + dc;
        if (nr < 0 || nr >= BOARD_SIZE || nc < 0 || nc >= BOARD_SIZE) continue;
        if (isEdgeBlocked(state.walls, pos, {row: nr, col: nc})) continue;
        if (nr === opp.row && nc === opp.col) {
            const sr = nr + dr, sc = nc + dc;
            if (sr >= 0 && sr < BOARD_SIZE && sc >= 0 && sc < BOARD_SIZE &&
                !isEdgeBlocked(state.walls, opp, {row: sr, col: sc})) {
                moves.push({type: 'pawn', row: sr, col: sc});
            } else {
                for (const [pd, qd] of DIRS) {
                    if ((pd === dr && qd === dc) || (pd === -dr && qd === -dc)) continue;
                    const dr2 = nr + pd, dc2 = nc + qd;
                    if (dr2 < 0 || dr2 >= BOARD_SIZE || dc2 < 0 || dc2 >= BOARD_SIZE) continue;
                    if (!isEdgeBlocked(state.walls, opp, {row: dr2, col: dc2})) {
                        moves.push({type: 'pawn', row: dr2, col: dc2});
                    }
                }
            }
        } else {
            moves.push({type: 'pawn', row: nr, col: nc});
        }
    }
    return moves;
}

function getWallMoves(state) {
    const mover = state.current;
    if (state.wc[mover] <= 0) return [];
    const moves = [];
    const MAX = BOARD_SIZE - 2;
    for (const o of ['H', 'V']) {
        for (let r = 0; r <= MAX; r++) {
            for (let c = 0; c <= MAX; c++) {
                if (state.walls.has(wk(r, c, o))) continue;
                if (o === 'H') {
                    if (hasWall(state.walls,'H',r,c-1) || hasWall(state.walls,'H',r,c+1) || hasWall(state.walls,'V',r,c)) continue;
                } else {
                    if (hasWall(state.walls,'V',r-1,c) || hasWall(state.walls,'V',r+1,c) || hasWall(state.walls,'H',r,c)) continue;
                }
                const testWalls = new Set(state.walls);
                testWalls.add(wk(r, c, o));
                if (hasPath(testWalls, state.p1, 0) && hasPath(testWalls, state.p2, BOARD_SIZE - 1)) {
                    moves.push({type: 'wall', row: r, col: c, orientation: o});
                }
            }
        }
    }
    return moves;
}

function candidates(state) {
    return [...getPawnMoves(state), ...getWallMoves(state)];
}

function applyMove(state, move) {
    const next = {
        p1: state.p1, p2: state.p2,
        walls: state.walls,
        wc: state.wc,
        current: state.current === 'p1' ? 'p2' : 'p1',
    };
    if (move.type === 'pawn') {
        if (state.current === 'p1') next.p1 = {row: move.row, col: move.col};
        else next.p2 = {row: move.row, col: move.col};
    } else {
        const w2 = new Set(state.walls);
        w2.add(wk(move.row, move.col, move.orientation));
        next.walls = w2;
        next.wc = {...state.wc, [state.current]: state.wc[state.current] - 1};
    }
    return next;
}

// AI is always p2: positive score favours p2 (maximizing player)
function heuristic(state, myDist, oppDist) {
    return (oppDist - myDist) + WALL_RESERVE_WEIGHT * (state.wc['p2'] - state.wc['p1']);
}

function evaluate(state) {
    const myDist  = bfsDist(state, 'p2');
    const oppDist = bfsDist(state, 'p1');
    if (myDist  === 0)        return  WIN;
    if (oppDist === 0)        return -WIN;
    if (myDist  === Infinity) return -WIN;
    if (oppDist === Infinity) return  WIN;
    return heuristic(state, myDist, oppDist);
}

// Sort: pawn moves first, then order by row proximity to mover's goal
function rowProgressOrder(state) {
    const goalRow = state.current === 'p1' ? 0 : BOARD_SIZE - 1;
    return (a, b) => {
        const ap = a.type === 'pawn', bp = b.type === 'pawn';
        if (ap !== bp) return ap ? -1 : 1;
        if (!ap) return 0;
        return Math.abs(a.row - goalRow) - Math.abs(b.row - goalRow);
    };
}

function minimax(state, depth, alpha, beta, maximizing, deadline) {
    const s = evaluate(state);
    if (Math.abs(s) >= WIN) return s > 0 ? s + depth : s - depth;
    if (depth === 0 || Date.now() >= deadline) return s;
    const moves = candidates(state);
    moves.sort(rowProgressOrder(state));
    if (maximizing) {
        let max = -Infinity;
        for (const m of moves) {
            max = Math.max(max, minimax(applyMove(state, m), depth - 1, alpha, beta, false, deadline));
            alpha = Math.max(alpha, max);
            if (beta <= alpha) break;
        }
        return max;
    } else {
        let min = Infinity;
        for (const m of moves) {
            min = Math.min(min, minimax(applyMove(state, m), depth - 1, alpha, beta, true, deadline));
            beta = Math.min(beta, min);
            if (beta <= alpha) break;
        }
        return min;
    }
}

// Fast-path: if AI is winning the race, just advance the pawn
function racingMove(state, moves) {
    const myDist  = bfsDist(state, 'p2');
    const oppDist = bfsDist(state, 'p1');
    if (myDist <= 0 || myDist >= oppDist) return null;
    let best = null, bestDist = myDist;
    for (const m of moves) {
        if (m.type !== 'pawn') continue;
        const d = bfsDist(applyMove(state, m), 'p2');
        if (d < bestDist) { bestDist = d; best = m; }
    }
    return best;
}

function decide(state) {
    const deadline = Date.now() + TIME_LIMIT_MS;
    const moves = candidates(state);
    if (moves.length === 0) return null;

    const racing = racingMove(state, moves);
    if (racing) return racing;

    // Root sort by BFS progress for better alpha-beta pruning
    moves.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'pawn' ? -1 : 1;
        if (a.type !== 'pawn') return 0;
        return bfsDist(applyMove(state, a), 'p2') - bfsDist(applyMove(state, b), 'p2');
    });

    let best = moves[0];
    for (let depth = 1; depth <= DEFAULT_DEPTH; depth++) {
        if (Date.now() >= deadline) break;
        let bestScore = -Infinity, bestMyDist = Infinity, bestOppDist = -Infinity, candidate = null;
        for (const move of moves) {
            if (Date.now() >= deadline) break;
            const next = applyMove(state, move);
            const s = minimax(next, depth - 1, -Infinity, Infinity, false, deadline);
            const myDist  = bfsDist(next, 'p2');
            const oppDist = bfsDist(next, 'p1');
            if (s > bestScore || (s === bestScore && myDist < bestMyDist) ||
                (s === bestScore && myDist === bestMyDist && oppDist > bestOppDist)) {
                bestScore = s; bestMyDist = myDist; bestOppDist = oppDist; candidate = move;
            }
        }
        if (candidate) best = candidate;
    }
    return best;
}

self.onmessage = function(e) {
    const { state } = e.data;
    const walls = new Set(state.walls.map(w => wk(w.row, w.col, w.orientation)));
    const aiState = { p1: state.p1, p2: state.p2, walls, wc: state.wc, current: 'p2' };
    const move = decide(aiState);
    self.postMessage({ move });
};
