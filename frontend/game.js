const BOARD_SIZE = 9;
const CELL_SIZE = 54;
const GAP = 10;
const STEP = CELL_SIZE + GAP;
const BOARD_TOTAL = BOARD_SIZE * CELL_SIZE + (BOARD_SIZE - 1) * GAP;
const WALLS_PER_PLAYER = 10;

// Colors matching the Java version
const P1_COLOR = '#9E4A40';
const P2_COLOR = '#3E68A8';
const BG_COLOR = '#0F1117';
const CELL_COLOR = '#191C2A';
const WALL_USED_COLOR = '#404854';
const P1_STRIP = 'rgba(158, 74, 64, 0.7)';
const P2_STRIP = 'rgba(62, 104, 168, 0.7)';

let gameState = {
    p1Pawn: { row: 8, col: 4 },
    p2Pawn: { row: 0, col: 4 },
    walls: new Set(),
    wallOwners: new Map(),
    wallCounts: { p1: WALLS_PER_PLAYER, p2: WALLS_PER_PLAYER },
    currentPlayer: 'p1',
    legalMoves: [],
    flipped: false,
    gameOver: false
};

const canvas = document.getElementById('gameBoard');
const ctx = canvas.getContext('2d');
const dpr = window.devicePixelRatio || 1;
let boardScale = 1;

function resizeCanvas() {
    const wrapper = canvas.parentElement;
    const size = Math.min(wrapper.clientWidth, wrapper.clientHeight);
    boardScale = size / BOARD_TOTAL;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    ctx.setTransform(boardScale * dpr, 0, 0, boardScale * dpr, 0, 0);
}

// Build wall boxes for both players
function buildWallBoxes() {
    const p1Container = document.getElementById('p1-walls');
    const p2Container = document.getElementById('p2-walls');

    p1Container.innerHTML = '';
    p2Container.innerHTML = '';

    for (let i = 0; i < WALLS_PER_PLAYER; i++) {
        const box1 = document.createElement('div');
        box1.className = 'wall-box active';
        box1.style.background = P1_COLOR;
        box1.id = `p1-wall-${i}`;
        p1Container.appendChild(box1);

        const box2 = document.createElement('div');
        box2.className = 'wall-box active';
        box2.style.background = P2_COLOR;
        box2.id = `p2-wall-${i}`;
        p2Container.appendChild(box2);
    }
}

function drawBoard() {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, BOARD_TOTAL, BOARD_TOTAL);

    // Draw cells with gaps
    for (let r = 0; r < BOARD_SIZE; r++) {
        for (let c = 0; c < BOARD_SIZE; c++) {
            const x = c * STEP;
            const y = r * STEP;

            // Draw cell background
            ctx.fillStyle = CELL_COLOR;
            ctx.fillRect(x, y, CELL_SIZE, CELL_SIZE);

            // Draw goal strips
            const stripH = 3;
            if (r === 0) {
                ctx.fillStyle = P1_STRIP;
                ctx.fillRect(x, y, CELL_SIZE, stripH);
            } else if (r === BOARD_SIZE - 1) {
                ctx.fillStyle = P2_STRIP;
                ctx.fillRect(x, y + CELL_SIZE - stripH, CELL_SIZE, stripH);
            }
        }
    }
}

function drawWalls() {
    gameState.walls.forEach(wallKey => {
        const wall = JSON.parse(wallKey);
        const owner = gameState.wallOwners.get(wallKey);
        const color = owner === 'p1' ? P1_COLOR : P2_COLOR;

        const x = wall.col * STEP;
        const y = wall.row * STEP;

        ctx.fillStyle = color;

        if (wall.orientation === 'H') {
            // Horizontal wall in the gap below the cell
            ctx.fillRect(x, y + CELL_SIZE, CELL_SIZE * 2 + GAP, GAP);
        } else {
            // Vertical wall in the gap to the right of the cell
            ctx.fillRect(x + CELL_SIZE, y, GAP, CELL_SIZE * 2 + GAP);
        }
    });
}

function drawLegalMoves() {
    const color = gameState.currentPlayer === 'p1' ? P1_COLOR : P2_COLOR;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.5;

    gameState.legalMoves.forEach(move => {
        const x = move.col * STEP + CELL_SIZE / 2;
        const y = move.row * STEP + CELL_SIZE / 2;
        const radius = CELL_SIZE * 0.13;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
    });

    ctx.globalAlpha = 1;
}

function drawPawns() {
    // P1 pawn
    const x1 = gameState.p1Pawn.col * STEP + CELL_SIZE / 2;
    const y1 = gameState.p1Pawn.row * STEP + CELL_SIZE / 2;
    const radius = (CELL_SIZE - 2 * CELL_SIZE * 0.16) / 2;

    ctx.fillStyle = P1_COLOR;
    ctx.beginPath();
    ctx.arc(x1, y1, radius, 0, Math.PI * 2);
    ctx.fill();

    // P2 pawn
    const x2 = gameState.p2Pawn.col * STEP + CELL_SIZE / 2;
    const y2 = gameState.p2Pawn.row * STEP + CELL_SIZE / 2;

    ctx.fillStyle = P2_COLOR;
    ctx.beginPath();
    ctx.arc(x2, y2, radius, 0, Math.PI * 2);
    ctx.fill();
}

function render() {
    if (gameState.flipped) {
        ctx.save();
        ctx.translate(BOARD_TOTAL, BOARD_TOTAL);
        ctx.scale(-1, -1);
    }

    drawBoard();
    drawWalls();
    drawLegalMoves();
    drawPawns();

    if (gameState.flipped) {
        ctx.restore();
    }
}

function updateLegalMoves() {
    gameState.legalMoves = [];
    const pawn = gameState.currentPlayer === 'p1' ? gameState.p1Pawn : gameState.p2Pawn;
    const opp = gameState.currentPlayer === 'p1' ? gameState.p2Pawn : gameState.p1Pawn;

    const directions = [
        { row: -1, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: -1 },
        { row: 0, col: 1 }
    ];

    directions.forEach(dir => {
        const neighbor = { row: pawn.row + dir.row, col: pawn.col + dir.col };

        // Out of bounds
        if (neighbor.row < 0 || neighbor.row >= BOARD_SIZE || neighbor.col < 0 || neighbor.col >= BOARD_SIZE) {
            return;
        }

        // Wall blocking this edge
        if (isEdgeBlocked(pawn, neighbor)) {
            return;
        }

        // Empty cell
        if (!isSamePos(neighbor, opp)) {
            gameState.legalMoves.push(neighbor);
            render();
            return;
        }

        // Opponent adjacent — try to jump
        const straight = { row: neighbor.row + dir.row, col: neighbor.col + dir.col };
        if (straight.row >= 0 && straight.row < BOARD_SIZE && straight.col >= 0 && straight.col < BOARD_SIZE &&
            !isEdgeBlocked(neighbor, straight)) {
            gameState.legalMoves.push(straight);
        } else {
            // Straight blocked — try diagonals
            const perps = [
                { row: dir.col, col: -dir.row },
                { row: -dir.col, col: dir.row }
            ];
            perps.forEach(perp => {
                const diag = { row: neighbor.row + perp.row, col: neighbor.col + perp.col };
                if (diag.row >= 0 && diag.row < BOARD_SIZE && diag.col >= 0 && diag.col < BOARD_SIZE &&
                    !isEdgeBlocked(neighbor, diag)) {
                    gameState.legalMoves.push(diag);
                }
            });
        }
    });

    render();
}

function isSamePos(a, b) {
    return a.row === b.row && a.col === b.col;
}

function isEdgeBlocked(from, to) {
    const dr = to.row - from.row;
    const dc = to.col - from.col;

    if (Math.abs(dr) + Math.abs(dc) !== 1) return false;

    if (dc === 0) {
        // Vertical movement — check for horizontal walls
        const edgeRow = Math.min(from.row, to.row);
        return hasWall('H', edgeRow, from.col) || hasWall('H', edgeRow, from.col - 1);
    }

    if (dr === 0) {
        // Horizontal movement — check for vertical walls
        const edgeCol = Math.min(from.col, to.col);
        return hasWall('V', from.row, edgeCol) || hasWall('V', from.row - 1, edgeCol);
    }

    return false;
}

function hasWall(orientation, row, col) {
    const wallKey = JSON.stringify({ row, col, orientation });
    return gameState.walls.has(wallKey);
}

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    let x = (e.clientX - rect.left) / boardScale;
    let y = (e.clientY - rect.top) / boardScale;

    if (gameState.flipped) {
        x = BOARD_TOTAL - x;
        y = BOARD_TOTAL - y;
    }

    // Determine if click is in cell or gap
    const cellX = Math.floor(x / STEP);
    const cellY = Math.floor(y / STEP);
    const offX = x - cellX * STEP;
    const offY = y - cellY * STEP;

    const inHGap = offY >= CELL_SIZE && cellY < BOARD_SIZE - 1;
    const inVGap = offX >= CELL_SIZE && cellX < BOARD_SIZE - 1;

    if (!inHGap && !inVGap) {
        // Clicked in cell — move pawn
        movePawn(cellY, cellX);
    } else if (inHGap || inVGap) {
        // Clicked in gap — place wall
        const wallOrientation = inHGap ? 'H' : 'V';
        placeWall(cellY, cellX, wallOrientation);
    }
});

function movePawn(row, col) {
    if (gameState.gameOver) return;

    // Check if this is a legal move
    const isLegal = gameState.legalMoves.some(m => m.row === row && m.col === col);
    if (!isLegal) return;

    if (gameState.currentPlayer === 'p1') {
        gameState.p1Pawn = { row, col };
    } else {
        gameState.p2Pawn = { row, col };
    }

    if (checkWin()) return;

    gameState.currentPlayer = gameState.currentPlayer === 'p1' ? 'p2' : 'p1';
    updateStatus();
    updateLegalMoves();
}

function placeWall(row, col, orientation) {
    if (gameState.gameOver) return;
    if (gameState.currentPlayer === 'p1' && gameState.wallCounts.p1 === 0) return;
    if (gameState.currentPlayer === 'p2' && gameState.wallCounts.p2 === 0) return;

    const wallKey = JSON.stringify({ row, col, orientation });

    if (gameState.walls.has(wallKey)) return; // Already exists
    if (hasWallOverlap(row, col, orientation)) return; // Overlaps with existing wall

    // Test if wall blocks a player's path
    gameState.walls.add(wallKey);
    if (!bothPlayersHavePath()) {
        gameState.walls.delete(wallKey); // Revert if blocks path
        return;
    }

    gameState.wallOwners.set(wallKey, gameState.currentPlayer);

    if (gameState.currentPlayer === 'p1') {
        gameState.wallCounts.p1--;
    } else {
        gameState.wallCounts.p2--;
    }

    gameState.currentPlayer = gameState.currentPlayer === 'p1' ? 'p2' : 'p1';
    updateWallCounts();
    updateStatus();
    updateLegalMoves();
}

function hasWallOverlap(row, col, orientation) {
    const MAX_ANCHOR = BOARD_SIZE - 2;
    if (row < 0 || row > MAX_ANCHOR || col < 0 || col > MAX_ANCHOR) return true;

    if (orientation === 'H') {
        // H wall can't have another H wall adjacent (col-1 or col+1)
        if (hasWall('H', row, col - 1) || hasWall('H', row, col + 1)) return true;
        // H wall can't cross a V wall at same anchor
        if (hasWall('V', row, col)) return true;
    } else {
        // V wall can't have another V wall adjacent (row-1 or row+1)
        if (hasWall('V', row - 1, col) || hasWall('V', row + 1, col)) return true;
        // V wall can't cross an H wall at same anchor
        if (hasWall('H', row, col)) return true;
    }

    return false;
}

function bothPlayersHavePath() {
    // P1 goal is row 0, P2 goal is row 8
    return hasPathToGoal(gameState.p1Pawn, 0) && hasPathToGoal(gameState.p2Pawn, BOARD_SIZE - 1);
}

function hasPathToGoal(start, goalRow) {
    const visited = new Set();
    const queue = [start];
    visited.add(`${start.row},${start.col}`);

    while (queue.length > 0) {
        const pos = queue.shift();

        // Reached goal
        if (pos.row === goalRow) return true;

        // Check all 4 directions
        const directions = [
            { row: -1, col: 0 },
            { row: 1, col: 0 },
            { row: 0, col: -1 },
            { row: 0, col: 1 }
        ];

        for (const dir of directions) {
            const next = { row: pos.row + dir.row, col: pos.col + dir.col };
            const key = `${next.row},${next.col}`;

            if (next.row >= 0 && next.row < BOARD_SIZE && next.col >= 0 && next.col < BOARD_SIZE &&
                !visited.has(key) && !isEdgeBlocked(pos, next)) {
                visited.add(key);
                queue.push(next);
            }
        }
    }

    return false;
}

function updateWallCounts() {
    for (let i = 0; i < WALLS_PER_PLAYER; i++) {
        const p1Box = document.getElementById(`p1-wall-${i}`);
        const p2Box = document.getElementById(`p2-wall-${i}`);

        if (i < gameState.wallCounts.p1) {
            p1Box.className = 'wall-box active';
            p1Box.style.background = P1_COLOR;
        } else {
            p1Box.className = 'wall-box used';
            p1Box.style.background = WALL_USED_COLOR;
        }

        if (i < gameState.wallCounts.p2) {
            p2Box.className = 'wall-box active';
            p2Box.style.background = P2_COLOR;
        } else {
            p2Box.className = 'wall-box used';
            p2Box.style.background = WALL_USED_COLOR;
        }
    }
}

function updateStatus() {
    const status = document.getElementById('status');
    status.textContent = `${gameState.currentPlayer === 'p1' ? 'Player 1' : 'Player 2'}'s Turn`;
    status.className = `status-label ${gameState.currentPlayer === 'p1' ? 'p1' : 'p2'}`;
}

function checkWin() {
    if (gameState.p1Pawn.row === 0) {
        showWinScreen('Player 1', 'p1');
        return true;
    }
    if (gameState.p2Pawn.row === BOARD_SIZE - 1) {
        showWinScreen('Player 2', 'p2');
        return true;
    }
    return false;
}

function showWinScreen(winner, playerClass) {
    gameState.gameOver = true;
    const overlay = document.getElementById('win-overlay');
    const message = document.getElementById('win-message');
    message.textContent = `${winner} Wins!`;
    message.className = `win-text ${playerClass}`;
    overlay.classList.remove('hidden');
}

function resetGame() {
    gameState = {
        p1Pawn: { row: 8, col: 4 },
        p2Pawn: { row: 0, col: 4 },
        walls: new Set(),
        wallOwners: new Map(),
        wallCounts: { p1: WALLS_PER_PLAYER, p2: WALLS_PER_PLAYER },
        currentPlayer: 'p1',
        legalMoves: [],
        flipped: gameState.flipped,
        gameOver: false
    };
    document.getElementById('win-overlay').classList.add('hidden');
    updateWallCounts();
    updateStatus();
    updateLegalMoves();
}

document.getElementById('new-game-btn').addEventListener('click', resetGame);
document.getElementById('play-again-btn').addEventListener('click', resetGame);

document.getElementById('flip-btn').addEventListener('click', () => {
    gameState.flipped = !gameState.flipped;
    render();
});

window.addEventListener('resize', () => { resizeCanvas(); render(); });

buildWallBoxes();
updateWallCounts();
updateStatus();
resizeCanvas();
updateLegalMoves();
