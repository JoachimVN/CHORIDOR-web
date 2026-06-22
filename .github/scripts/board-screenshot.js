const { chromium } = require('playwright');
const { prepPage, saveIfChanged } = require('./screenshot-utils');

const BASE = 'http://localhost:4321';
const OUT  = 'docs/screenshots';

// P1 (red) starts at row 8, races to row 0.
// P2 (blue) starts at row 0, races to row 8.
// Orange walls = P1's (slow P2's southward advance).
// Blue walls   = P2's (slow P1's northward advance).

const BOARD = {
    p1Pawn:     { row: 5, col: 3 },
    p2Pawn:     { row: 3, col: 3 },
    p1Walls: [
        { row: 3, col: 1, orientation: 'V' }, // seals P2's left escape at rows 3-4
        { row: 5, col: 4, orientation: 'H' }, // preemptive block at P2's future row 5-6
        { row: 3, col: 4, orientation: 'V' }, // middle of Z shape (red)
    ],
    p2Walls: [
        { row: 2, col: 3, orientation: 'H' }, // horizontal barrier blocking P1 at rows 2-3
        { row: 4, col: 5, orientation: 'H' }, // blocks P1 from going up via cols 4-5
        { row: 4, col: 2, orientation: 'V' }, // vertical wall right of both pawns, bottom at row 5 edge
    ],
    wallCounts: { p1: 7, p2: 7 },
};

// Win: continuation of BOARD state. P1 pushed through to row 0 for the win.
const WIN = {
    p1Pawn:     { row: 0, col: 3 },
    p2Pawn:     { row: 5, col: 4 },
    p1Walls: [
        { row: 3, col: 1, orientation: 'V' },
        { row: 5, col: 4, orientation: 'H' },
        { row: 3, col: 4, orientation: 'V' },
        { row: 6, col: 3, orientation: 'H' },
    ],
    p2Walls: [
        { row: 2, col: 3, orientation: 'H' },
        { row: 4, col: 5, orientation: 'H' },
        { row: 4, col: 2, orientation: 'V' },
        { row: 1, col: 2, orientation: 'H' },
    ],
    wallCounts: { p1: 6, p2: 6 },
    extra: { movesP1: 16, movesP2: 15 },
};

async function injectState(p, state) {
    const allWalls = [...state.p1Walls, ...state.p2Walls];
    const numP1    = state.p1Walls.length;
    await p.evaluate(({ p1Pawn, p2Pawn, allWalls, numP1, wallCounts, extra }) => {
        const gs      = window.__choridor.gameState;
        gs.p1Pawn     = p1Pawn;
        gs.p2Pawn     = p2Pawn;
        gs.walls      = new Set(allWalls.map(w => JSON.stringify(w)));
        gs.wallOwners = new Map(allWalls.map((w, i) => [JSON.stringify(w), i < numP1 ? 'p1' : 'p2']));
        gs.wallCounts = wallCounts;
        Object.assign(gs, extra || {});
        window.__choridor.updateWallCounts();
        window.__choridor.updateLegalMoves();
    }, { p1Pawn: state.p1Pawn, p2Pawn: state.p2Pawn, allWalls, numP1, wallCounts: state.wallCounts, extra: state.extra });
}

async function board(b) {
    const p = await b.newPage();
    await prepPage(p);
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto(BASE);
    await p.waitForTimeout(1500);
    await p.click('#btn-local');
    await p.waitForTimeout(800);
    await injectState(p, BOARD);
    await p.waitForTimeout(400);
    await saveIfChanged(p, `${OUT}/Board.png`);
    await p.close();
    console.log('Board screenshot done.');
}

async function win(b) {
    const p = await b.newPage();
    await prepPage(p);
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto(BASE);
    await p.waitForTimeout(1500);
    await p.click('#btn-local');
    await p.waitForTimeout(800);
    await injectState(p, WIN);
    await p.waitForTimeout(400);
    await p.evaluate(() => {
        document.getElementById('p1-name').textContent = 'Player 1';
        document.getElementById('p2-name').textContent = 'Player 2';
        window.__choridor.showWinScreen('Player 1', 'p1');
    });
    await p.waitForTimeout(400);
    await saveIfChanged(p, `${OUT}/Win.png`);
    await p.close();
    console.log('Win screenshot done.');
}

(async () => {
    try {
        const b = await chromium.launch();
        await board(b);
        await win(b);
        await b.close();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
