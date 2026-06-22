// Server-side analytics sink. Captures game-lifecycle events from BOTH the web
// and Discord Activity builds (they all connect to this same socket.io server)
// and forwards them to PostHog. No-op when POSTHOG_API_KEY is unset, so local dev
// and anyone running without a key just sees nothing sent.
const { PostHog } = require('posthog-node');

const KEY  = process.env.POSTHOG_API_KEY;
const HOST = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

let client = null;
if (KEY) {
    client = new PostHog(KEY, { host: HOST, flushAt: 20, flushInterval: 10_000 });
    console.log('Analytics: PostHog enabled');
} else {
    console.log('Analytics: disabled (set POSTHOG_API_KEY to enable)');
}

// distinctId is a per-match id, not a real user, so we disable person profile
// creation to avoid polluting PostHog with one "person" per match.
function capture(event, properties = {}, distinctId = 'server') {
    if (!client) return;
    try {
        client.capture({
            distinctId,
            event,
            properties: { ...properties, $process_person_profile: false },
        });
    } catch (err) {
        console.warn('Analytics capture failed:', err.message);
    }
}

async function shutdown() {
    if (client) await client.shutdown();
}

module.exports = { capture, shutdown };
