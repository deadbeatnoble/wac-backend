import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();

router.get('/logs', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const { action, entityType } = req.query;

    const params = [];
    const clauses = [];
    if (action) {
      params.push(action);
      clauses.push(`l.action = $${params.length}`);
    }
    if (entityType) {
      params.push(entityType);
      clauses.push(`l.entity_type = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM admin_audit_logs l ${where}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT l.*, a.email AS admin_email, a.name AS admin_name
       FROM admin_audit_logs l
       LEFT JOIN admins a ON a.id = l.admin_id
       ${where}
       ORDER BY l.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      logs: result.rows,
      total: countRes.rows[0].c,
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load audit logs' });
  }
});

router.get('/match-history', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const tournamentId = req.query.tournamentId
      ? parseInt(req.query.tournamentId, 10)
      : null;

    const params = [];
    let where = '';
    if (tournamentId) {
      params.push(tournamentId);
      where = `WHERE m.tournament_id = $1`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM match_result_history h
       JOIN tournament_matches m ON m.id = h.match_id
       ${where}`,
      params
    );

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT h.*, m.match_number, m.tournament_id, tr.name AS round_name,
        t.name AS tournament_name, a.email AS admin_email,
        r.first_name AS winner_first, r.last_name AS winner_last
       FROM match_result_history h
       JOIN tournament_matches m ON m.id = h.match_id
       JOIN tournament_rounds tr ON tr.id = m.round_id
       JOIN tournaments t ON t.id = m.tournament_id
       LEFT JOIN admins a ON a.id = h.admin_id
       LEFT JOIN tournament_participants tp ON tp.id = h.winner_participant_id
       LEFT JOIN registrations r ON r.id = tp.registration_id
       ${where}
       ORDER BY h.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      history: result.rows,
      total: countRes.rows[0].c,
      limit,
      offset,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load match history' });
  }
});

export default router;
