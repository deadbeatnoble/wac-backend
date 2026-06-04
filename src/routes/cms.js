import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAdmin } from '../middleware/auth.js';

const router = Router();
const VALID_SLUGS = ['home', 'about', 'contact', 'results', 'news'];

router.get('/pages', requireAdmin, async (req, res) => {
  const result = await pool.query(
    'SELECT id, slug, title, status, updated_at FROM cms_pages ORDER BY slug'
  );
  res.json({ pages: result.rows });
});

router.get('/pages/:slug', async (req, res) => {
  const { slug } = req.params;
  const result = await pool.query('SELECT * FROM cms_pages WHERE slug = $1', [slug]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Page not found' });

  const page = result.rows[0];
  if (page.status !== 'published' && !req.headers.authorization) {
    return res.status(404).json({ error: 'Page not found' });
  }
  res.json({ page });
});

router.get('/pages/:slug/admin', requireAdmin, async (req, res) => {
  const result = await pool.query('SELECT * FROM cms_pages WHERE slug = $1', [req.params.slug]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Page not found' });
  res.json({ page: result.rows[0] });
});

router.put('/pages/:slug', requireAdmin, async (req, res) => {
  try {
    const { slug } = req.params;
    if (!VALID_SLUGS.includes(slug)) {
      return res.status(400).json({ error: 'Invalid page slug' });
    }

    const { title, status, blocks, meta, texts } = req.body;
    let metaPayload = meta;
    if (texts && VALID_SLUGS.includes(slug)) {
      const existing = await pool.query('SELECT meta FROM cms_pages WHERE slug = $1', [slug]);
      const currentMeta = existing.rows[0]?.meta || {};
      metaPayload = { ...currentMeta, ...(meta || {}), texts };
    }
    const result = await pool.query(
      `UPDATE cms_pages SET
        title = COALESCE($2, title),
        status = COALESCE($3, status),
        blocks = COALESCE($4::jsonb, blocks),
        meta = COALESCE($5::jsonb, meta),
        updated_at = NOW(),
        updated_by = $6
       WHERE slug = $1
       RETURNING *`,
      [
        slug,
        title,
        status,
        blocks ? JSON.stringify(blocks) : null,
        metaPayload ? JSON.stringify(metaPayload) : null,
        req.admin.id,
      ]
    );

    if (!result.rows[0]) return res.status(404).json({ error: 'Page not found' });
    res.json({ page: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save page' });
  }
});

export default router;
