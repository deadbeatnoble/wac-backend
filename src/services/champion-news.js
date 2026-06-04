import pool from '../db/pool.js';

/** Append a champion story to the news CMS page meta when published. */
export async function appendChampionToNews({ tournamentId, tournamentName, championName, story, prize, imageUrl }) {
  const row = await pool.query('SELECT meta FROM cms_pages WHERE slug = $1', ['news']);
  const meta = row.rows[0]?.meta || {};
  const stories = Array.isArray(meta.stories) ? [...meta.stories] : [];

  const entry = {
    id: `champion-${tournamentId}`,
    type: 'champion',
    category: 'Champion',
    title: `${championName} wins ${tournamentName}`,
    excerpt: story || `Congratulations to our ${tournamentName} champion!`,
    body: story || null,
    prize: prize || null,
    imageUrl: imageUrl || null,
    date: new Date().toISOString(),
    tournamentId,
  };

  const idx = stories.findIndex((s) => s.id === entry.id);
  if (idx >= 0) stories[idx] = entry;
  else stories.unshift(entry);

  const nextMeta = { ...meta, stories: stories.slice(0, 50) };
  await pool.query(
    `UPDATE cms_pages SET meta = $2::jsonb, updated_at = NOW() WHERE slug = 'news'`,
    [JSON.stringify(nextMeta)]
  );
  return entry;
}
