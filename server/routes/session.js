/**
 * Session routes: create and validate anonymous user sessions.
 * Each session gets its own JWT secret for isolation.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

const SESSION_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const COOKIE_NAME = 'hike3d_session';

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Router}
 */
export function sessionRouter(db) {
  const router = Router();

  const insertSession = db.prepare(`
    INSERT INTO user_sessions (id, display_name, jwt_secret, created_at, last_active_at, expires_at, ip_address, user_agent)
    VALUES (@id, @display_name, @jwt_secret, @created_at, @last_active_at, @expires_at, @ip_address, @user_agent)
  `);

  const updateLastActive = db.prepare(`
    UPDATE user_sessions SET last_active_at = ? WHERE id = ?
  `);

  const getSession = db.prepare(`
    SELECT * FROM user_sessions WHERE id = ? AND expires_at > ?
  `);

  // POST /api/session/create
  // Creates a new anonymous session, sets httpOnly JWT cookie
  router.post('/create', (req, res) => {
    try {
      const id = uuidv4();
      const jwtSecret = crypto.randomBytes(32).toString('hex');
      const now = Date.now();
      const expiresAt = now + SESSION_DURATION_MS;

      insertSession.run({
        id,
        display_name: null,
        jwt_secret: jwtSecret,
        created_at: now,
        last_active_at: now,
        expires_at: expiresAt,
        ip_address: req.ip || null,
        user_agent: req.headers['user-agent'] || null,
      });

      const token = jwt.sign({ sid: id }, jwtSecret, {
        expiresIn: `${SESSION_DURATION_MS}ms`,
      });

      res.cookie(COOKIE_NAME, token, {
        httpOnly: true,
        sameSite: 'lax',
        maxAge: SESSION_DURATION_MS,
        // secure: true  — not needed for localhost dev
      });

      res.json({ session_id: id, expires_at: expiresAt });
    } catch (err) {
      console.error('[session/create]', err);
      res.status(500).json({ error: 'Failed to create session' });
    }
  });

  // POST /api/session/validate
  // Verifies JWT, updates last_active_at, returns session info
  router.post('/validate', (req, res) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) {
        return res.status(401).json({ error: 'No session cookie' });
      }

      // Decode without verifying to get the session ID first
      const decoded = jwt.decode(token);
      if (!decoded?.sid) {
        return res.status(401).json({ error: 'Invalid token structure' });
      }

      const session = getSession.get(decoded.sid, Date.now());
      if (!session) {
        return res.status(401).json({ error: 'Session not found or expired' });
      }

      // Now verify with the per-session secret
      jwt.verify(token, session.jwt_secret);

      updateLastActive.run(Date.now(), session.id);

      res.json({
        session_id: session.id,
        display_name: session.display_name,
        expires_at: session.expires_at,
      });
    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Invalid or expired token' });
      }
      console.error('[session/validate]', err);
      res.status(500).json({ error: 'Failed to validate session' });
    }
  });

  return router;
}

/**
 * Express middleware: verifies the session JWT and attaches session to req.
 * Returns 401 if missing or invalid.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function requireSession(db) {
  const getSession = db.prepare(
    'SELECT * FROM user_sessions WHERE id = ? AND expires_at > ?'
  );

  return (req, res, next) => {
    try {
      const token = req.cookies?.[COOKIE_NAME];
      if (!token) return res.status(401).json({ error: 'Authentication required' });

      const decoded = jwt.decode(token);
      if (!decoded?.sid) return res.status(401).json({ error: 'Invalid token' });

      const session = getSession.get(decoded.sid, Date.now());
      if (!session) return res.status(401).json({ error: 'Session expired' });

      jwt.verify(token, session.jwt_secret);

      req.session = session;
      next();
    } catch (err) {
      if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
        return res.status(401).json({ error: 'Invalid token' });
      }
      next(err);
    }
  };
}
