import { Router } from 'express';
import pool from '../db/pool.js';
import { getActiveTournament, getActiveTournamentId } from '../services/active-tournament.js';

const router = Router();

async function loadTournamentBracket(tournamentId) {
  const [tournament, rounds, matches, participants] = await Promise.all([
    pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]),
    pool.query(
      'SELECT * FROM tournament_rounds WHERE tournament_id = $1 ORDER BY round_number',
      [tournamentId]
    ),
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
       WHERE m.tournament_id = $1
       ORDER BY m.round_id, m.match_number`,
      [tournamentId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM tournament_matches WHERE tournament_id = $1`,
      [tournamentId]
    ),
  ]);

  return {
    tournament: tournament.rows[0],
    rounds: rounds.rows,
    matches: matches.rows,
    matchStats: participants.rows[0],
  };
}

router.get('/active-tournament', async (_req, res) => {
  try {
    const tournament = await getActiveTournament();
    if (!tournament) return res.json({ tournament: null });
    res.json({
      tournament: {
        id: tournament.id,
        name: tournament.name,
        description: tournament.description,
        status: tournament.status,
        registrationsOpen: tournament.registrations_open,
        bannerUrl: tournament.banner_url,
        registrationOpenDate: tournament.registration_open_date,
        registrationCloseDate: tournament.registration_close_date,
        startDate: tournament.start_date,
        endDate: tournament.end_date,
        prizeDescription: tournament.prize_description,
        participantCount: tournament.participant_count,
        registrationCount: tournament.registration_count,
        championPublished: tournament.champion_published,
        championPrize: tournament.champion_prize,
        championStory: tournament.champion_story,
        championImageUrl: tournament.champion_image_url,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load active tournament' });
  }
});

router.get('/bracket', async (req, res) => {
  try {
    const tournamentId = req.query.tournamentId
      ? parseInt(req.query.tournamentId, 10)
      : await getActiveTournamentId();
    if (!tournamentId) return res.json({ tournament: null, rounds: [], matches: [] });

    const data = await loadTournamentBracket(tournamentId);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load bracket' });
  }
});

router.get('/results', async (_req, res) => {
  try {
    const activeId = await getActiveTournamentId();

    const past = await pool.query(
      `SELECT t.id, t.name, t.start_date, t.end_date, t.prize_description, t.champion_published,
              t.champion_prize, t.champion_story, t.champion_image_url, t.status,
              r.first_name AS champion_first, r.last_name AS champion_last
       FROM tournaments t
       LEFT JOIN tournament_participants tp ON tp.id = t.champion_participant_id
       LEFT JOIN registrations r ON r.id = tp.registration_id
       WHERE t.status = 'completed' OR t.champion_published = true
       ORDER BY t.end_date DESC NULLS LAST, t.created_at DESC`
    );

    let current = null;
    if (activeId) {
      current = await loadTournamentBracket(activeId);
    }

    const champions = past.rows.filter((t) => t.champion_first || t.champion_published);

    res.json({
      current: current
        ? {
            tournament: current.tournament,
            rounds: current.rounds,
            matches: current.matches,
            matchStats: current.matchStats,
          }
        : null,
      pastTournaments: past.rows.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.start_date,
        endDate: t.end_date,
        prizeDescription: t.prize_description,
        championName: t.champion_first && t.champion_last ? `${t.champion_first} ${t.champion_last}` : null,
        championPrize: t.champion_prize,
        championStory: t.champion_story,
        championImageUrl: t.champion_image_url,
        status: t.status,
      })),
      hallOfFame: champions.map((t) => ({
        tournamentId: t.id,
        tournamentName: t.name,
        championName: `${t.champion_first || ''} ${t.champion_last || ''}`.trim(),
        prize: t.champion_prize || t.prize_description,
        endDate: t.end_date,
        story: t.champion_story,
        imageUrl: t.champion_image_url,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load results' });
  }
});

router.get('/stats', async (_req, res) => {
  try {
    const active = await getActiveTournament();
    const [totalRegs, totalTours, champs, allMatches, bracketPlayers, completedTours] =
      await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM registrations`),
        pool.query(`SELECT COUNT(*)::int AS c FROM tournaments WHERE NOT is_archived`),
        pool.query(`SELECT COUNT(*)::int AS c FROM tournaments WHERE champion_published = true`),
        pool.query(
          `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM tournament_matches`
        ),
        pool.query(`SELECT COUNT(*)::int AS c FROM tournament_participants`),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM tournaments WHERE status = 'completed' AND NOT is_archived`
        ),
      ]);

    let activeMatches = { total: 0, completed: 0 };
    let activeBracketSize = 0;
    if (active?.id) {
      const [m, bp] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
           FROM tournament_matches WHERE tournament_id = $1`,
          [active.id]
        ),
        pool.query(
          `SELECT COUNT(*)::int AS c FROM tournament_participants WHERE tournament_id = $1`,
          [active.id]
        ),
      ]);
      activeMatches = m.rows[0];
      activeBracketSize = bp.rows[0].c;
    }

    res.json({
      participantsRegistered: active?.registration_count ?? 0,
      activeTournamentName: active?.name ?? null,
      activeTournamentStatus: active?.status ?? null,
      matchesPlayed: activeMatches.completed,
      totalMatches: activeMatches.total,
      totalRegistrations: totalRegs.rows[0].c,
      totalTournaments: totalTours.rows[0].c,
      previousChampions: champs.rows[0].c,
      allTimeMatchesPlayed: allMatches.rows[0].completed,
      allTimeMatchesTotal: allMatches.rows[0].total,
      allTimeBracketEntries: bracketPlayers.rows[0].c,
      completedTournaments: completedTours.rows[0].c,
      activeBracketParticipants: activeBracketSize,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

export default router;
