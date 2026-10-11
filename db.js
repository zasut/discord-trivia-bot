// SQLite through Node's built-in `node:sqlite` (no npm dependency). See DESIGN.md
// "Database" for the schema and conventions.
//
// One connection per process, opened by initDb() and fetched with getDb(). Tests call
// initDb(':memory:') for a fresh database each time.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_DB_PATH = fileURLToPath(new URL('./data/trivia.db', import.meta.url));

// Each entry is one migration; the array index + 1 is the schema version stored in
// `PRAGMA user_version`. Never edit a migration once it has shipped: add a new one.
const MIGRATIONS = [
  // 1: initial schema
  `
  CREATE TABLE questions (
    id          INTEGER PRIMARY KEY,
    pack        TEXT NOT NULL,
    grade       INTEGER,
    subject     TEXT NOT NULL,
    type        TEXT NOT NULL CHECK (type IN ('choice', 'typed')),
    prompt      TEXT NOT NULL,
    choices     TEXT,
    answer      TEXT NOT NULL,
    accepted    TEXT,
    source      TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_questions_tile ON questions (pack, grade, subject, active);

  CREATE TABLE players (
    user_id       TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    first_seen    TEXT NOT NULL,
    last_seen     TEXT NOT NULL
  );

  CREATE TABLE games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id    TEXT,
    channel_id  TEXT NOT NULL,
    pack        TEXT NOT NULL,
    format      TEXT NOT NULL CHECK (format IN ('solo', 'night')),
    difficulty  TEXT CHECK (difficulty IN ('hard', 'standard', 'casual')),
    host_id     TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'quit', 'abandoned')),
    started_at  TEXT NOT NULL,
    ended_at    TEXT
  );

  CREATE TABLE teams (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id   INTEGER NOT NULL REFERENCES games(id),
    name      TEXT NOT NULL,
    position  INTEGER NOT NULL,
    score     INTEGER NOT NULL DEFAULT 0,
    won       INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE game_players (
    game_id     INTEGER NOT NULL REFERENCES games(id),
    user_id     TEXT NOT NULL REFERENCES players(user_id),
    team_id     INTEGER REFERENCES teams(id),
    turn_order  INTEGER,
    PRIMARY KEY (game_id, user_id)
  );

  CREATE TABLE game_questions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      INTEGER NOT NULL REFERENCES games(id),
    question_id  INTEGER NOT NULL REFERENCES questions(id),
    seq          INTEGER NOT NULL,
    board        INTEGER NOT NULL DEFAULT 0,
    grade        INTEGER,
    subject      TEXT,
    picked_by    TEXT,
    shown_at     TEXT NOT NULL,
    swapped      INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE guesses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    game_question_id  INTEGER NOT NULL REFERENCES game_questions(id),
    game_id           INTEGER NOT NULL REFERENCES games(id),
    question_id       INTEGER NOT NULL REFERENCES questions(id),
    user_id           TEXT NOT NULL REFERENCES players(user_id),
    team_id           INTEGER REFERENCES teams(id),
    answer            TEXT,
    correct           INTEGER NOT NULL,
    timed_out         INTEGER NOT NULL DEFAULT 0,
    assisted          INTEGER NOT NULL DEFAULT 0,
    assigned_user_id  TEXT,
    response_ms       INTEGER,
    created_at        TEXT NOT NULL
  );
  CREATE INDEX idx_guesses_user ON guesses (user_id);
  CREATE INDEX idx_guesses_question ON guesses (question_id);

  CREATE TABLE cheat_uses (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    game_question_id  INTEGER NOT NULL REFERENCES game_questions(id),
    game_id           INTEGER NOT NULL REFERENCES games(id),
    user_id           TEXT NOT NULL,
    cheat             TEXT NOT NULL CHECK (cheat IN ('peek', 'fifty', 'swap', 'extra_time')),
    created_at        TEXT NOT NULL
  );
  `,
];

let db = null;

export function nowIso() {
  return new Date().toISOString();
}

// Apply every migration newer than the database's `user_version`. Safe to run twice.
export function migrate(conn) {
  const { user_version: current } = conn.prepare('PRAGMA user_version').get();
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${current} is newer than this bot supports (${MIGRATIONS.length}) — update the bot`,
    );
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    conn.exec('BEGIN');
    try {
      conn.exec(MIGRATIONS[version - 1]);
      conn.exec(`PRAGMA user_version = ${version}`);
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw err;
    }
  }
}

// A restart loses every in-memory session, so a game still `in_progress` in the
// database can never finish.
export function abandonStaleGames(conn) {
  return conn
    .prepare("UPDATE games SET status = 'abandoned', ended_at = ? WHERE status = 'in_progress'")
    .run(nowIso()).changes;
}

// Open (or create) the database and make it the process-wide connection.
// Path order: explicit argument, TRIVIA_DB_PATH, then data/trivia.db.
export function initDb(path) {
  if (db) closeDb();
  const target = path ?? (process.env.TRIVIA_DB_PATH ? resolve(process.env.TRIVIA_DB_PATH) : DEFAULT_DB_PATH);
  const inMemory = target === ':memory:';
  if (!inMemory) mkdirSync(dirname(target), { recursive: true });
  const conn = new DatabaseSync(target);
  try {
    conn.exec('PRAGMA foreign_keys = ON');
    if (!inMemory) conn.exec('PRAGMA journal_mode = WAL');
    migrate(conn);
    abandonStaleGames(conn);
  } catch (err) {
    conn.close(); // don't leak the handle (it would keep the file locked)
    throw err;
  }
  db = conn;
  return db;
}

export function getDb() {
  if (!db) throw new Error('database not initialised — call initDb() first');
  return db;
}

export function closeDb() {
  if (db) db.close();
  db = null;
}

// Run `fn` inside one transaction. `fn` must be synchronous: DatabaseSync is, and an
// `await` in the middle would let other handlers write into the open transaction.
export function transaction(fn) {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const result = fn();
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}
