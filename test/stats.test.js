import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, initDb } from '../db.js';
import { seedSampleQuestions } from '../importer.js';
import { importQuestions } from '../importer.js';
import { bestHardRun, formatStats, getPlayerStats, peekAnswers, peekCount } from '../stats.js';
import { playSolo } from '../scripts/testdata.js';

beforeEach(() => {
  initDb(':memory:');
  seedSampleQuestions();
});
afterEach(() => closeDb());

// Sample question -1: "What is 2 + 2?", answer B. Sample question -2 is typed.
const guess = (questionId, answer, extra = {}) => ({ questionId, answer, correct: answer === 'B', ...extra });

describe('Peek data', () => {
  test('counts counted guesses from other games, with their answers', () => {
    playSolo({ userId: 'u1', guesses: [guess(-1, 'B')] });
    playSolo({ userId: 'u2', difficulty: 'hard', guesses: [guess(-1, 'A')] });
    const current = playSolo({ userId: 'u3', guesses: [guess(-1, 'C')] });
    assert.equal(peekCount(-1, current), 2, 'the current game is left out');
    assert.deepEqual(peekAnswers(-1, current).sort(), ['A', 'B']);
  });

  test('Casual games are not counted', () => {
    playSolo({ userId: 'u1', guesses: [guess(-1, 'B')] });
    playSolo({ userId: 'u2', difficulty: 'casual', guesses: [guess(-1, 'A'), guess(-2, 'two')] });
    assert.equal(peekCount(-1, 0), 1);
    assert.deepEqual(peekAnswers(-1, 0), ['B']);
    assert.equal(peekCount(-2, 0), 0);
  });

  test('timeouts are not an answer', () => {
    playSolo({ userId: 'u1', guesses: [guess(-1, 'B')] });
    playSolo({ userId: 'u2', guesses: [{ questionId: -1, timedOut: true }] });
    assert.equal(peekCount(-1, 0), 1);
    assert.deepEqual(peekAnswers(-1, 0), ['B']);
  });

  test('other questions are not mixed in', () => {
    playSolo({ userId: 'u1', guesses: [guess(-1, 'B'), guess(-3, 'B')] });
    assert.equal(peekCount(-1, 0), 1);
    assert.equal(peekCount(-3, 0), 1);
    assert.equal(peekCount(-4, 0), 0);
  });

  test('unfinished and abandoned games still count: a guess is a guess', () => {
    playSolo({ userId: 'u1', status: 'abandoned', guesses: [guess(-1, 'B')] });
    playSolo({ userId: 'u2', status: 'quit', guesses: [guess(-1, 'A')] });
    assert.equal(peekCount(-1, 0), 2);
  });

  test('typed answers come back as typed', () => {
    playSolo({ userId: 'u1', guesses: [{ questionId: -2, answer: 'Two', correct: true }] });
    assert.deepEqual(peekAnswers(-2, 0), ['Two']);
  });
});

describe('bestHardRun', () => {
  test('is the most correct answers in a single Hard run', () => {
    playSolo({ userId: 'u1', difficulty: 'hard', status: 'failed', guesses: [guess(-1, 'B'), guess(-3, 'B'), guess(-5, 'A')] });
    playSolo({ userId: 'u1', difficulty: 'hard', status: 'failed', guesses: [guess(-1, 'A')] });
    assert.equal(bestHardRun('u1'), 2);
  });

  test('ignores other players and other difficulties', () => {
    playSolo({ userId: 'u2', difficulty: 'hard', guesses: [guess(-1, 'B')] });
    playSolo({ userId: 'u1', difficulty: 'standard', guesses: [guess(-1, 'B'), guess(-3, 'B')] });
    playSolo({ userId: 'u1', difficulty: 'casual', guesses: [guess(-1, 'B')] });
    assert.equal(bestHardRun('u1'), 0);
  });

  test('is 0 for a player with no games', () => {
    assert.equal(bestHardRun('nobody'), 0);
  });
});

// ---- /stats ----------------------------------------------------------------------------
//
// Sample questions used: -1 Math (grade 1), -3 and -4 Animals (1), -5 Spelling (2),
// -7 Geography (2), -9 Science (3), -11 History (3).

const right = (questionId, responseMs = 1000) => ({ questionId, answer: 'x', correct: true, responseMs });
const wrong = (questionId, responseMs = 1000) => ({ questionId, answer: 'x', correct: false, responseMs });
const timeout = (questionId) => ({ questionId, timedOut: true });

// u1's games. Casual and empty runs must not count.
function playFixture() {
  playSolo({ userId: 'u1', difficulty: 'standard', status: 'completed', guesses: [right(-1, 1000), right(-3, 2000), wrong(-5, 3000), timeout(-7)] }); // A
  playSolo({ userId: 'u1', difficulty: 'standard', status: 'failed', guesses: [wrong(-1, 500), wrong(-3, 1500), wrong(-4, 2500)] }); // B
  playSolo({ userId: 'u1', difficulty: 'hard', status: 'failed', guesses: [right(-9, 4000), wrong(-11, 2000)] }); // C
  playSolo({ userId: 'u1', difficulty: 'hard', status: 'completed', guesses: [right(-9), right(-11), right(-1)] }); // D
  playSolo({ userId: 'u1', difficulty: 'casual', status: 'completed', guesses: [right(-1), right(-3), right(-4), right(-5), right(-7)] }); // E
  playSolo({ userId: 'u1', difficulty: 'standard', status: 'abandoned', guesses: [] }); // F
  playSolo({ userId: 'u2', difficulty: 'standard', guesses: [right(-1), right(-3)] }); // someone else
}

describe('getPlayerStats', () => {
  test('overall: answered, correct, percent and average time, counting only counted guesses', () => {
    playFixture();
    const { overall, hasData } = getPlayerStats('u1');
    assert.equal(hasData, true);
    assert.equal(overall.answered, 12, 'A4 + B3 + C2 + D3, with Casual left out');
    assert.equal(overall.correct, 6, 'A2 + B0 + C1 + D3');
    assert.equal(overall.percent, 50);
    // 19500 ms over the 11 guesses that weren't timeouts
    assert.ok(Math.abs(overall.avgMs - 19500 / 11) < 0.001, String(overall.avgMs));
  });

  test('a timeout counts as answered and wrong, but has no response time', () => {
    playSolo({ userId: 'u1', guesses: [timeout(-1), timeout(-3)] });
    const { overall } = getPlayerStats('u1');
    assert.deepEqual(overall, { answered: 2, correct: 0, percent: 0, avgMs: null });
  });

  test('by grade', () => {
    playFixture();
    assert.deepEqual(getPlayerStats('u1').byGrade, [
      { grade: 1, answered: 6, correct: 3, percent: 50 },
      { grade: 2, answered: 2, correct: 0, percent: 0 },
      { grade: 3, answered: 4, correct: 3, percent: 75 },
      { grade: 4, answered: 0, correct: 0, percent: null },
      { grade: 5, answered: 0, correct: 0, percent: null },
    ]);
  });

  test('by subject, most answered first, ties alphabetical', () => {
    playFixture();
    assert.deepEqual(getPlayerStats('u1').bySubject, [
      { subject: 'Animals', answered: 3, correct: 1, percent: 33 },
      { subject: 'Math', answered: 3, correct: 2, percent: 67 },
      { subject: 'History', answered: 2, correct: 1, percent: 50 },
      { subject: 'Science', answered: 2, correct: 2, percent: 100 },
      { subject: 'Geography', answered: 1, correct: 0, percent: 0 },
      { subject: 'Spelling', answered: 1, correct: 0, percent: 0 },
    ]);
  });

  test('by subject is limited to the ten most answered', () => {
    const questions = Array.from({ length: 12 }, (_, i) => ({
      id: 100 + i,
      pack: 'fifthgrader',
      grade: 4,
      subject: `Subject ${String(i).padStart(2, '0')}`,
      type: 'choice',
      prompt: 'Q?',
      choices: ['a', 'b'],
      answer: 'A',
      accepted: null,
      source: null,
    }));
    importQuestions(questions, { deactivateMissing: false });
    // Subject 00 gets 12 answers, subject 01 gets 11, ... subject 11 gets 1.
    playSolo({
      userId: 'u1',
      guesses: questions.flatMap((q, i) => Array.from({ length: 12 - i }, () => right(q.id))),
    });
    const { bySubject } = getPlayerStats('u1');
    assert.equal(bySubject.length, 10);
    assert.deepEqual(bySubject.map((s) => s.answered), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    assert.equal(bySubject[0].subject, 'Subject 00');
  });

  test('solo runs: runs, clears and best score per difficulty, plus the average', () => {
    playFixture();
    const { solo } = getPlayerStats('u1');
    assert.deepEqual(solo.standard, { runs: 2, cleared: 1, best: 2 });
    assert.deepEqual(solo.hard, { runs: 2, cleared: 1, best: 3 });
    assert.equal(solo.avgCorrectPerRun, 1.5, '(2 + 0 + 1 + 3) / 4');
  });

  test('a run with no guesses is not a run', () => {
    playSolo({ userId: 'u1', difficulty: 'standard', status: 'abandoned', guesses: [] });
    playSolo({ userId: 'u1', difficulty: 'standard', guesses: [right(-1)] });
    assert.equal(getPlayerStats('u1').solo.standard.runs, 1);
  });

  test('Casual runs are left out of everything', () => {
    playSolo({ userId: 'u1', difficulty: 'casual', guesses: [right(-1), right(-3), wrong(-5)] });
    const stats = getPlayerStats('u1');
    assert.equal(stats.hasData, false);
    assert.equal(stats.overall.answered, 0);
    assert.deepEqual(stats.bySubject, []);
    assert.equal(stats.solo.standard.runs + stats.solo.hard.runs, 0);
    assert.equal(stats.solo.avgCorrectPerRun, null);
  });

  test("other players' games don't leak in", () => {
    playFixture();
    const u2 = getPlayerStats('u2');
    assert.equal(u2.overall.answered, 2);
    assert.equal(u2.solo.standard.runs, 1);
  });

  test('a player with no games has empty stats', () => {
    const stats = getPlayerStats('nobody');
    assert.equal(stats.hasData, false);
    assert.deepEqual(stats.overall, { answered: 0, correct: 0, percent: null, avgMs: null });
    assert.ok(stats.byGrade.every((g) => g.answered === 0 && g.percent === null));
    assert.deepEqual(stats.bySubject, []);
    assert.deepEqual(stats.solo.standard, { runs: 0, cleared: 0, best: 0 });
  });
});

describe('formatStats', () => {
  test('lays out every section', () => {
    playFixture();
    assert.equal(
      formatStats(getPlayerStats('u1'), 'u1'),
      [
        '📊 **Stats for <@u1>**',
        '**Overall:** 12 answered · 6 correct (50%) · avg 1.8s',
        '**By grade:** 1st 50% · 2nd 0% · 3rd 75% · 4th – · 5th –',
        '**By subject:** Animals 33% (3) · Math 67% (3) · History 50% (2) · Science 100% (2) · Geography 0% (1) · Spelling 0% (1)',
        '**Standard:** 2 runs · 1 cleared · best 2 correct',
        '**Hard:** 2 runs · 1 cleared · best run 3 correct',
        '**Average correct per run:** 1.5',
      ].join('\n'),
    );
  });

  test('says "1 run" and leaves out sections with nothing in them', () => {
    playSolo({ userId: 'u1', difficulty: 'standard', status: 'quit', guesses: [right(-1, 2000)] });
    const text = formatStats(getPlayerStats('u1'), 'u1');
    assert.match(text, /\*\*Standard:\*\* 1 run · 0 cleared · best 1 correct/);
    assert.ok(!text.includes('**Hard:**'));
    assert.match(text, /avg 2s/, 'a whole number of seconds has no decimal');
  });

  test('leaves out the average when every answer was a timeout', () => {
    playSolo({ userId: 'u1', guesses: [timeout(-1)] });
    assert.match(formatStats(getPlayerStats('u1'), 'u1'), /\*\*Overall:\*\* 1 answered · 0 correct \(0%\)\n/);
  });

  test('stays under the 2000-character message limit even with long subject names', () => {
    const stats = getPlayerStats('nobody');
    stats.overall = { answered: 999999, correct: 500000, percent: 50, avgMs: 12345.6 };
    stats.bySubject = Array.from({ length: 10 }, (_, i) => ({ subject: `${i}`.padEnd(40, 'x'), answered: 99999, correct: 5, percent: 100 }));
    stats.solo = { standard: { runs: 9999, cleared: 9999, best: 10 }, hard: { runs: 9999, cleared: 9999, best: 10 }, avgCorrectPerRun: 9.99 };
    assert.ok(formatStats(stats, '123456789012345678').length <= 2000);
  });

  test('subject names cannot inject markdown', () => {
    importQuestions(
      [{ id: 500, pack: 'fifthgrader', grade: 1, subject: '**Bold**', type: 'choice', prompt: 'Q?', choices: ['a', 'b'], answer: 'A', accepted: null, source: null }],
      { deactivateMissing: false },
    );
    playSolo({ userId: 'u1', guesses: [right(500)] });
    assert.ok(formatStats(getPlayerStats('u1'), 'u1').includes('\\*\\*Bold\\*\\*'));
  });
});
