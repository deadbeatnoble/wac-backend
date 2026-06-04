import pool from './pool.js';

const schema = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) DEFAULT 'Admin',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS registrations (
  id SERIAL PRIMARY KEY,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  country VARCHAR(100),
  experience VARCHAR(50),
  payment_account VARCHAR(255) NOT NULL,
  payment_screenshot VARCHAR(500) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason TEXT,
  reviewed_at TIMESTAMPTZ,
  reviewed_by INTEGER REFERENCES admins(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cms_pages (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(50) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  status VARCHAR(20) DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  blocks JSONB DEFAULT '[]'::jsonb,
  meta JSONB DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  updated_by INTEGER REFERENCES admins(id)
);

CREATE TABLE IF NOT EXISTS tournaments (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(30) DEFAULT 'draft' CHECK (status IN ('draft', 'registration_open', 'registration_closed', 'active', 'completed')),
  registrations_open BOOLEAN DEFAULT true,
  start_date DATE,
  end_date DATE,
  prize_description TEXT,
  schedule JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tournament_participants (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  registration_id INTEGER NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  seed INTEGER,
  eliminated BOOLEAN DEFAULT false,
  schedule_day INTEGER,
  UNIQUE(tournament_id, registration_id)
);

CREATE TABLE IF NOT EXISTS tournament_rounds (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_number INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed')),
  scheduled_date DATE,
  UNIQUE(tournament_id, round_number)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
  id SERIAL PRIMARY KEY,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_id INTEGER NOT NULL REFERENCES tournament_rounds(id) ON DELETE CASCADE,
  match_number INTEGER NOT NULL,
  player1_id INTEGER REFERENCES tournament_participants(id),
  player2_id INTEGER REFERENCES tournament_participants(id),
  winner_id INTEGER REFERENCES tournament_participants(id),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'live', 'completed')),
  scheduled_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  game_phase VARCHAR(30) DEFAULT 'registration_open' CHECK (game_phase IN (
    'registration_open', 'registration_closed', 'game_active', 'game_ended'
  )),
  registration_deadline DATE DEFAULT '2025-06-30',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO site_settings (id, game_phase, registration_deadline)
VALUES (1, 'registration_open', '2025-06-30')
ON CONFLICT (id) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_registrations_status ON registrations(status);
CREATE INDEX IF NOT EXISTS idx_cms_pages_slug ON cms_pages(slug);
CREATE INDEX IF NOT EXISTS idx_tournaments_status ON tournaments(status);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    console.log('Migration completed successfully.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
