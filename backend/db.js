// Durable per-user storage (Postgres). Keyed by Discord user id. Holds the
// tutorial-seen flag today and is the foundation for leaderboard/ELO/history.
// No-op when DATABASE_URL is unset, so local dev and pre-provision deploys run
// fine (callers fall back to the client-side localStorage flag). `pg` is only
// required when a connection string exists, so the dependency is optional for
// anyone running without a database.
const DATABASE_URL = process.env.DATABASE_URL;

let pool = null;
if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: DATABASE_URL,
        // Railway's private networking URL needs no SSL; set PGSSL=require when
        // connecting over the public URL.
        ssl: process.env.PGSSL === 'require' ? { rejectUnauthorized: false } : undefined,
    });
    console.log('DB: Postgres enabled');
} else {
    console.log('DB: disabled (set DATABASE_URL to enable per-user persistence)');
}

async function init() {
    if (!pool) return;
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS players (
            discord_id TEXT PRIMARY KEY,
            htp_seen   BOOLEAN     NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
        console.log('DB: players table ready');
    } catch (err) {
        console.warn('DB init failed:', err.message);
    }
}

// Record that we have seen this player (first auth). Cheap groundwork so the
// players table reflects everyone who has launched, for later retention work.
async function ensurePlayer(discordId) {
    if (!pool) return;
    await pool.query(
        'INSERT INTO players (discord_id) VALUES ($1) ON CONFLICT (discord_id) DO NOTHING',
        [discordId],
    );
}

async function getHtpSeen(discordId) {
    if (!pool) return false;
    const { rows } = await pool.query('SELECT htp_seen FROM players WHERE discord_id = $1', [discordId]);
    return rows.length ? !!rows[0].htp_seen : false;
}

async function markHtpSeen(discordId) {
    if (!pool) return;
    await pool.query(
        `INSERT INTO players (discord_id, htp_seen) VALUES ($1, TRUE)
         ON CONFLICT (discord_id) DO UPDATE SET htp_seen = TRUE, updated_at = now()`,
        [discordId],
    );
}

module.exports = { init, ensurePlayer, getHtpSeen, markHtpSeen, enabled: !!pool };
