import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { sendRegistrationApproved, sendRegistrationRejected } from '../services/mail.js';
import {
  getActiveTournament,
  getActiveTournamentId,
  tournamentToPublicPhase,
  logAdminAction,
} from '../services/active-tournament.js';

const router = Router();

async function upsertPlayerProfile(client, { email, firstName, lastName, phone, country }) {
  const normalized = email.toLowerCase();
  const existing = await client.query('SELECT id FROM player_profiles WHERE email = $1', [normalized]);
  if (existing.rows[0]) {
    await client.query(
      `UPDATE player_profiles SET first_name = $2, last_name = $3, phone = COALESCE($4, phone),
        country = COALESCE($5, country), updated_at = NOW() WHERE id = $1`,
      [existing.rows[0].id, firstName, lastName, phone, country]
    );
    return existing.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO player_profiles (email, first_name, last_name, phone, country)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [normalized, firstName, lastName, phone || null, country || null]
  );
  return ins.rows[0].id;
}

router.post('/', async (req, res) => {
  const client = await pool.connect();
  try {
    const active = await getActiveTournament();
    if (!active) {
      return res.status(403).json({ error: 'No active tournament accepting registrations' });
    }
    const phase = tournamentToPublicPhase(active);
    if (!phase.registrationOpen) {
      return res.status(403).json({ error: 'Registration is currently closed for this tournament' });
    }

    if (active.max_participants) {
      const count = await client.query(
        `SELECT COUNT(*)::int AS c FROM registrations WHERE tournament_id = $1`,
        [active.id]
      );
      if (count.rows[0].c >= active.max_participants) {
        return res.status(403).json({ error: 'This tournament has reached maximum participants' });
      }
    }

    const {
      firstName, lastName, email, password,
      phone, country, experience,
      paymentAccount, paymentScreenshot,
    } = req.body;

    if (!firstName || !lastName || !email || !paymentAccount || !paymentScreenshot) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    await client.query('BEGIN');
    const profileId = await upsertPlayerProfile(client, {
      email, firstName, lastName, phone, country,
    });

    const dup = await client.query(
      `SELECT id FROM registrations WHERE tournament_id = $1 AND player_profile_id = $2`,
      [active.id, profileId]
    );
    if (dup.rows.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You are already registered for this tournament' });
    }

    const passwordHash = await bcrypt.hash(password || crypto.randomUUID(), 10);
    const result = await client.query(
      `INSERT INTO registrations
        (first_name, last_name, email, password_hash, phone, country, experience,
         payment_account, payment_screenshot, status, tournament_id, player_profile_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', $10, $11)
       RETURNING id, first_name, last_name, email, status, tournament_id, created_at`,
      [
        firstName, lastName, email.toLowerCase(), passwordHash,
        phone || null, country || null, experience || null,
        paymentAccount, paymentScreenshot,
        active.id, profileId,
      ]
    );
    await client.query('COMMIT');

    res.status(201).json({
      message: 'Registration submitted. Awaiting admin approval.',
      registration: result.rows[0],
      tournament: { id: active.id, name: active.name },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Already registered for this tournament' });
    }
    res.status(500).json({ error: 'Registration failed' });
  } finally {
    client.release();
  }
});

router.get('/', requireAdmin, async (req, res) => {
  try {
    const { status, tournamentId } = req.query;
    let query = `
      SELECT r.id, r.first_name, r.last_name, r.email, r.phone, r.country, r.experience,
             r.payment_account, r.payment_screenshot, r.status, r.rejection_reason,
             r.reviewed_at, r.created_at, r.tournament_id, r.player_profile_id,
             t.name AS tournament_name
      FROM registrations r
      LEFT JOIN tournaments t ON t.id = r.tournament_id`;
    const params = [];
    const clauses = [];
    if (tournamentId) {
      clauses.push(`r.tournament_id = $${params.length + 1}`);
      params.push(parseInt(tournamentId, 10));
    }
    if (status) {
      clauses.push(`r.status = $${params.length + 1}`);
      params.push(status);
    }
    if (clauses.length) query += ` WHERE ${clauses.join(' AND ')}`;
    query += ' ORDER BY r.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ registrations: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

router.get('/stats', requireAdmin, async (req, res) => {
  const tournamentId = req.query.tournamentId
    ? parseInt(req.query.tournamentId, 10)
    : await getActiveTournamentId();
  const result = await pool.query(
    `SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE status = 'approved')::int AS approved,
      COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected
    FROM registrations
    WHERE ($1::int IS NULL OR tournament_id = $1)`,
    [tournamentId || null]
  );
  res.json({ ...result.rows[0], tournamentId });
});

router.get('/export', requireAdmin, async (req, res) => {
  const tournamentId = req.query.tournamentId;
  let query = `SELECT r.*, t.name AS tournament_name FROM registrations r
    LEFT JOIN tournaments t ON t.id = r.tournament_id`;
  const params = [];
  if (tournamentId) {
    query += ' WHERE r.tournament_id = $1';
    params.push(parseInt(tournamentId, 10));
  }
  query += ' ORDER BY r.created_at DESC';
  const result = await pool.query(query, params);
  res.json({ registrations: result.rows });
});

router.patch('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE registrations SET status = 'approved', rejection_reason = NULL,
        reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $1
       RETURNING *`,
      [id, req.admin.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });

    const reg = result.rows[0];
    const tour = await pool.query('SELECT name FROM tournaments WHERE id = $1', [reg.tournament_id]);
    await sendRegistrationApproved({
      email: reg.email,
      firstName: reg.first_name,
      tournamentName: tour.rows[0]?.name || 'Tournament',
    }).catch(console.error);

    await logAdminAction(req.admin.id, 'approve_registration', 'registration', reg.id, {
      tournamentId: reg.tournament_id,
    });

    res.json({ registration: reg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Approval failed' });
  }
});

router.get('/by-profile/:profileId', requireAdmin, async (req, res) => {
  try {
    const profileId = parseInt(req.params.profileId, 10);
    const [profile, registrations] = await Promise.all([
      pool.query('SELECT id, email, first_name, last_name FROM player_profiles WHERE id = $1', [profileId]),
      pool.query(
        `SELECT r.id, r.status, r.created_at, r.tournament_id, t.name AS tournament_name
         FROM registrations r
         LEFT JOIN tournaments t ON t.id = r.tournament_id
         WHERE r.player_profile_id = $1 ORDER BY r.created_at DESC`,
        [profileId]
      ),
    ]);
    if (!profile.rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ player: profile.rows[0], registrations: registrations.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load player' });
  }
});

router.patch('/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    if (!reason?.trim()) {
      return res.status(400).json({ error: 'Rejection reason is required' });
    }

    const result = await pool.query(
      `UPDATE registrations SET status = 'rejected', rejection_reason = $2,
        reviewed_at = NOW(), reviewed_by = $3
       WHERE id = $1 RETURNING *`,
      [id, reason.trim(), req.admin.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });

    const reg = result.rows[0];
    await sendRegistrationRejected({
      email: reg.email,
      firstName: reg.first_name,
      reason: reg.rejection_reason,
    }).catch(console.error);

    await logAdminAction(req.admin.id, 'reject_registration', 'registration', reg.id, { reason });

    res.json({ registration: reg });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Rejection failed' });
  }
});

export default router;
