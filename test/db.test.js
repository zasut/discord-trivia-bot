import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initDb, closeDb, getDb, migrate, transaction } from '../db.js';
import {
  upsertPlayer,
  createGame,
  endGame,
  addGamePlayer,
  recordQuestionShown,
  recordGuess,
  recordCheatUse,
  markSwapped,
  createTeam,
  setTeamResult,
} from '../records.js';
import { seedSampleQuestions } from '../importer.js';

const tables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);

const userVersion = (db) => db.prepare('PRAGMA user_version').get().user_version;

describe('migrations', () => {
  afterEach(() => closeDb());

  test('create every table and set user_version', () => {
    const db = initDb(':memory:');
    assert.deepEqual(tables(db), [
      'cheat_uses',
      'game_players',
      'game_questions',
      'games',
      'guesses',
      'players',
      'questions',
      'teams',
    ]);
    assert.equal(userVersion(db), 1);
  });

  test('are safe to run twice', () => {
    const db = initDb(':memory:');
    migrate(db);
    migrate(db);
    assert.equal(userVersion(db), 1);
    assert.equal(tables(db).length, 8);
  });

  test('reopening an existing file keeps its data and does not re-run migration 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trivia-db-'));
    try {
      const path = join(dir, 'nested', 'trivia.db');
      initDb(path);
      upsertPlayer('111', 'Ann');
      closeDb();
      const db = initDb(path);
      assert.equal(userVersion(db), 1);
      assert.equal(db.prepare('SELECT display_name FROM players WHERE user_id = ?').get('111').display_name, 'Ann');
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('creates the data directory when it is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trivia-db-'));
    try {
      const path = join(dir, 'does', 'not', 'exist', 'trivia.db');
      initDb(path);
      assert.ok(existsSync(path));
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('foreign keys are enforced', () => {
    const db = initDb(':memory:');
    assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
    assert.throws(() => db.prepare("INSERT INTO game_players (game_id, user_id) VALUES (999, 'nobody')").run());
  });

  test('file databases use WAL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trivia-db-'));
    try {
      const db = initDb(join(dir, 'trivia.db'));
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a database from a newer version of the bot is refused, and its file is not left open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trivia-db-'));
    try {
      const path = join(dir, 'trivia.db');
      const raw = new DatabaseSync(path);
      raw.exec('PRAGMA user_version = 99');
      raw.close();
      assert.throws(() => initDb(path), /schema version 99 is newer than this bot supports/);
      // The failed open must release the file, or this delete fails on Windows.
      rmSync(dir, { recursive: true, force: true });
      assert.equal(existsSync(path), false);
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stale games', () => {
  test('games still in_progress at startup are marked abandoned, others untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'trivia-db-'));
    try {
      const path = join(dir, 'trivia.db');
      initDb(path);
      upsertPlayer('111', 'Ann');
      const running = createGame({ guildId: 'g', channelId: 'c', pack: 'fifthgrader', format: 'solo', difficulty: 'standard', hostId: '111' });
      const finished = createGame({ guildId: 'g', channelId: 'c', pack: 'fifthgrader', format: 'solo', difficulty: 'hard', hostId: '111' });
      endGame(finished, 'completed');
      closeDb();

      const db = initDb(path);
      const status = (id) => db.prepare('SELECT status, ended_at FROM games WHERE id = ?').get(id);
      assert.equal(status(running).status, 'abandoned');
      assert.ok(status(running).ended_at);
      assert.equal(status(finished).status, 'completed');
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('transaction', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  test('commits on success and returns the result', () => {
    const result = transaction(() => {
      upsertPlayer('111', 'Ann');
      return 'done';
    });
    assert.equal(result, 'done');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM players').get().n, 1);
  });

  test('rolls back when the callback throws', () => {
    assert.throws(
      () =>
        transaction(() => {
          upsertPlayer('111', 'Ann');
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM players').get().n, 0);
  });
});

describe('records', () => {
  let gameId;
  let questionId;

  beforeEach(() => {
    initDb(':memory:');
    seedSampleQuestions();
    questionId = -1;
    upsertPlayer('111', 'Ann');
    gameId = createGame({ guildId: 'g1', channelId: 'c1', pack: 'fifthgrader', format: 'solo', difficulty: 'standard', hostId: '111' });
  });
  afterEach(() => closeDb());

  const one = (sql, ...params) => ({ ...getDb().prepare(sql).get(...params) });

  test('upsertPlayer inserts, then refreshes the name and last_seen but not first_seen', async () => {
    const first = one('SELECT * FROM players WHERE user_id = ?', '111');
    assert.equal(first.display_name, 'Ann');
    await new Promise((resolve) => setTimeout(resolve, 5));
    upsertPlayer('111', 'Annie');
    const second = one('SELECT * FROM players WHERE user_id = ?', '111');
    assert.equal(second.display_name, 'Annie');
    assert.equal(second.first_seen, first.first_seen);
    assert.ok(second.last_seen > first.last_seen);
  });

  test('createGame starts in_progress and stores ids as text', () => {
    const game = one('SELECT * FROM games WHERE id = ?', gameId);
    assert.equal(game.status, 'in_progress');
    assert.equal(game.guild_id, 'g1');
    assert.equal(game.host_id, '111');
    assert.equal(game.ended_at, null);
  });

  test('snowflake-sized ids survive intact', () => {
    const big = '1234567890123456789';
    upsertPlayer(big, 'Big');
    assert.equal(one('SELECT user_id FROM players WHERE user_id = ?', big).user_id, big);
  });

  test('createGame without a guild or difficulty stores NULLs, never undefined', () => {
    const id = createGame({ channelId: 'c1', pack: 'fifthgrader', format: 'night', hostId: '111' });
    const game = one('SELECT * FROM games WHERE id = ?', id);
    assert.equal(game.guild_id, null);
    assert.equal(game.difficulty, null);
  });

  test('endGame sets the status and end time', () => {
    endGame(gameId, 'failed');
    const game = one('SELECT * FROM games WHERE id = ?', gameId);
    assert.equal(game.status, 'failed');
    assert.ok(game.ended_at);
  });

  test('addGamePlayer, teams and team results', () => {
    const teamId = createTeam(gameId, 'Red', 0);
    addGamePlayer(gameId, '111', { teamId, turnOrder: 0 });
    setTeamResult(teamId, { score: 4, won: true });
    assert.equal(one('SELECT * FROM game_players WHERE game_id = ?', gameId).turn_order, 0);
    const team = one('SELECT * FROM teams WHERE id = ?', teamId);
    assert.equal(team.score, 4);
    assert.equal(team.won, 1);
  });

  test('solo players have no team', () => {
    addGamePlayer(gameId, '111');
    const gp = one('SELECT * FROM game_players WHERE game_id = ?', gameId);
    assert.equal(gp.team_id, null);
    assert.equal(gp.turn_order, null);
  });

  test('recordQuestionShown, then a guess attached to it', () => {
    const gqId = recordQuestionShown({ gameId, questionId, seq: 0, grade: 1, subject: 'Math', pickedBy: '111' });
    const gq = one('SELECT * FROM game_questions WHERE id = ?', gqId);
    assert.equal(gq.seq, 0);
    assert.equal(gq.board, 0);
    assert.equal(gq.swapped, 0);
    assert.ok(gq.shown_at);

    recordGuess({ gameQuestionId: gqId, gameId, questionId, userId: '111', answer: 'B', correct: true, responseMs: 1234 });
    const guess = one('SELECT * FROM guesses WHERE game_question_id = ?', gqId);
    assert.equal(guess.answer, 'B');
    assert.equal(guess.correct, 1);
    assert.equal(guess.timed_out, 0);
    assert.equal(guess.assisted, 0);
    assert.equal(guess.response_ms, 1234);
    assert.equal(guess.team_id, null);
  });

  test('a timeout guess has no answer and no response time, even if one is passed', () => {
    const gqId = recordQuestionShown({ gameId, questionId, seq: 0 });
    recordGuess({ gameQuestionId: gqId, gameId, questionId, userId: '111', correct: false, timedOut: true, responseMs: 20000 });
    const guess = one('SELECT * FROM guesses WHERE game_question_id = ?', gqId);
    assert.equal(guess.answer, null);
    assert.equal(guess.correct, 0);
    assert.equal(guess.timed_out, 1);
    assert.equal(guess.response_ms, null);
  });

  test('assisted guesses record who asked for help', () => {
    upsertPlayer('222', 'Bob');
    const gqId = recordQuestionShown({ gameId, questionId, seq: 0 });
    recordGuess({ gameQuestionId: gqId, gameId, questionId, userId: '222', answer: 'A', correct: false, assisted: true, assignedUserId: '111' });
    const guess = one('SELECT * FROM guesses WHERE game_question_id = ?', gqId);
    assert.equal(guess.assisted, 1);
    assert.equal(guess.assigned_user_id, '111');
  });

  test('a guess from a player who was never upserted is rejected', () => {
    const gqId = recordQuestionShown({ gameId, questionId, seq: 0 });
    assert.throws(() => recordGuess({ gameQuestionId: gqId, gameId, questionId, userId: '999', correct: false }));
  });

  test('markSwapped and recordCheatUse', () => {
    const gqId = recordQuestionShown({ gameId, questionId, seq: 0 });
    markSwapped(gqId);
    recordCheatUse({ gameQuestionId: gqId, gameId, userId: '111', cheat: 'swap' });
    assert.equal(one('SELECT swapped FROM game_questions WHERE id = ?', gqId).swapped, 1);
    assert.equal(one('SELECT cheat FROM cheat_uses WHERE game_id = ?', gameId).cheat, 'swap');
    assert.throws(() => recordCheatUse({ gameQuestionId: gqId, gameId, userId: '111', cheat: 'nope' }));
  });
});
