const { chromium } = require('playwright');
const { prepPage, saveIfChanged } = require('./screenshot-utils');

(async () => {
    const b = await chromium.launch();
    const p = await b.newPage();
    await prepPage(p);
    await p.setViewportSize({ width: 1440, height: 900 });
    await p.addInitScript(() => localStorage.setItem('choridor_htp_seen', '1'));
    await p.goto('http://localhost:4321');
    await p.waitForTimeout(1800);
    await saveIfChanged(p, 'docs/screenshots/Lobby.png');
    await b.close();
    console.log('Lobby screenshot done.');
})().catch(e => { console.error(e); process.exit(1); });
