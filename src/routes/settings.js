import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  getActiveTournament,
  getSiteSettings,
  setActiveTournament,
  tournamentToPublicPhase,
  logAdminAction,
} from '../services/active-tournament.js';
import { parseTournamentId } from '../lib/ids.js';
import { asyncHandler } from '../middleware/db-errors.js';

const router = Router();

export const PHASES = ['registration_open', 'registration_closed', 'game_active', 'game_ended'];

async function applyPhaseToActiveTournament(phase) {
  const active = await getActiveTournament();
  if (!active) throw new Error('No active tournament. Create and activate a tournament first.');

  let registrationsOpen = false;
  let status = active.status;

  switch (phase) {
    case 'registration_open':
      registrationsOpen = true;
      status = 'registration_open';
      break;
    case 'registration_closed':
      registrationsOpen = false;
      status = 'registration_closed';
      break;
    case 'game_active':
      registrationsOpen = false;
      status = 'active';
      break;
    case 'game_ended':
      registrationsOpen = false;
      status = 'completed';
      break;
    default:
      break;
  }

  await pool.query(
    `UPDATE tournaments SET registrations_open = $1, status = $2, updated_at = NOW() WHERE id = $3`,
    [registrationsOpen, status, active.id]
  );

  await pool.query(
    `UPDATE site_settings SET game_phase = $1, updated_at = NOW() WHERE id = 1`,
    [phase]
  );

  return getActiveTournament();
}

function toResponse(settings, tournament) {
  const phase = tournamentToPublicPhase(tournament);
  return {
    gamePhase: phase.gamePhase,
    registrationOpen: phase.registrationOpen,
    registrationDeadline: tournament?.registration_close_date || settings.registration_deadline,
    activeTournamentId: settings.active_tournament_id,
    activeTournament: tournament
      ? {
          id: tournament.id,
          name: tournament.name,
          status: tournament.status,
          registrationsOpen: tournament.registrations_open,
          description: tournament.description,
          bannerUrl: tournament.banner_url,
          registrationOpenDate: tournament.registration_open_date,
          registrationCloseDate: tournament.registration_close_date,
          startDate: tournament.start_date,
          endDate: tournament.end_date,
          maxParticipants: tournament.max_participants,
          prizeDescription: tournament.prize_description,
          isArchived: tournament.is_archived,
          championPublished: tournament.champion_published,
        }
      : null,
    updatedAt: settings.updated_at,
  };
}

router.get('/', async (_req, res) => {
  try {
    const settings = await getSiteSettings();
    const tournament = await getActiveTournament();
    res.json(toResponse(settings, tournament));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/', requireAdmin, async (req, res) => {
  try {
    const { gamePhase, registrationDeadline } = req.body;
    const settings = await getSiteSettings();

    if (gamePhase && PHASES.includes(gamePhase)) {
      await applyPhaseToActiveTournament(gamePhase);
    }

    if (registrationDeadline) {
      const active = await getActiveTournament();
      if (active) {
        await pool.query(
          `UPDATE tournaments SET registration_close_date = $1, updated_at = NOW() WHERE id = $2`,
          [registrationDeadline, active.id]
        );
      }
      await pool.query(
        `UPDATE site_settings SET registration_deadline = $1, updated_at = NOW() WHERE id = 1`,
        [registrationDeadline]
      );
    }

    const updatedSettings = await getSiteSettings();
    const tournament = await getActiveTournament();
    res.json(toResponse(updatedSettings, tournament));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to update settings' });
  }
});

router.post('/phase/:phase', requireAdmin, async (req, res) => {
  try {
    const { phase } = req.params;
    if (!PHASES.includes(phase)) {
      return res.status(400).json({ error: 'Invalid phase' });
    }
    await applyPhaseToActiveTournament(phase);
    const settings = await getSiteSettings();
    const tournament = await getActiveTournament();
    res.json(toResponse(settings, tournament));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'Failed to update phase' });
  }
});

router.post('/active-tournament/:id', requireAdmin, asyncHandler(async (req, res) => {
  try {
    const tournament = await setActiveTournament(parseTournamentId(req.params.id), req.admin.id);
    const settings = await getSiteSettings();
    res.json(toResponse(settings, tournament));
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message || 'Failed to set active tournament' });
  }
}));

export default router;
export { getSiteSettings };
