import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.js';
import registrationRoutes from './routes/registrations.js';
import cmsRoutes from './routes/cms.js';
import tournamentRoutes from './routes/tournaments.js';
import uploadRoutes from './routes/upload.js';
import settingsRoutes from './routes/settings.js';
import publicRoutes from './routes/public.js';
import playerRoutes from './routes/players.js';
import auditRoutes from './routes/audit.js';
import { bootstrapDatabase } from './db/bootstrap.js';
import { handleDbError } from './middleware/db-errors.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: process.env.FRONTEND_URL || 'https://wac-frontend-git-main-fannuels-projects.vercel.app/', credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

app.use('/api/auth', authRoutes);
app.use('/api/registrations', registrationRoutes);
app.use('/api/cms', cmsRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/audit', auditRoutes);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use(handleDbError);

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

bootstrapDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to start API:', err);
    process.exit(1);
  });
