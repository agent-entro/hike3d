/**
 * hike3d Express server entry point.
 * Serves the API on port 3000. Vite dev server proxies /api/* and /tiles/* here.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDb } from './db/migrate.js';
import { sessionRouter } from './routes/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'hike3d.sqlite');

// --- Database ---
const db = openDb(DB_PATH);

// --- Express App ---
const app = express();

// CORS: allow Vite dev server (localhost:5173) to send cookies
app.use(cors({
  origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// --- Routes ---
app.use('/api/session', sessionRouter(db));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', ts: Date.now() });
});

// --- 404 fallback for API ---
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Start ---
const server = app.listen(PORT, () => {
  console.log(`[hike3d] API server listening on http://localhost:${PORT}`);
});

export { app, db, server };
