import { getColumnMeta } from '../db/schema-meta.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class IdValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdValidationError';
    this.statusCode = 400;
  }
}

/**
 * Parse a route/body ID to the correct JS type for pg based on actual column type.
 */
export function parseEntityId(value, table, column) {
  if (value === undefined || value === null || value === '') {
    throw new IdValidationError(`${column} is required`);
  }

  const raw = String(value).trim();
  const meta = getColumnMeta(table, column);

  if (!meta) {
    if (UUID_RE.test(raw)) return raw;
    if (/^\d+$/.test(raw)) return Number(raw);
    throw new IdValidationError(`Invalid ID format for ${table}.${column}`);
  }

  if (meta.udtName === 'uuid' || meta.dataType === 'uuid') {
    if (!UUID_RE.test(raw)) {
      throw new IdValidationError(`Invalid UUID format for ${table}.${column}`);
    }
    return raw;
  }

  if (meta.dataType === 'integer' || meta.dataType === 'bigint' || meta.dataType === 'smallint') {
    if (!/^\d+$/.test(raw)) {
      throw new IdValidationError(`Invalid numeric ID for ${table}.${column}`);
    }
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1) {
      throw new IdValidationError(`Invalid numeric ID for ${table}.${column}`);
    }
    return n;
  }

  return raw;
}

export function parseOptionalEntityId(value, table, column) {
  if (value === undefined || value === null || value === '') return null;
  return parseEntityId(value, table, column);
}

export const parseTournamentId = (v) => parseEntityId(v, 'tournaments', 'id');
export const parseRegistrationId = (v) => parseEntityId(v, 'registrations', 'id');
export const parseParticipantId = (v) => parseEntityId(v, 'tournament_participants', 'id');
export const parseMatchId = (v) => parseEntityId(v, 'tournament_matches', 'id');
export const parseProfileId = (v) => parseEntityId(v, 'player_profiles', 'id');
export const parseAdminId = (v) => parseEntityId(v, 'admins', 'id');

export function isValidEntityId(value, table, column) {
  try {
    parseEntityId(value, table, column);
    return true;
  } catch {
    return false;
  }
}
