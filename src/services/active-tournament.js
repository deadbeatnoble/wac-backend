import pool from '../db/pool.js';

export async function getSiteSettings() {
  const result = await pool.query('SELECT * FROM site_settings WHERE id = 1');
  if (!result.rows[0]) {
    await pool.query(
      `INSERT INTO site_settings (id, game_phase, registration_deadline)
       VALUES (1, 'registration_open', CURRENT_DATE + INTERVAL '30 days')
       ON CONFLICT (id) DO NOTHING`
    );
    const again = await pool.query('SELECT * FROM site_settings WHERE id = 1');
    return again.rows[0];
  }
  return result.rows[0];
}

export async function getActiveTournamentId() {
  const settings = await getSiteSettings();
  return settings.active_tournament_id ?? null;
}

export async function getActiveTournament() {
  const id = await getActiveTournamentId();
  if (!id) return null;
  const result = await pool.query(
    `SELECT t.*,
      (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id = t.id) AS participant_count,
      (SELECT COUNT(*)::int FROM registrations r WHERE r.tournament_id = t.id) AS registration_count,
      (SELECT COUNT(*)::int FROM registrations r WHERE r.tournament_id = t.id AND r.status = 'pending') AS pending_count,
      (t.id = (SELECT active_tournament_id FROM site_settings WHERE id = 1)) AS is_active
     FROM tournaments t WHERE t.id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export function tournamentToPublicPhase(tournament) {
  if (!tournament) return { gamePhase: 'registration_closed', registrationOpen: false };
  if (tournament.is_archived) return { gamePhase: 'game_ended', registrationOpen: false };
  if (tournament.status === 'completed' || tournament.champion_published) {
    return { gamePhase: 'game_ended', registrationOpen: false };
  }
  if (tournament.status === 'active') {
    return { gamePhase: 'game_active', registrationOpen: false };
  }
  if (tournament.registrations_open || tournament.status === 'registration_open') {
    return { gamePhase: 'registration_open', registrationOpen: true };
  }
  return { gamePhase: 'registration_closed', registrationOpen: false };
}

export async function setActiveTournament(tournamentId, adminId = null) {
  const tour = await pool.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
  if (!tour.rows[0]) throw new Error('Tournament not found');
  if (tour.rows[0].is_archived) throw new Error('Cannot activate an archived tournament');

  await pool.query(
    `UPDATE site_settings SET active_tournament_id = $1, updated_at = NOW() WHERE id = 1`,
    [tournamentId]
  );

  if (adminId) {
    await pool.query(
      `INSERT INTO admin_audit_logs (admin_id, action, entity_type, entity_id, details)
       VALUES ($1, 'set_active_tournament', 'tournament', $2, $3)`,
      [adminId, tournamentId, JSON.stringify({ name: tour.rows[0].name })]
    );
  }

  return getActiveTournament();
}

export async function logAdminAction(adminId, action, entityType, entityId, details = {}) {
  const entityIdValue =
    entityId === undefined || entityId === null ? null : String(entityId);
  await pool.query(
    `INSERT INTO admin_audit_logs (admin_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [adminId, action, entityType, entityIdValue, JSON.stringify(details)]
  );
}
