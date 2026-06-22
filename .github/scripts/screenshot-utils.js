const fs = require('fs');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

// Minimum number of differing pixels before we treat a screenshot as changed
// and overwrite the committed baseline. Anti-aliased pixels are excluded and a
// per-pixel colour tolerance is applied, so a deterministic re-render of the
// same scene settles to ~0 diff. This floor only has to clear residual jitter,
// so it is deliberately low: a single changed glyph (a move count, the version
// string, a label) is hundreds of pixels and comfortably clears it. The intent
// is to swallow rendering noise, never a real visual change.
const DIFF_PIXEL_THRESHOLD = 50;

// Per-pixel colour tolerance (0-1). Higher tolerates more subtle shading drift.
const COLOR_THRESHOLD = 0.1;

// Suppress in-flight animations so captures are deterministic. Call once after
// creating the page, before navigating.
//
// emulateMedia only helps for animations gated behind a
// prefers-reduced-motion rule; several win-screen animations (e.g. the
// overshooting .win-pawn bounce) are not, so a fixed-delay capture lands
// mid-animation and the pawn edge/glow jitters a few hundred pixels run to
// run. The init script forces every animation and transition to zero
// duration, so each element snaps to its final keyframe and captures settle to
// a stable frame regardless of CI timing.
async function prepPage(page) {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => {
        const css = `*, *::before, *::after {
            animation-duration: 0s !important;
            animation-delay: 0s !important;
            transition-duration: 0s !important;
            transition-delay: 0s !important;
        }`;
        const inject = () => {
            const style = document.createElement('style');
            style.textContent = css;
            (document.head || document.documentElement).appendChild(style);
        };
        if (document.head || document.documentElement) inject();
        else document.addEventListener('DOMContentLoaded', inject);
    });
}

// Capture the page and write it only if it differs meaningfully from the
// committed baseline. Returns true when the file was (over)written.
async function saveIfChanged(page, outPath, options = {}) {
    // Make sure fonts are loaded so glyphs are not captured mid-swap.
    await page.evaluate(() => (document.fonts ? document.fonts.ready : null));

    const buf = await page.screenshot(options);
    const next = PNG.sync.read(buf);

    if (fs.existsSync(outPath)) {
        let prev = null;
        try {
            prev = PNG.sync.read(fs.readFileSync(outPath));
        } catch {
            prev = null;
        }
        if (prev && prev.width === next.width && prev.height === next.height) {
            const changed = pixelmatch(
                prev.data, next.data, null,
                next.width, next.height,
                { threshold: COLOR_THRESHOLD, includeAA: false },
            );
            if (changed <= DIFF_PIXEL_THRESHOLD) {
                console.log(`${outPath}: ${changed} px changed (<= ${DIFF_PIXEL_THRESHOLD}), keeping baseline.`);
                return false;
            }
            console.log(`${outPath}: ${changed} px changed, updating.`);
        }
    }

    fs.writeFileSync(outPath, buf);
    return true;
}

module.exports = { prepPage, saveIfChanged, DIFF_PIXEL_THRESHOLD, COLOR_THRESHOLD };
