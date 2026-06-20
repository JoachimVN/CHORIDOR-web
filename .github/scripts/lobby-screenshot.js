const { chromium } = require('playwright');

(async () => {
    const b = await chromium.launch();
    const p = await b.newPage();
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto('http://localhost:4321');
    await p.waitForTimeout(1800);
    await p.screenshot({ path: 'docs/screenshots/Lobby.png' });
    await b.close();
    console.log('Lobby screenshot saved.');
})().catch(e => { console.error(e); process.exit(1); });
