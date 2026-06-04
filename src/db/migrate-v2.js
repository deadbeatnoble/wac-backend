/**
 * Multi-season upgrade migration. Safe to run multiple times (IF NOT EXISTS / DO blocks).
 * Run: node src/db/migrate-v2.js
 */
import pool from './pool.js';

const upgrades = `
-- Player profiles (returning players across seasons)
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

-- Tournament extended fields
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_open_date DATE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS registration_close_date DATE;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS max_participants INTEGER;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS banner_url VARCHAR(500);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_participant_id INTEGER REFERENCES tournament_participants(id);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_prize TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_story TEXT;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_image_url VARCHAR(500);
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_published BOOLEAN DEFAULT false;
ALTER TABLE tournaments ADD COLUMN IF NOT EXISTS champion_published_at TIMESTAMPTZ;

-- Active tournament on site settings
ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS active_tournament_id INTEGER REFERENCES tournaments(id);

-- Registrations: link to tournament + profile
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS tournament_id INTEGER REFERENCES tournaments(id);
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS player_profile_id INTEGER REFERENCES player_profiles(id);

-- Match history for undo/audit
CREATE TABLE IF NOT EXISTS match_result_history (
  id SERIAL PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES tournament_matches(id) ON DELETE CASCADE,
  winner_participant_id INTEGER REFERENCES tournament_participants(id),
  action VARCHAR(20) NOT NULL CHECK (action IN ('set', 'undo', 'edit')),
  admin_id INTEGER REFERENCES admins(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id SERIAL PRIMARY KEY,
  admin_id INTEGER REFERENCES admins(id),
  action VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50),
  entity_id INTEGER,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_registrations_tournament ON registrations(tournament_id);
CREATE INDEX IF NOT EXISTS idx_registrations_tournament_status ON registrations(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_tournaments_archived ON tournaments(is_archived);
`;

async function backfill(client) {
  const tourRes = await client.query('SELECT id FROM tournaments ORDER BY id ASC LIMIT 1');
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

  console.log('Backfill complete. Default tournament id:', defaultTourId);
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(upgrades);
    await backfill(client);
    console.log('Migration v2 completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration v2 failed:', err);
  process.exit(1);
});
