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
    // The smallest meaningful change here is the version string in the small,
    // low-contrast footer (~20 px on CI, vs a ~0-8 px noise floor), so use a
    // tighter floor than the 50 px default or version bumps go undetected.
    await saveIfChanged(p, 'docs/screenshots/Lobby.png', { diffThreshold: 12 });
    await b.close();
    console.log('Lobby screenshot done.');
})().catch(e => { console.error(e); process.exit(1); });
