const { chromium } = require('playwright');

const BASE = 'http://localhost:4321';
const OUT  = 'docs/screenshots';

// Mid-game state: ~22 moves in, 4 walls placed each, pawns well advanced
const WALLS = [
    // p1's walls (indices 0-3)
    { row: 6, col: 3, orientation: 'H' },
    { row: 6, col: 5, orientation: 'H' },
    { row: 5, col: 1, orientation: 'V' },
    { row: 4, col: 7, orientation: 'H' },
    // p2's walls (indices 4-7)
    { row: 3, col: 3, orientation: 'H' },
    { row: 3, col: 5, orientation: 'H' },
    { row: 2, col: 1, orientation: 'V' },
    { row: 1, col: 6, orientation: 'V' },
];

async function injectState(p, pawns, wallCounts, extra) {
    await p.evaluate(({ pawns, walls, wallCounts, extra }) => {
        const gs = window.__choridor.gameState;
        gs.p1Pawn     = pawns.p1;
        gs.p2Pawn     = pawns.p2;
        gs.walls      = new Set(walls.map(w => JSON.stringify(w)));
        gs.wallOwners = new Map(walls.map((w, i) => [JSON.stringify(w), i < 4 ? 'p1' : 'p2']));
        gs.wallCounts = wallCounts;
        Object.assign(gs, extra || {});
        window.__choridor.updateLegalMoves();
    }, { pawns, walls: WALLS, wallCounts, extra });
}

async function board(b) {
    const p = await b.newPage();
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto(BASE);
    await p.waitForTimeout(1500);
    await p.click('#btn-local');
    await p.waitForTimeout(800);
    // p1 at row 2 (almost there), p2 at row 5; each used 4 walls leaving 6
    await injectState(p,
        { p1: { row: 2, col: 4 }, p2: { row: 5, col: 4 } },
        { p1: 6, p2: 6 },
        null
    );
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/Board.png` });
    await p.close();
    console.log('Board screenshot saved.');
}

async function win(b) {
    const p = await b.newPage();
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto(BASE);
    await p.waitForTimeout(1500);
    await p.click('#btn-local');
    await p.waitForTimeout(800);
    // p1 crossed the finish line; p2 still at row 4
    await injectState(p,
        { p1: { row: 0, col: 4 }, p2: { row: 4, col: 4 } },
        { p1: 6, p2: 6 },
        { movesP1: 24, movesP2: 23 }
    );
    await p.waitForTimeout(400);
    await p.evaluate(() => {
        document.getElementById('p1-name').textContent = 'Player 1';
        document.getElementById('p2-name').textContent = 'Player 2';
        window.__choridor.showWinScreen('Player 1', 'p1');
    });
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${OUT}/Win.png` });
    await p.close();
    console.log('Win screenshot saved.');
}

(async () => {
    const b = await chromium.launch();
    await board(b);
    await win(b);
    await b.close();
})().catch(e => { console.error(e); process.exit(1); });
