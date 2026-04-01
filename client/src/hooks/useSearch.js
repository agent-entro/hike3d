/**
 * useSearch — debounced trail search hook.
 *
 * Debounces the user's input at 500ms, fires GET /api/trails/search,
 * manages loading/error state, and returns the result list.
 */

import { useState, useEffect, useRef, useCallback } from 'react';

const DEBOUNCE_MS = 500;
const MIN_QUERY_LEN = 2;

/**
 * @typedef {Object} TrailSummary
 * @property {string} id
 * @property {string} name
 * @property {number} distance_m
 * @property {number} elevation_gain_m
 * @property {number} elevation_loss_m
 * @property {number} max_elev_m
 * @property {number} min_elev_m
 * @property {string} difficulty
 * @property {string|null} surface
 * @property {Array} elevation_profile
 */

/**
 * @typedef {Object} SearchState
 * @property {string} query
 * @property {(q: string) => void} setQuery
 * @property {TrailSummary[]} results
 * @property {boolean} loading
 * @property {string|null} error
 * @property {() => void} clear
 */

/**
 * @returns {SearchState}
 */
export function useSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const abortRef = useRef(null);
  const timerRef = useRef(null);

  const clear = useCallback(() => {
    setQuery('');
    setResults([]);
    setError(null);
    setLoading(false);
    if (abortRef.current) abortRef.current.abort();
    clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    // Clear previous timer
    clearTimeout(timerRef.current);

    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LEN) {
      setResults([]);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    timerRef.current = setTimeout(async () => {
      // Abort any in-flight request
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch(
          `/api/trails/search?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal, credentials: 'include' }
        );

        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Search failed (${res.status})`);
        }

        const data = await res.json();
        setResults(data.trails ?? []);
        setError(null);
      } catch (err) {
        if (err.name === 'AbortError') return; // stale request
        setError(err.message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timerRef.current);
    };
  }, [query]);

  // Cleanup abort on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  return { query, setQuery, results, loading, error, clear };
}
