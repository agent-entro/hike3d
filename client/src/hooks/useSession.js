/**
 * useSession — checks for an existing JWT session on load, creates one if missing.
 * The JWT is stored as an httpOnly cookie by the server; we just track session metadata.
 */

import { useState, useEffect } from 'react';

/**
 * @typedef {Object} SessionState
 * @property {string|null} sessionId
 * @property {boolean} loading
 * @property {string|null} error
 */

/**
 * @returns {SessionState}
 */
export function useSession() {
  const [sessionId, setSessionId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      try {
        // Try to validate an existing session (cookie sent automatically)
        const validateRes = await fetch('/api/session/validate', {
          method: 'POST',
          credentials: 'include',
        });

        if (!cancelled && validateRes.ok) {
          const data = await validateRes.json();
          setSessionId(data.session_id);
          setLoading(false);
          return;
        }

        // No valid session — create a new anonymous session
        const createRes = await fetch('/api/session/create', {
          method: 'POST',
          credentials: 'include',
        });

        if (!createRes.ok) throw new Error('Failed to create session');

        const data = await createRes.json();
        if (!cancelled) {
          setSessionId(data.session_id);
        }
      } catch (err) {
        if (!cancelled) {
          console.error('[useSession]', err);
          setError(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    initSession();
    return () => { cancelled = true; };
  }, []);

  return { sessionId, loading, error };
}
