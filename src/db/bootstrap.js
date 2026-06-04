import pool from './pool.js';
import { initSchemaMeta } from './schema-meta.js';
import { runMigrationsV3 } from './migrate-v3.js';

export async function bootstrapDatabase() {
  if (process.env.RUN_MIGRATIONS_ON_START !== 'false') {
    try {
      await runMigrationsV3(pool);
    } catch (err) {
      console.error('[bootstrap] Migration failed:', err.message);
      if (process.env.REQUIRE_MIGRATIONS === 'true') {
        throw err;
      }
    }
  }

  await initSchemaMeta(pool);
}
