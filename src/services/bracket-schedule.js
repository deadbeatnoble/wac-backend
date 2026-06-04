import pool from '../db/pool.js';
import { getMatchScheduledDate } from './schedule.js';

/**
 * Apply stored tournament.schedule dates to all existing matches.
 */
export async function applyScheduleToBracket(tournamentId, schedule) {
  if (!schedule?.matchPlan?.length) return { updated: 0 };

  const matches = await pool.query(
    `SELECT m.id, m.match_number, tr.round_number
     FROM tournament_matches m
     JOIN tournament_rounds tr ON tr.id = m.round_id
     WHERE m.tournament_id = $1`,
    [tournamentId]
  );

  let updated = 0;
  for (const m of matches.rows) {
    const date = getMatchScheduledDate(schedule, m.round_number, m.match_number);
    if (date) {
      await pool.query('UPDATE tournament_matches SET scheduled_date = $2 WHERE id = $1', [
        m.id,
        date,
      ]);
      updated += 1;
    }
  }
  return { updated };
}
