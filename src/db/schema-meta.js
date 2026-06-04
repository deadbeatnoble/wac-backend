/**
 * Caches PostgreSQL column types so ID parsing matches the live schema.
 */
const columnCache = new Map();

const TRACKED_COLUMNS = [
  ['tournaments', 'id'],
  ['registrations', 'id'],
  ['registrations', 'tournament_id'],
  ['registrations', 'player_profile_id'],
  ['tournament_participants', 'id'],
  ['tournament_participants', 'tournament_id'],
  ['tournament_participants', 'registration_id'],
  ['tournament_rounds', 'id'],
  ['tournament_rounds', 'tournament_id'],
  ['tournament_matches', 'id'],
  ['tournament_matches', 'tournament_id'],
  ['tournament_matches', 'round_id'],
  ['player_profiles', 'id'],
  ['admins', 'id'],
  ['site_settings', 'active_tournament_id'],
];

function key(table, column) {
  return `${table}.${column}`;
}

export async function initSchemaMeta(pool) {
  const tables = [...new Set(TRACKED_COLUMNS.map(([t]) => t))];
  const result = await pool.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [tables]
  );

  columnCache.clear();
  for (const row of result.rows) {
    columnCache.set(key(row.table_name, row.column_name), {
      table: row.table_name,
      column: row.column_name,
      dataType: row.data_type,
      udtName: row.udt_name,
      nullable: row.is_nullable === 'YES',
    });
  }

  const missing = TRACKED_COLUMNS.filter(([t, c]) => !columnCache.has(key(t, c)));
  if (missing.length) {
    console.warn(
      '[schema] Missing expected columns (run npm run db:migrate:v3):',
      missing.map(([t, c]) => `${t}.${c}`).join(', ')
    );
  }

  const tourId = columnCache.get(key('tournaments', 'id'));
  if (tourId) {
    console.log(`[schema] tournaments.id type: ${tourId.udtName || tourId.dataType}`);
  }
}

export function getColumnMeta(table, column) {
  return columnCache.get(key(table, column)) ?? null;
}

export function isUuidColumn(table, column) {
  const meta = getColumnMeta(table, column);
  return meta?.udtName === 'uuid' || meta?.dataType === 'uuid';
}

export function listCachedColumns() {
  return [...columnCache.entries()];
}
