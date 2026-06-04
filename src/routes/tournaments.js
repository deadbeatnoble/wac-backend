import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import { calculateTournamentSchedule, buildRoundNames } from '../services/schedule.js';
import {
  getActiveTournamentId,
  getActiveTournament,
  setActiveTournament,
  logAdminAction,
} from '../services/active-tournament.js';
import { appendChampionToNews } from '../services/champion-news.js';

const router = Router();

function mapTournament(row, activeId) {
  if (!row) return null;
  return {
    ...row,
    is_active: row.id === activeId,
    participant_count: row.participant_count ?? row.participant_count,
  };
}

router.get('/dashboard/ops', requireAdmin, async (_req, res) => {
  try {
    const active = await getActiveTournament();
    const activeId = active?.id;
    let pendingMatches = 0;
    let activeRound = null;
    if (activeId) {
      const pm = await pool.query(
        `SELECT COUNT(*)::int AS c FROM tournament_matches
         WHERE tournament_id = $1 AND status != 'completed'`,
        [activeId]
      );
      pendingMatches = pm.rows[0].c;
      const ar = await pool.query(
        `SELECT * FROM tournament_rounds WHERE tournament_id = $1 AND status = 'active' LIMIT 1`,
        [activeId]
      );
      activeRound = ar.rows[0];
    }
    const pendingRegs = active?.pending_count ?? 0;
    res.json({
      activeTournament: active,
      activeRound,
      pendingApprovals: pendingRegs,
      pendingMatches,
      championStatus: active?.champion_published ? 'published' : active?.status === 'completed' ? 'pending_publish' : 'none',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load ops dashboard' });
  }
});

router.get('/dashboard/stats', requireAdmin, async (_req, res) => {
  const [regs, tours] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'pending')::int AS pending FROM registrations`),
    pool.query(`SELECT COUNT(*)::int AS active FROM tournaments WHERE status IN ('active', 'registration_open') AND NOT is_archived`),
  ]);
  res.json({ registrations: regs.rows[0], activeTournaments: tours.rows[0].active });
});

router.get('/', async (_req, res) => {
  const activeId = await getActiveTournamentId();
  const result = await pool.query(
    `SELECT t.*,
      (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id = t.id) AS participant_count,
      (SELECT COUNT(*)::int FROM registrations r WHERE r.tournament_id = t.id) AS registration_count,
      (t.id = $1) AS is_active
     FROM tournaments t
     ORDER BY is_archived ASC, created_at DESC`,
    [activeId]
  );
  res.json({ tournaments: result.rows, activeTournamentId: activeId });
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const {
      name, description, prizeDescription,
      registrationOpenDate, registrationCloseDate, startDate, endDate,
      maxParticipants, bannerUrl, registrationsOpen,
    } = req.body;
    const result = await pool.query(
      `INSERT INTO tournaments (
        name, description, prize_description, registration_open_date, registration_close_date,
        start_date, end_date, max_participants, banner_url, status, registrations_open
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'registration_open', $10) RETURNING *`,
      [
        name || 'New Tournament',
        description || null,
        prizeDescription || null,
        registrationOpenDate || null,
        registrationCloseDate || null,
        startDate || null,
        endDate || null,
        maxParticipants || null,
        bannerUrl || null,
        registrationsOpen !== false,
      ]
    );
    await logAdminAction(req.admin.id, 'create_tournament', 'tournament', result.rows[0].id, { name });
    res.status(201).json({ tournament: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tournament' });
  }
});

router.post('/:id/clone', requireAdmin, async (req, res) => {
  try {
    const source = await pool.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
    if (!source.rows[0]) return res.status(404).json({ error: 'Not found' });
    const s = source.rows[0];
    const result = await pool.query(
      `INSERT INTO tournaments (name, description, prize_description, max_participants, banner_url, status, registrations_open)
       VALUES ($1, $2, $3, $4, $5, 'registration_open', true) RETURNING *`,
      [
        `${s.name} (Copy)`,
        s.description,
        s.prize_description,
        s.max_participants,
        s.banner_url,
      ]
    );
    await logAdminAction(req.admin.id, 'clone_tournament', 'tournament', result.rows[0].id, { from: s.id });
    res.status(201).json({ tournament: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Clone failed' });
  }
});

router.get('/:id', async (req, res) => {
  const activeId = await getActiveTournamentId();
  const tour = await pool.query(
    `SELECT t.*,
      (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id = t.id) AS participant_count
     FROM tournaments t WHERE t.id = $1`,
    [req.params.id]
  );
  if (!tour.rows[0]) return res.status(404).json({ error: 'Not found' });

  const [participants, rounds, matches, champion] = await Promise.all([
    pool.query(
      `SELECT tp.*, r.first_name, r.last_name, r.email, r.id AS registration_id
       FROM tournament_participants tp
       JOIN registrations r ON r.id = tp.registration_id
       WHERE tp.tournament_id = $1 ORDER BY tp.seed NULLS LAST, tp.id`,
      [req.params.id]
    ),
    pool.query('SELECT * FROM tournament_rounds WHERE tournament_id = $1 ORDER BY round_number', [req.params.id]),
    pool.query(
      `SELECT m.*,
        p1r.first_name AS p1_first, p1r.last_name AS p1_last,
        p2r.first_name AS p2_first, p2r.last_name AS p2_last,
        wr.first_name AS winner_first, wr.last_name AS winner_last
       FROM tournament_matches m
       LEFT JOIN tournament_participants tp1 ON tp1.id = m.player1_id
       LEFT JOIN registrations p1r ON p1r.id = tp1.registration_id
       LEFT JOIN tournament_participants tp2 ON tp2.id = m.player2_id
       LEFT JOIN registrations p2r ON p2r.id = tp2.registration_id
       LEFT JOIN tournament_participants tpw ON tpw.id = m.winner_id
       LEFT JOIN registrations wr ON wr.id = tpw.registration_id
       WHERE m.tournament_id = $1 ORDER BY m.round_id, m.match_number`,
      [req.params.id]
    ),
    pool.query(
      `SELECT tp.id, r.first_name, r.last_name FROM tournaments t
       LEFT JOIN tournament_participants tp ON tp.id = t.champion_participant_id
       LEFT JOIN registrations r ON r.id = tp.registration_id
       WHERE t.id = $1`,
      [req.params.id]
    ),
  ]);

  res.json({
    tournament: { ...tour.rows[0], is_active: tour.rows[0].id === activeId },
    participants: participants.rows,
    rounds: rounds.rows,
    matches: matches.rows,
    champion: champion.rows[0],
  });
});

router.patch('/:id', requireAdmin, async (req, res) => {
  try {
    const fields = [
      'name', 'description', 'prize_description', 'registration_open_date', 'registration_close_date',
      'start_date', 'end_date', 'max_participants', 'banner_url', 'registrations_open', 'status',
    ];
    const body = req.body;
    const mapping = {
      name: 'name',
      description: 'description',
      prizeDescription: 'prize_description',
      registrationOpenDate: 'registration_open_date',
      registrationCloseDate: 'registration_close_date',
      startDate: 'start_date',
      endDate: 'end_date',
      maxParticipants: 'max_participants',
      bannerUrl: 'banner_url',
      registrationsOpen: 'registrations_open',
      status: 'status',
    };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, col] of Object.entries(mapping)) {
      if (body[key] !== undefined) {
        sets.push(`${col} = $${i++}`);
        values.push(body[key]);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = NOW()');
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE tournaments SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
    await logAdminAction(req.admin.id, 'update_tournament', 'tournament', result.rows[0].id, body);
    res.json({ tournament: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.post('/:id/activate', requireAdmin, async (req, res) => {
  try {
    const tournament = await setActiveTournament(parseInt(req.params.id, 10), req.admin.id);
    res.json({ tournament });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/archive', requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const activeId = await getActiveTournamentId();
    if (activeId === id) {
      return res.status(400).json({ error: 'Cannot archive the active tournament. Activate another first.' });
    }
    const result = await pool.query(
      `UPDATE tournaments SET is_archived = true, registrations_open = false, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id]
    );
    await logAdminAction(req.admin.id, 'archive_tournament', 'tournament', id, {});
    res.json({ tournament: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Archive failed' });
  }
});

router.patch('/:id/close-registrations', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `UPDATE tournaments SET registrations_open = false, status = 'registration_closed', updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ tournament: result.rows[0] });
});

router.post('/:id/sync-participants', requireAdmin, async (req, res) => {
  const tourId = req.params.id;
  const approved = await pool.query(
    `SELECT id FROM registrations WHERE status = 'approved' AND tournament_id = $1
     AND id NOT IN (SELECT registration_id FROM tournament_participants WHERE tournament_id = $1)`,
    [tourId]
  );
  for (const row of approved.rows) {
    await pool.query(
      'INSERT INTO tournament_participants (tournament_id, registration_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [tourId, row.id]
    );
  }
  const count = await pool.query(
    'SELECT COUNT(*)::int AS c FROM tournament_participants WHERE tournament_id = $1',
    [tourId]
  );
  res.json({ synced: approved.rows.length, totalParticipants: count.rows[0].c });
});

router.post('/:id/participants', requireAdmin, async (req, res) => {
  const { registrationId } = req.body;
  const result = await pool.query(
    `INSERT INTO tournament_participants (tournament_id, registration_id)
     VALUES ($1, $2) ON CONFLICT (tournament_id, registration_id) DO NOTHING RETURNING *`,
    [req.params.id, registrationId]
  );
  res.json({ participant: result.rows[0] });
});

router.delete('/:id/participants/:participantId', requireAdmin, async (req, res) => {
  const participantId = parseInt(req.params.participantId, 10);
  const tournamentId = parseInt(req.params.id, 10);

  const inMatch = await pool.query(
    `SELECT COUNT(*)::int AS c FROM tournament_matches
     WHERE tournament_id = $1 AND status != 'completed'
       AND (player1_id = $2 OR player2_id = $2)`,
    [tournamentId, participantId]
  );
  if (inMatch.rows[0].c > 0) {
    return res.status(400).json({
      error: 'Cannot remove a player assigned to a pending match. Replace them or complete matches first.',
    });
  }

  await pool.query('DELETE FROM tournament_participants WHERE id = $1 AND tournament_id = $2', [
    participantId,
    tournamentId,
  ]);
  await logAdminAction(req.admin.id, 'remove_participant', 'tournament', tournamentId, { participantId });
  res.json({ success: true });
});

router.get('/:id/roster', requireAdmin, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id, 10);
    const search = (req.query.search || '').trim();
    let query = `
      SELECT tp.*, r.first_name, r.last_name, r.email, r.status AS registration_status,
        r.player_profile_id, pp.email AS profile_email
      FROM tournament_participants tp
      JOIN registrations r ON r.id = tp.registration_id
      LEFT JOIN player_profiles pp ON pp.id = r.player_profile_id
      WHERE tp.tournament_id = $1`;
    const params = [tournamentId];
    if (search) {
      query += ` AND (
        r.first_name ILIKE $2 OR r.last_name ILIKE $2 OR r.email ILIKE $2
        OR (r.first_name || ' ' || r.last_name) ILIKE $2
      )`;
      params.push(`%${search}%`);
    }
    query += ' ORDER BY tp.eliminated ASC, tp.id ASC';
    const result = await pool.query(query, params);
    res.json({ participants: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load roster' });
  }
});

router.get('/:id/available-registrations', requireAdmin, async (req, res) => {
  const tournamentId = parseInt(req.params.id, 10);
  const result = await pool.query(
    `SELECT r.id, r.first_name, r.last_name, r.email, r.status
     FROM registrations r
     WHERE r.tournament_id = $1 AND r.status = 'approved'
       AND r.id NOT IN (
         SELECT registration_id FROM tournament_participants WHERE tournament_id = $1
       )
     ORDER BY r.last_name, r.first_name`,
    [tournamentId]
  );
  res.json({ registrations: result.rows });
});

router.patch('/:id/participants/:participantId/replace', requireAdmin, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id, 10);
    const participantId = parseInt(req.params.participantId, 10);
    const { registrationId } = req.body;
    if (!registrationId) return res.status(400).json({ error: 'registrationId required' });

    const won = await pool.query(
      `SELECT COUNT(*)::int AS c FROM tournament_matches
       WHERE tournament_id = $1 AND winner_id = $2 AND status = 'completed'`,
      [tournamentId, participantId]
    );
    if (won.rows[0].c > 0) {
      return res.status(400).json({
        error: 'Cannot replace a player who has won completed matches. Undo those matches first.',
      });
    }

    const reg = await pool.query(
      `SELECT id FROM registrations WHERE id = $1 AND tournament_id = $2 AND status = 'approved'`,
      [registrationId, tournamentId]
    );
    if (!reg.rows[0]) return res.status(400).json({ error: 'Invalid approved registration for this tournament' });

    const dup = await pool.query(
      `SELECT id FROM tournament_participants WHERE tournament_id = $1 AND registration_id = $2`,
      [tournamentId, registrationId]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'That registration is already on the roster' });

    await pool.query(
      `UPDATE tournament_participants SET registration_id = $2, eliminated = false WHERE id = $1 AND tournament_id = $3`,
      [participantId, registrationId, tournamentId]
    );

    await logAdminAction(req.admin.id, 'replace_participant', 'tournament', tournamentId, {
      participantId,
      registrationId,
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Replace failed' });
  }
});

router.get('/:id/export/participants', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT tp.id, r.first_name, r.last_name, r.email, tp.eliminated, tp.schedule_day
     FROM tournament_participants tp
     JOIN registrations r ON r.id = tp.registration_id
     WHERE tp.tournament_id = $1 ORDER BY tp.id`,
    [req.params.id]
  );
  res.json({ participants: result.rows });
});

router.post('/:id/calculate-schedule', requireAdmin, async (req, res) => {
  const { targetDays, endDate } = req.body;
  const tourId = req.params.id;
  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS c FROM tournament_participants WHERE tournament_id = $1',
    [tourId]
  );
  const approvedCount = countRes.rows[0].c;
  let days = parseInt(targetDays, 10);
  if (endDate) {
    const end = new Date(endDate);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    days = Math.max(1, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
  }
  if (!days || days < 1) days = 5;
  const schedule = calculateTournamentSchedule(approvedCount, days);
  await pool.query(
    `UPDATE tournaments SET schedule = $2::jsonb, end_date = $3, updated_at = NOW() WHERE id = $1`,
    [tourId, JSON.stringify(schedule), endDate || null]
  );
  const participants = await pool.query(
    'SELECT id FROM tournament_participants WHERE tournament_id = $1 ORDER BY id',
    [tourId]
  );
  if (schedule.days?.length && participants.rows.length) {
    const perDay = Math.ceil(participants.rows.length / schedule.days.length);
    for (let i = 0; i < participants.rows.length; i++) {
      const dayIndex = Math.min(Math.floor(i / perDay), schedule.days.length - 1);
      await pool.query('UPDATE tournament_participants SET schedule_day = $2 WHERE id = $1', [
        participants.rows[i].id,
        schedule.days[dayIndex].day,
      ]);
    }
  }
  res.json({ schedule, approvedCount });
});

router.post('/:id/start', requireAdmin, async (req, res) => {
  const tourId = req.params.id;
  const countRes = await pool.query(
    'SELECT COUNT(*)::int AS c FROM tournament_participants WHERE tournament_id = $1',
    [tourId]
  );
  const n = countRes.rows[0].c;
  if (n < 2) return res.status(400).json({ error: 'Need at least 2 participants' });

  const roundNames = buildRoundNames(n);
  await pool.query('DELETE FROM tournament_matches WHERE tournament_id = $1', [tourId]);
  await pool.query('DELETE FROM tournament_rounds WHERE tournament_id = $1', [tourId]);

  const rounds = [];
  for (let i = 0; i < roundNames.length; i++) {
    const r = await pool.query(
      `INSERT INTO tournament_rounds (tournament_id, round_number, name, status)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [tourId, i + 1, roundNames[i], i === 0 ? 'active' : 'pending']
    );
    rounds.push(r.rows[0]);
  }

  const participants = await pool.query(
    'SELECT id FROM tournament_participants WHERE tournament_id = $1 ORDER BY RANDOM()',
    [tourId]
  );
  const round1 = rounds[0];
  let matchNum = 1;
  for (let i = 0; i < participants.rows.length; i += 2) {
    await pool.query(
      `INSERT INTO tournament_matches (tournament_id, round_id, match_number, player1_id, player2_id, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')`,
      [tourId, round1.id, matchNum++, participants.rows[i]?.id, participants.rows[i + 1]?.id || null]
    );
  }

  await pool.query(
    `UPDATE tournaments SET status = 'active', registrations_open = false, updated_at = NOW() WHERE id = $1`,
    [tourId]
  );
  await logAdminAction(req.admin.id, 'start_tournament', 'tournament', parseInt(tourId, 10), {});
  res.json({ message: 'Tournament started', rounds: rounds.length });
});

router.patch('/matches/:matchId/winner', requireAdmin, async (req, res) => {
  const { winnerId, scheduledDate } = req.body;
  const matchRes = await pool.query('SELECT * FROM tournament_matches WHERE id = $1', [req.params.matchId]);
  const match = matchRes.rows[0];
  if (!match) return res.status(404).json({ error: 'Match not found' });

  if (winnerId && winnerId !== match.player1_id && winnerId !== match.player2_id) {
    return res.status(400).json({ error: 'Winner must be one of the match players' });
  }

  if (scheduledDate) {
    await pool.query('UPDATE tournament_matches SET scheduled_date = $2 WHERE id = $1', [
      match.id,
      scheduledDate,
    ]);
  }

  if (!winnerId) {
    await logAdminAction(req.admin.id, 'reschedule_match', 'match', match.id, { scheduledDate });
    return res.json({ success: true, rescheduled: true });
  }

  const isEdit = match.status === 'completed' && match.winner_id && match.winner_id !== winnerId;
  const action = isEdit ? 'edit' : 'set';

  if (isEdit) {
    const prevWinner = match.winner_id;
    const prevLoser = prevWinner === match.player1_id ? match.player2_id : match.player1_id;
    if (prevWinner) {
      await pool.query('UPDATE tournament_participants SET eliminated = false WHERE id = $1', [prevWinner]);
    }
    if (prevLoser) {
      await pool.query('UPDATE tournament_participants SET eliminated = false WHERE id = $1', [prevLoser]);
    }
  }

  await pool.query(
    `UPDATE tournament_matches SET winner_id = $2, status = 'completed' WHERE id = $1`,
    [match.id, winnerId]
  );

  await pool.query(
    `INSERT INTO match_result_history (match_id, winner_participant_id, action, admin_id)
     VALUES ($1, $2, $3, $4)`,
    [match.id, winnerId, action, req.admin.id]
  );

  const loserId = winnerId === match.player1_id ? match.player2_id : match.player1_id;
  if (loserId) {
    await pool.query('UPDATE tournament_participants SET eliminated = true WHERE id = $1', [loserId]);
  }

  if (isEdit) {
    await logAdminAction(req.admin.id, 'edit_match_winner', 'match', match.id, {
      prevWinner: match.winner_id,
      newWinner: winnerId,
    });
    return res.json({ success: true, edited: true, warning: 'Later-round matches were not changed. Undo or adjust manually if needed.' });
  }

  const roundRes = await pool.query('SELECT * FROM tournament_rounds WHERE id = $1', [match.round_id]);
  const pendingInRound = await pool.query(
    `SELECT COUNT(*)::int AS c FROM tournament_matches WHERE round_id = $1 AND status != 'completed'`,
    [match.round_id]
  );

  if (pendingInRound.rows[0].c === 0) {
    await pool.query(`UPDATE tournament_rounds SET status = 'completed' WHERE id = $1`, [match.round_id]);

    const nextRound = await pool.query(
      `SELECT * FROM tournament_rounds WHERE tournament_id = $1 AND round_number = $2`,
      [match.tournament_id, roundRes.rows[0].round_number + 1]
    );

    if (nextRound.rows[0]) {
      await pool.query(`UPDATE tournament_rounds SET status = 'active' WHERE id = $1`, [nextRound.rows[0].id]);
      const winners = await pool.query(
        `SELECT winner_id FROM tournament_matches WHERE round_id = $1 AND winner_id IS NOT NULL ORDER BY match_number`,
        [match.round_id]
      );
      let matchNum = 1;
      for (let i = 0; i < winners.rows.length; i += 2) {
        await pool.query(
          `INSERT INTO tournament_matches (tournament_id, round_id, match_number, player1_id, player2_id, status)
           VALUES ($1, $2, $3, $4, $5, 'pending')`,
          [
            match.tournament_id,
            nextRound.rows[0].id,
            matchNum++,
            winners.rows[i]?.winner_id,
            winners.rows[i + 1]?.winner_id || null,
          ]
        );
      }
    } else {
      await pool.query(`UPDATE tournaments SET status = 'completed', updated_at = NOW() WHERE id = $1`, [
        match.tournament_id,
      ]);
    }
  }

  res.json({ success: true });
});

router.post('/matches/:matchId/undo', requireAdmin, async (req, res) => {
  const matchRes = await pool.query('SELECT * FROM tournament_matches WHERE id = $1', [req.params.matchId]);
  const match = matchRes.rows[0];
  if (!match || match.status !== 'completed') {
    return res.status(400).json({ error: 'Can only undo completed matches' });
  }

  const prevWinner = match.winner_id;
  await pool.query(
    `UPDATE tournament_matches SET winner_id = NULL, status = 'pending' WHERE id = $1`,
    [match.id]
  );
  if (prevWinner) {
    await pool.query('UPDATE tournament_participants SET eliminated = false WHERE id = $1', [prevWinner]);
  }

  await pool.query(
    `INSERT INTO match_result_history (match_id, winner_participant_id, action, admin_id)
     VALUES ($1, $2, 'undo', $3)`,
    [match.id, prevWinner, req.admin.id]
  );

  await logAdminAction(req.admin.id, 'undo_match', 'match', match.id, { prevWinner });
  res.json({ success: true });
});

router.post('/:id/champion', requireAdmin, async (req, res) => {
  try {
    const tournamentId = parseInt(req.params.id, 10);
    const { participantId, prize, story, imageUrl, publish } = req.body;
    const result = await pool.query(
      `UPDATE tournaments SET
        champion_participant_id = $2,
        champion_prize = COALESCE($3, champion_prize),
        champion_story = COALESCE($4, champion_story),
        champion_image_url = COALESCE($5, champion_image_url),
        champion_published = COALESCE($6, champion_published),
        champion_published_at = CASE WHEN $6 = true THEN NOW() ELSE champion_published_at END,
        status = 'completed',
        updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [tournamentId, participantId, prize, story, imageUrl, publish === true]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Tournament not found' });

    let newsStory = null;
    if (publish === true && participantId) {
      const champ = await pool.query(
        `SELECT r.first_name, r.last_name FROM tournament_participants tp
         JOIN registrations r ON r.id = tp.registration_id WHERE tp.id = $1`,
        [participantId]
      );
      const championName = champ.rows[0]
        ? `${champ.rows[0].first_name} ${champ.rows[0].last_name}`.trim()
        : 'Champion';
      newsStory = await appendChampionToNews({
        tournamentId,
        tournamentName: result.rows[0].name,
        championName,
        story,
        prize,
        imageUrl,
      });
    }

    await logAdminAction(req.admin.id, 'set_champion', 'tournament', tournamentId, {
      participantId,
      publish,
    });
    res.json({ tournament: result.rows[0], newsStory });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to set champion' });
  }
});

router.get('/:id/match-history', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT h.*, m.match_number, tr.name AS round_name,
      a.email AS admin_email
     FROM match_result_history h
     JOIN tournament_matches m ON m.id = h.match_id
     JOIN tournament_rounds tr ON tr.id = m.round_id
     LEFT JOIN admins a ON a.id = h.admin_id
     WHERE m.tournament_id = $1
     ORDER BY h.created_at DESC
     LIMIT 100`,
    [req.params.id]
  );
  res.json({ history: result.rows });
});

router.get('/:id/export/matches', requireAdmin, async (req, res) => {
  const result = await pool.query(
    `SELECT m.*, tr.name AS round_name,
      p1r.first_name AS p1_first, p1r.last_name AS p1_last,
      p2r.first_name AS p2_first, p2r.last_name AS p2_last,
      wr.first_name AS winner_first, wr.last_name AS winner_last
     FROM tournament_matches m
     JOIN tournament_rounds tr ON tr.id = m.round_id
     LEFT JOIN tournament_participants tp1 ON tp1.id = m.player1_id
     LEFT JOIN registrations p1r ON p1r.id = tp1.registration_id
     LEFT JOIN tournament_participants tp2 ON tp2.id = m.player2_id
     LEFT JOIN registrations p2r ON p2r.id = tp2.registration_id
     LEFT JOIN tournament_participants tpw ON tpw.id = m.winner_id
     LEFT JOIN registrations wr ON wr.id = tpw.registration_id
     WHERE m.tournament_id = $1 ORDER BY tr.round_number, m.match_number`,
    [req.params.id]
  );
  res.json({ matches: result.rows });
});

export default router;
