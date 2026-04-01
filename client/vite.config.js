/**
 * Vite configuration for the hike3d client.
 *
 * Includes a custom `sw-hash-inject` plugin that replaces the
 * `__VITE_BUILD_HASH__` placeholder in public/sw.js with the actual build
 * hash so that every deployment gets a unique service-worker cache name,
 * preventing stale tile caches from surviving across releases.
 */

import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build a deterministic hash for the current build:
 *   1. VITE_BUILD_HASH env var (set in CI to `git rev-parse --short HEAD`)
 *   2. Timestamp fallback for local dev
 *
 * @param {Record<string, string>} env  Loaded env variables
 */
function resolveBuildHash(env) {
  return env.VITE_BUILD_HASH || Date.now().toString(36);
}

/**
 * Vite plugin: replaces `__VITE_BUILD_HASH__` in public/sw.js with the
 * resolved build hash, both during dev (via middleware) and at build time
 * (by rewriting the emitted file).
 *
 * @param {string} hash
 * @returns {import('vite').Plugin}
 */
function swHashInjectPlugin(hash) {
  const swTemplatePath = resolve(__dirname, 'public', 'sw.js');

  return {
    name: 'sw-hash-inject',

    // Dev server: intercept /sw.js and serve with hash substituted
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res) => {
        const template = readFileSync(swTemplatePath, 'utf-8');
        const content = template.replace(/__VITE_BUILD_HASH__/g, hash);
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
        res.setHeader('Service-Worker-Allowed', '/');
        res.end(content);
      });
    },

    // Build: rewrite the copied sw.js in the output directory
    closeBundle() {
      const outSwPath = resolve(__dirname, 'dist', 'sw.js');
      try {
        const content = readFileSync(outSwPath, 'utf-8');
        writeFileSync(outSwPath, content.replace(/__VITE_BUILD_HASH__/g, hash));
        console.log(`[sw-hash-inject] Injected hash "${hash}" into dist/sw.js`);
      } catch {
        // sw.js might not be emitted if there's no build step; ignore silently
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env so VITE_BUILD_HASH and SERVER_PORT are available at config time.
  // loadEnv uses '' prefix to capture all variables, not just VITE_-prefixed ones.
  const env = loadEnv(mode, __dirname, '');
  const buildHash = resolveBuildHash(env);

  // SERVER_PORT must match PORT in the root .env (default 3000 if not set).
  const serverPort = env.SERVER_PORT || 3000;
  const apiTarget = `http://localhost:${serverPort}`;

  // VITE_PORT controls which port the dev server binds to.
  // Set it in client/.env to avoid conflicts with other local services.
  const vitePort = parseInt(env.VITE_PORT, 10) || 5173;
  const websocketHost = env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',')[0] : 'localhost';

  return {
    plugins: [
      react(),
      tailwindcss(),
      swHashInjectPlugin(buildHash),
    ],

    // Expose the hash to client-side code via import.meta.env
    define: {
      'import.meta.env.VITE_BUILD_HASH': JSON.stringify(buildHash),
    },

    base: "/hike",

    server: {
      allowedHosts: env.ALLOWED_HOSTS ? env.ALLOWED_HOSTS.split(',') : ['localhost'],
      port: vitePort,
      hmr: {
        host: websocketHost,
        protocol: websocketHost === 'localhost' ? 'ws' : 'wss',
        port: vitePort,
        path: '/ws',
      },
      proxy: {
        // Forward /api/* and /tiles/* to the Express server.
        // Target port is driven by SERVER_PORT in client/.env so it stays
        // in sync with PORT in the root .env without hardcoding.
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/tiles': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/tiles/, ''),
        },
      },
    },
  };
});
