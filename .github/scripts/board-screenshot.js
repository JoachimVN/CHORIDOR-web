const { chromium } = require('playwright');

const BASE = 'http://localhost:4321';
const OUT  = 'docs/screenshots';

const WALLS = [
    { row: 4, col: 3, orientation: 'H' },
    { row: 4, col: 5, orientation: 'H' },
    { row: 2, col: 3, orientation: 'V' },
    { row: 6, col: 2, orientation: 'H' },
];

async function injectState(p, pawns, wallCounts, extra) {
    await p.evaluate(({ pawns, walls, wallCounts, extra }) => {
        const gs = window.__choridor.gameState;
        gs.p1Pawn     = pawns.p1;
        gs.p2Pawn     = pawns.p2;
        gs.walls      = new Set(walls.map(w => JSON.stringify(w)));
        gs.wallOwners = new Map(walls.map((w, i) => [JSON.stringify(w), i < 2 ? 'p1' : 'p2']));
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
    await injectState(p,
        { p1: { row: 5, col: 4 }, p2: { row: 3, col: 3 } },
        { p1: 8, p2: 8 },
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
    await injectState(p,
        { p1: { row: 0, col: 4 }, p2: { row: 3, col: 3 } },
        { p1: 7, p2: 6 },
        { movesP1: 12, movesP2: 11 }
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
