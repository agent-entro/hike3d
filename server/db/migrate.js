/**
 * Migration runner: reads .sql files from server/db/migrations/ in order,
 * applies each once, tracks applied migrations in schema_version table.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Opens (or creates) the SQLite database, enables WAL mode, applies all
 * pending migrations in filename-sorted order.
 *
 * @param {string} dbPath - Path to the SQLite file
 * @returns {import('better-sqlite3').Database}
 */
export function openDb(dbPath) {
  const db = new Database(dbPath);

  // WAL mode for concurrent reads during tile cache writes
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

/**
 * Applies any unapplied migration files to the given database.
 *
 * @param {import('better-sqlite3').Database} db
 */
export function runMigrations(db) {
  // Ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      filename TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM schema_version').all().map((r) => r.filename)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();  // lexicographic sort ensures 001_, 002_, ... ordering

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // Run migration in a transaction so schema is atomic
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (filename, applied_at) VALUES (?, ?)').run(
        file,
        Date.now()
      );
    });

    applyMigration();
    console.log(`[migrate] Applied: ${file}`);
  }
}
