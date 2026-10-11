// docs/queries.sql is documentation people will paste into DB Browser, so it has to keep
// working as the schema changes. This runs every query against a seeded database.

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { closeDb, getDb, initDb } from '../db.js';
import { importQuestions, seedSampleQuestions } from '../importer.js';
import { recordCheatUse } from '../records.js';
import { playNight, playSolo } from '../scripts/testdata.js';

// Split the file into { n, title, sql }, one per query. Each query has a "-- N. title" header
// comment and ends with a semicolon.
function readQueries() {
  const text = readFileSync(new URL('../docs/queries.sql', import.meta.url), 'utf8');
  const queries = [];
  let lines = [];
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    const comment = line.match(/^--\s?(.*)$/);
    if (comment) {
      const numbered = comment[1].match(/^(\d+)\. (.*)$/);
      if (numbered && lines.length === 0) header = { n: Number(numbered[1]), title: numbered[2] };
      continue;
    }
    if (line.trim() === '') continue;
    lines.push(line);
    if (line.trimEnd().endsWith(';')) {
      queries.push({ ...header, sql: lines.join('\n') });
      lines = [];
      header = null;
    }
  }
  assert.equal(lines.length, 0, 'the file ends with a complete query');
  return queries;
}

const queries = readQueries();
const query = (n) => queries.find((q) => q.n === n);

const right = (questionId, answer = 'B') => ({ questionId, answer, correct: true, responseMs: 2000 });
const wrong = (questionId, answer) => ({ questionId, answer, correct: false, responseMs: 4000 });
const timeout = (questionId) => ({ questionId, timedOut: true });

// A small world with known numbers. Sample answers: -1 is B, -3 is B, -5 is B.
//   u1, u2, u3 (Standard): -1 right, -3 right, -5 wrong (A)
//   u4, u5     (Standard): -1 wrong (A), -3 right, -5 wrong (C)
//   u6         (Hard):     -1 wrong (C), -3 right, -5 timed out
//   u1 also has a Casual run answering -5 right six times, which must never count.
//   One trivia night: Red = u1 + u4 (won 2-1), Blue = u2 + u3, with u3 asked to help once.
//   Question 900 is real and never asked.
function seedWorld() {
  playSolo({ userId: 'u1', name: 'Ann', guesses: [right(-1), right(-3), wrong(-5, 'A')] });
  playSolo({ userId: 'u2', name: 'Ben', guesses: [right(-1), right(-3), wrong(-5, 'A')] });
  playSolo({ userId: 'u3', name: 'Cat', guesses: [right(-1), right(-3), wrong(-5, 'A')] });
  playSolo({ userId: 'u4', name: 'Dan', guesses: [wrong(-1, 'A'), right(-3), wrong(-5, 'C')] });
  playSolo({ userId: 'u5', name: 'Eve', guesses: [wrong(-1, 'A'), right(-3), wrong(-5, 'C')] });
  playSolo({ userId: 'u6', name: 'Fay', difficulty: 'hard', status: 'failed', guesses: [wrong(-1, 'C'), right(-3), timeout(-5)] });
  playSolo({ userId: 'u1', name: 'Ann', difficulty: 'casual', guesses: Array.from({ length: 6 }, () => right(-5)) });

  playNight({
    hostId: 'h1',
    teams: [
      { name: 'Red', score: 2, won: true, players: ['u1', 'u4'] },
      { name: 'Blue', score: 1, players: ['u2', 'u3'] },
    ],
    questions: [
      {
        questionId: -7,
        board: 1,
        guesses: [
          { team: 0, userId: 'u1', answer: 'A', correct: true },
          { team: 1, userId: 'u3', answer: 'B', correct: false, assisted: true, assignedUserId: 'u2' },
        ],
      },
      {
        questionId: -9,
        board: 1,
        guesses: [
          { team: 0, userId: 'u4', answer: 'B', correct: true },
          { team: 1, userId: 'u2', answer: 'B', correct: true },
        ],
      },
    ],
  });

  importQuestions(
    [{ id: 900, pack: 'fifthgrader', grade: 3, subject: 'Music', type: 'choice', prompt: 'Never asked?', choices: ['a', 'b'], answer: 'A', accepted: null, source: null }],
    { deactivateMissing: false },
  );

  // Ann used 50/50 on her first question and Peek on her second.
  const ann = getDb().prepare("SELECT id FROM games WHERE host_id = 'u1' AND difficulty = 'standard'").get().id;
  const [first, second] = getDb().prepare('SELECT id FROM game_questions WHERE game_id = ? ORDER BY seq').all(ann);
  recordCheatUse({ gameQuestionId: first.id, gameId: ann, userId: 'u1', cheat: 'fifty' });
  recordCheatUse({ gameQuestionId: second.id, gameId: ann, userId: 'u1', cheat: 'peek' });
}

const run = (n, sql = query(n).sql) => getDb().prepare(sql).all().map((row) => ({ ...row }));

beforeEach(() => {
  initDb(':memory:');
  seedSampleQuestions();
});
afterEach(() => closeDb());

describe('docs/queries.sql', () => {
  test('has numbered queries, in order, each with a title', () => {
    assert.ok(queries.length >= 20, `${queries.length} queries`);
    assert.deepEqual(queries.map((q) => q.n), queries.map((_, i) => i + 1));
    assert.ok(queries.every((q) => q.title && q.title.length > 5));
  });

  test('every query only reads', () => {
    for (const q of queries) {
      assert.match(q.sql, /^SELECT\b/i, `query ${q.n} starts with SELECT`);
      assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(q.sql), `query ${q.n} doesn't change anything`);
    }
  });

  test('every query runs on an empty database', () => {
    for (const q of queries) assert.doesNotThrow(() => run(q.n), `query ${q.n}: ${q.title}`);
  });

  describe('with data', () => {
    beforeEach(seedWorld);

    test('every query runs', () => {
      for (const q of queries) assert.doesNotThrow(() => run(q.n), `query ${q.n}: ${q.title}`);
    });

    test('1: games by format, difficulty and outcome', () => {
      const rows = run(1);
      const find = (format, difficulty, status) => rows.find((r) => r.format === format && r.difficulty === difficulty && r.status === status)?.games;
      assert.equal(find('solo', 'standard', 'completed'), 5);
      assert.equal(find('solo', 'hard', 'failed'), 1);
      assert.equal(find('solo', 'casual', 'completed'), 1);
      assert.equal(find('night', '-', 'completed'), 1);
    });

    test('2: overall numbers leave out Casual', () => {
      const ann = run(2).find((r) => r.player === 'Ann');
      // 3 on her Standard run + 1 on the night; her Casual run doesn't count
      assert.deepEqual([ann.answered, ann.correct, ann.pct_correct], [4, 3, 75]);
      assert.equal(ann.avg_seconds, 2.3, '(2000 + 2000 + 4000 + 1000 ms) / 4 = 2.25 s');
    });

    test('3: average correct per run, by player and difficulty', () => {
      const rows = run(3);
      assert.deepEqual(rows.find((r) => r.player === 'Ann'), { player: 'Ann', difficulty: 'standard', runs: 1, avg_correct: 2, best_run: 2 });
      assert.deepEqual(rows.find((r) => r.player === 'Fay'), { player: 'Fay', difficulty: 'hard', runs: 1, avg_correct: 1, best_run: 1 });
      assert.equal(rows.some((r) => r.difficulty === 'casual'), false);
    });

    test('4 and 5: hardest and easiest questions', () => {
      const hardest = run(4);
      assert.deepEqual(hardest.map((r) => [r.id, r.answers, r.correct, r.pct_correct]), [
        [-5, 6, 0, 0], // Casual's six right answers are left out
        [-1, 6, 3, 50],
        [-3, 6, 6, 100],
      ]);
      assert.deepEqual(run(5).map((r) => r.id), [-3, -1, -5]);
    });

    test('6: what people picked on one question', () => {
      const sql = query(6).sql.replaceAll('question_id = 1', 'question_id = -1');
      assert.deepEqual(run(6, sql).map((r) => [r.picked, r.times, r.pct]), [['B', 3, 50], ['A', 2, 33.3], ['C', 1, 16.7]]);
    });

    test('7: the most-picked wrong answers', () => {
      const [top] = run(7);
      assert.deepEqual([top.id, top.wrong_letter, top.times], [-5, 'A', 3]);
      assert.equal(top.right_letter, 'B');
    });

    test('8: questions people time out on', () => {
      assert.deepEqual(run(8).map((r) => [r.id, r.timeouts]), [[-5, 1]]);
    });

    test('9: accuracy by grade counts every counted answer once', () => {
      const rows = run(9);
      assert.equal(rows.reduce((sum, r) => sum + r.answers, 0), 18 + 4, '6 solo games x 3 + 4 night answers');
    });

    test('11: each player by grade, side by side', () => {
      const ann = run(11).find((r) => r.player === 'Ann');
      assert.equal(ann.grade_1, 100); // -1 and -3, both right
      assert.equal(ann.grade_4, null, 'never asked');
    });

    test('14, 15: trivia night results and team win rates', () => {
      const rows = run(14);
      assert.deepEqual(rows.map((r) => [r.team, r.score, r.won]), [['Red', 2, 1], ['Blue', 1, 0]]);
      assert.equal(rows[0].members.split(', ').sort().join(), 'Ann,Dan');
      assert.deepEqual(run(15).map((r) => [r.team, r.pick_order, r.nights, r.wins, r.win_pct]), [['Red', 0, 1, 1, 100], ['Blue', 1, 1, 0, 0]]);
    });

    test('16, 17: Ask a teammate outcomes', () => {
      assert.deepEqual(run(16).map((r) => [r.how, r.answers, r.correct]).sort(), [
        ['answered for themselves', 3, 3],
        ['teammate asked to help', 1, 0],
      ]);
      const [use] = run(17);
      assert.deepEqual([use.team, use.asked_for_help, use.answered, use.correct], ['Blue', 'Ben', 'Cat', 0]);
    });

    test('18, 19: cheat usage and whether it helped', () => {
      assert.deepEqual(run(18).map((r) => [r.difficulty, r.cheat, r.uses]).sort(), [
        ['standard', 'fifty', 1],
        ['standard', 'peek', 1],
      ]);
      assert.deepEqual(run(19).map((r) => [r.cheat, r.answers, r.correct]).sort(), [['fifty', 1, 1], ['peek', 1, 1]]);
    });

    test('20: questions nobody has been asked yet leaves out the samples', () => {
      assert.deepEqual(run(20).map((r) => r.id), [900]);
    });

    test('21: activity by day', () => {
      const rows = run(21);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].games, rows[0].answers], [8, 28]);
    });
  });
});
