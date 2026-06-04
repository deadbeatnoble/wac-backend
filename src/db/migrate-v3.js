/**
 * Production alignment migration (idempotent).
 * - Applies all v2 column additions
 * - Backfills tournament_id on registrations
 * - Widens audit entity_id for UUID tournaments
 *
 * Run: npm run db:migrate:v3
 */
import pool from './pool.js';

const upgrades = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS player_profiles (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  phone VARCHAR(50),
  country VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_open_date DATE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_close_date DATE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_participants INTEGER;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS banner_url VARCHAR(500);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_participant_id INTEGER;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_prize TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_story TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_image_url VARCHAR(500);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_published BOOLEAN DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_published_at TIMESTAMPTZ;

ALTER TABLE registrations ADD COLUMN IF NOT EXISTS player_profile_id INTEGER;

CREATE TABLE IF NOT EXISTS match_result_history (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL,
  winner_participant_id INTEGER,
  action VARCHAR(20) NOT NULL CHECK (action IN ('set', 'undo', 'edit')),
  admin_id INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER,
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id TEXT,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registrations_tournament ON registrations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_registrations_tournament_status ON registrations(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_tournaments_archived ON tournaments(is_archived);
`;

async function getTournamentIdSqlType(client) {
  const res = await client.query(
    `SELECT udt_name, data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'tournaments' AND column_name = 'id'`
  );
  const row = res.rows[0];
  if (!row) return 'INTEGER';
  if (row.udt_name === 'uuid' || row.data_type === 'uuid') return 'UUID';
  return 'INTEGER';
}

async function ensureTournamentFkColumns(client) {
  const idType = await getTournamentIdSqlType(client);

  const regCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'registrations' AND column_name = 'tournament_id'`
  );
  if (!regCol.rows.length) {
    await client.query(
      `ALTER TABLE registrations ADD COLUMN tournament_id ${idType} REFERENCES tournaments(id)`
    );
    console.log(`[migrate-v3] registrations.tournament_id added (${idType})`);
  }

  const activeCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'site_settings' AND column_name = 'active_tournament_id'`
  );
  if (!activeCol.rows.length) {
    await client.query(
      `ALTER TABLE site_settings ADD COLUMN active_tournament_id ${idType} REFERENCES tournaments(id)`
    );
    console.log(`[migrate-v3] site_settings.active_tournament_id added (${idType})`);
  }
}

async function ensureAuditEntityIdText(client) {
  const col = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'admin_audit_logs' AND column_name = 'entity_id'`
  );
  if (col.rows[0]?.data_type === 'integer') {
    await client.query(
      `ALTER TABLE admin_audit_logs ALTER COLUMN entity_id TYPE TEXT USING entity_id::text`
    );
    console.log('[migrate-v3] admin_audit_logs.entity_id → TEXT');
  }
}

async function backfill(client) {
  const tourRes = await client.query('SELECT id FROM tournaments ORDER BY created_at ASC LIMIT 1');
  let defaultTourId = tourRes.rows[0]?.id;

  if (!defaultTourId) {
    const ins = await client.query(
      `INSERT INTO tournaments (name, status, registrations_open, prize_description)
       VALUES ('Grand Prize Tournament', 'registration_open', true, 'Premium Car Package')
       RETURNING id`
    );
    defaultTourId = ins.rows[0].id;
  }

  await client.query(
    `UPDATE site_settings SET active_tournament_id = $1 WHERE active_tournament_id IS NULL`,
    [defaultTourId]
  );

  const hasTournamentCol = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'registrations' AND column_name = 'tournament_id'`
  );
  if (hasTournamentCol.rows.length) {
    await client.query(
      `UPDATE registrations SET tournament_id = $1 WHERE tournament_id IS NULL`,
      [defaultTourId]
    );
  }

  const regs = await client.query(
    `SELECT id, email, first_name, last_name, phone, country FROM registrations WHERE player_profile_id IS NULL`
  );

  for (const reg of regs.rows) {
    const email = reg.email.toLowerCase();
    let profile = await client.query('SELECT id FROM player_profiles WHERE email = $1', [email]);
    let profileId = profile.rows[0]?.id;
    if (!profileId) {
      const p = await client.query(
        `INSERT INTO player_profiles (email, first_name, last_name, phone, country)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [email, reg.first_name, reg.last_name, reg.phone, reg.country]
      );
      profileId = p.rows[0].id;
    }
    await client.query(
      `UPDATE registrations SET player_profile_id = $1, tournament_id = COALESCE(tournament_id, $2) WHERE id = $3`,
      [profileId, defaultTourId, reg.id]
    );
  }

  try {
    await client.query('ALTER TABLE registrations DROP CONSTRAINT IF EXISTS registrations_email_key');
  } catch {
    /* ignore */
  }

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS registrations_tournament_profile_unique
    ON registrations (tournament_id, player_profile_id)
    WHERE tournament_id IS NOT NULL AND player_profile_id IS NOT NULL
  `);

  console.log('[migrate-v3] Backfill complete. Default tournament id:', defaultTourId);
}

export async function runMigrationsV3(existingPool = pool) {
  const client = await existingPool.connect();
  try {
    await client.query(upgrades);
    await ensureTournamentFkColumns(client);
    await ensureAuditEntityIdText(client);
    await backfill(client);
    console.log('[migrate-v3] Schema alignment completed.');
  } finally {
    client.release();
  }
}

async function cli() {
  try {
    await runMigrationsV3();
  } finally {
    await pool.end();
  }
}

const isMain = process.argv[1]?.includes('migrate-v3');
if (isMain) {
  cli().catch((err) => {
    console.error('Migration v3 failed:', err);
    process.exit(1);
  });
}
