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
const P1_STRIP = 'rgba(158, 74, 64, 0.7)';
const P2_STRIP = 'rgba(62, 104, 168, 0.7)';

let gameState = {
    p1Pawn: { row: 8, col: 4 },
    p2Pawn: { row: 0, col: 4 },
    walls: new Set(),
    wallOwners: new Map(),
    wallCounts: { p1: WALLS_PER_PLAYER, p2: WALLS_PER_PLAYER },
    currentPlayer: 'p1',
    legalMoves: []
};

const canvas = document.getElementById('gameBoard');
const ctx = canvas.getContext('2d');

// Set canvas size
canvas.width = BOARD_TOTAL;
canvas.height = BOARD_TOTAL;

function drawBoard() {
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

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
                ctx.fillStyle = P2_STRIP;
                ctx.fillRect(x, y, CELL_SIZE, stripH);
            } else if (r === BOARD_SIZE - 1) {
                ctx.fillStyle = P1_STRIP;
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
    drawBoard();
    drawWalls();
    drawLegalMoves();
    drawPawns();
}

function updateLegalMoves() {
    gameState.legalMoves = [];
    const pawn = gameState.currentPlayer === 'p1' ? gameState.p1Pawn : gameState.p2Pawn;

    // Check all 4 directions
    const directions = [
        { row: -1, col: 0 },
        { row: 1, col: 0 },
        { row: 0, col: -1 },
        { row: 0, col: 1 }
    ];

    directions.forEach(dir => {
        const newRow = pawn.row + dir.row;
        const newCol = pawn.col + dir.col;

        if (newRow >= 0 && newRow < BOARD_SIZE && newCol >= 0 && newCol < BOARD_SIZE) {
            // Simple check: not blocked by wall (simplified for now)
            gameState.legalMoves.push({ row: newRow, col: newCol });
        }
    });

    render();
}

canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

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
    const pawn = gameState.currentPlayer === 'p1' ? gameState.p1Pawn : gameState.p2Pawn;
    const distance = Math.abs(row - pawn.row) + Math.abs(col - pawn.col);

    if (distance === 1) {
        if (gameState.currentPlayer === 'p1') {
            gameState.p1Pawn = { row, col };
        } else {
            gameState.p2Pawn = { row, col };
        }
        gameState.currentPlayer = gameState.currentPlayer === 'p1' ? 'p2' : 'p1';
        updateLegalMoves();
    }
}

function placeWall(row, col, orientation) {
    if (gameState.currentPlayer === 'p1' && gameState.wallCounts.p1 === 0) return;
    if (gameState.currentPlayer === 'p2' && gameState.wallCounts.p2 === 0) return;

    const wallKey = JSON.stringify({ row, col, orientation });

    if (!gameState.walls.has(wallKey)) {
        gameState.walls.add(wallKey);
        gameState.wallOwners.set(wallKey, gameState.currentPlayer);

        if (gameState.currentPlayer === 'p1') {
            gameState.wallCounts.p1--;
        } else {
            gameState.wallCounts.p2--;
        }

        gameState.currentPlayer = gameState.currentPlayer === 'p1' ? 'p2' : 'p1';
        updateWallCounts();
        updateLegalMoves();
    }
}

function updateWallCounts() {
    document.getElementById('p1-walls').textContent = `Walls: ${gameState.wallCounts.p1}`;
    document.getElementById('p2-walls').textContent = `Walls: ${gameState.wallCounts.p2}`;
}

document.getElementById('reset-btn').addEventListener('click', () => {
    gameState = {
        p1Pawn: { row: 8, col: 4 },
        p2Pawn: { row: 0, col: 4 },
        walls: new Set(),
        wallOwners: new Map(),
        wallCounts: { p1: WALLS_PER_PLAYER, p2: WALLS_PER_PLAYER },
        currentPlayer: 'p1',
        legalMoves: []
    };
    updateWallCounts();
    updateLegalMoves();
});

document.getElementById('mode-btn').addEventListener('click', () => {
    alert('Wall placement is automatic — click in gaps to place walls. Click in cells to move pawns.');
});

updateLegalMoves();
