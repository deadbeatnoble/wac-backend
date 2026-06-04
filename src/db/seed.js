import bcrypt from 'bcryptjs';
import pool from './pool.js';
import dotenv from 'dotenv';
import { CMS_PAGE_DEFAULTS } from '../data/cms-defaults.js';

dotenv.config();

const DEFAULT_BLOCKS = {
  home: [],
  about: [
    { id: '1', type: 'heading', data: { text: 'About Us', level: 1 } },
    { id: '2', type: 'paragraph', data: { text: 'We run fair, transparent tournaments with verified participants.' } },
  ],
  contact: [
    { id: '1', type: 'heading', data: { text: 'Contact Us', level: 1 } },
    { id: '2', type: 'paragraph', data: { text: 'Reach out at support@giveaway.local' } },
  ],
  results: [
    { id: '1', type: 'heading', data: { text: 'Tournament Results', level: 1 } },
    { id: '2', type: 'paragraph', data: { text: 'Results will appear here as tournaments complete.' } },
  ],
  news: [
    { id: '1', type: 'heading', data: { text: 'Latest News', level: 1 } },
    { id: '2', type: 'paragraph', data: { text: 'Stay tuned for tournament announcements.' } },
  ],
};

async function seed() {
  const client = await pool.connect();
  try {
    const email = process.env.ADMIN_EMAIL || 'admin@giveaway.local';
    const password = process.env.ADMIN_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);

    const adminRes = await client.query(
      `INSERT INTO admins (email, password_hash, name)
       VALUES ($1, $2, 'Site Admin')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [email, hash]
    );

    for (const [slug, blocks] of Object.entries(DEFAULT_BLOCKS)) {
      const title = slug.charAt(0).toUpperCase() + slug.slice(1);
      const texts = CMS_PAGE_DEFAULTS[slug];
      const meta = texts ? { texts } : {};
      await client.query(
        `INSERT INTO cms_pages (slug, title, status, blocks, meta)
         VALUES ($1, $2, 'published', $3::jsonb, $4::jsonb)
         ON CONFLICT (slug) DO NOTHING`,
        [slug, title === 'Home' ? 'Home' : title, JSON.stringify(blocks), JSON.stringify(meta)]
      );
    }

    for (const [slug, texts] of Object.entries(CMS_PAGE_DEFAULTS)) {
      await client.query(
        `UPDATE cms_pages SET meta = jsonb_set(COALESCE(meta, '{}'), '{texts}', $1::jsonb)
         WHERE slug = $2 AND (meta->'texts' IS NULL OR meta->'texts' = 'null'::jsonb OR meta->'texts' = '[]'::jsonb)`,
        [JSON.stringify(texts), slug]
      );
    }

    await client.query(
      `INSERT INTO site_settings (id, game_phase, registration_deadline)
       VALUES (1, 'registration_open', '2025-06-30')
       ON CONFLICT (id) DO NOTHING`
    );

    /*const tourCount = await client.query('SELECT COUNT(*) FROM tournaments');
    if (parseInt(tourCount.rows[0].count, 10) === 0) {
      await client.query(
        `INSERT INTO tournaments (name, status, registrations_open, prize_description)
         VALUES ('Grand Prize Tournament 2025', 'registration_open', true, 'Premium Car Package')`
      );
    }*/

    console.log('Seed completed.');
    if (adminRes.rows[0]) {
      console.log(`Admin created: ${email} / ${password}`);
    } else {
      console.log(`Admin already exists: ${email}`);
    }
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
