import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { parseProfileId } from '../lib/ids.js';

const router = Router();

router.get('/search', requireAdmin, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ players: [] });

    const result = await pool.query(
      `SELECT pp.id, pp.email, pp.first_name, pp.last_name, pp.phone, pp.country,
        (SELECT COUNT(*)::int FROM registrations r WHERE r.player_profile_id = pp.id) AS registration_count
       FROM player_profiles pp
       WHERE pp.email ILIKE $1 OR pp.first_name ILIKE $1 OR pp.last_name ILIKE $1
          OR (pp.first_name || ' ' || pp.last_name) ILIKE $1
       ORDER BY pp.updated_at DESC
       LIMIT 25`,
      [`%${q}%`]
    );
    res.json({ players: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Search failed' });
  }
});

router.get('/:id/history', requireAdmin, async (req, res) => {
  try {
    const profileId = parseProfileId(req.params.id);
    const [profile, registrations, participations] = await Promise.all([
      pool.query('SELECT * FROM player_profiles WHERE id = $1', [profileId]),
      pool.query(
        `SELECT r.id, r.status, r.created_at, r.tournament_id, t.name AS tournament_name
         FROM registrations r
         LEFT JOIN tournaments t ON t.id = r.tournament_id
         WHERE r.player_profile_id = $1
         ORDER BY r.created_at DESC`,
        [profileId]
      ),
      pool.query(
        `SELECT tp.id AS participant_id, tp.eliminated, t.id AS tournament_id, t.name AS tournament_name,
          t.status AS tournament_status, t.champion_participant_id = tp.id AS is_champion
         FROM tournament_participants tp
         JOIN tournaments t ON t.id = tp.tournament_id
         JOIN registrations r ON r.id = tp.registration_id
         WHERE r.player_profile_id = $1
         ORDER BY t.created_at DESC`,
        [profileId]
      ),
    ]);

    if (!profile.rows[0]) return res.status(404).json({ error: 'Player not found' });

    res.json({
      player: profile.rows[0],
      registrations: registrations.rows,
      tournaments: participations.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load history' });
  }
});

export default router;
