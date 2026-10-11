import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, initDb } from '../db.js';
import { importQuestions, seedSampleQuestions } from '../importer.js';
import {
  bestHardRun,
  formatLeaderboard,
  formatStats,
  getLeaderboard,
  getPlayerStats,
  peekAnswers,
  peekCount,
} from '../stats.js';
import { playNight, playSolo } from '../scripts/testdata.js';

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

// ---- trivia nights ----------------------------------------------------------------------
//
// Red = u1, u2 and u5; Blue = u3 and u4. The host h1 is on neither team.
//   Q1 (-1): Red u1 right,            Blue u3 wrong
//   Q2 (-3): Red u2 right,            Blue u4 right (helping u3, who asked for a teammate)
//   Q3 (-5): Red u1 wrong,            Blue u3 timed out
// Red wins 2-1. u5 never got a turn.

function playNightFixture(extra = {}) {
  return playNight({
    hostId: 'h1',
    teams: [
      { name: 'Red', score: 2, won: true, players: ['u1', 'u2', 'u5'] },
      { name: 'Blue', score: 1, won: false, players: ['u3', 'u4'] },
    ],
    questions: [
      {
        questionId: -1,
        board: 1,
        pickedBy: 'u1',
        guesses: [
          { team: 0, userId: 'u1', answer: 'B', correct: true, responseMs: 2000 },
          { team: 1, userId: 'u3', answer: 'A', correct: false, responseMs: 4000 },
        ],
      },
      {
        questionId: -3,
        board: 1,
        pickedBy: 'u3',
        guesses: [
          { team: 0, userId: 'u2', answer: 'B', correct: true, responseMs: 3000 },
          { team: 1, userId: 'u4', answer: 'B', correct: true, assisted: true, assignedUserId: 'u3', responseMs: 5000 },
        ],
      },
      {
        questionId: -5,
        board: 1,
        pickedBy: 'u1',
        guesses: [
          { team: 0, userId: 'u1', answer: 'A', correct: false, responseMs: 1000 },
          { team: 1, userId: 'u3', timedOut: true },
        ],
      },
    ],
    ...extra,
  });
}

describe('trivia night stats', () => {
  test('nights played, team wins, what they answered, and assists', () => {
    playNightFixture();
    assert.deepEqual(getPlayerStats('u1').nights, { played: 1, wins: 1, answered: 2, correct: 1, percent: 50, assists: 0 });
    assert.deepEqual(getPlayerStats('u2').nights, { played: 1, wins: 1, answered: 1, correct: 1, percent: 100, assists: 0 });
    assert.deepEqual(getPlayerStats('u3').nights, { played: 1, wins: 0, answered: 2, correct: 0, percent: 0, assists: 0 });
    assert.deepEqual(getPlayerStats('u4').nights, { played: 1, wins: 0, answered: 1, correct: 1, percent: 100, assists: 1 });
  });

  test('a teammate who never got a turn still played the night', () => {
    playNightFixture();
    const stats = getPlayerStats('u5');
    assert.deepEqual(stats.nights, { played: 1, wins: 1, answered: 0, correct: 0, percent: null, assists: 0 });
    assert.equal(stats.hasData, true);
  });

  test('the host, who is on no team, has no night stats', () => {
    playNightFixture();
    const stats = getPlayerStats('h1');
    assert.equal(stats.nights, null);
    assert.equal(stats.hasData, false);
  });

  test("night answers count toward a player's overall stats, a timeout included", () => {
    playNightFixture();
    const { overall } = getPlayerStats('u3');
    assert.equal(overall.answered, 2);
    assert.equal(overall.correct, 0);
    assert.equal(overall.avgMs, 4000, 'the timeout has no response time');
  });

  test('night answers also show up by grade and subject next to solo ones', () => {
    playNightFixture();
    playSolo({ userId: 'u1', guesses: [{ questionId: -1, answer: 'B', correct: true }] });
    const stats = getPlayerStats('u1');
    assert.equal(stats.overall.answered, 3);
    assert.equal(stats.byGrade[0].answered, 2, 'grade 1: Q1 on the night and the solo guess');
    assert.equal(stats.solo.standard.runs, 1, 'only the solo game is a solo run');
  });

  test('a night that ended before any question was asked is not counted as played', () => {
    playNight({
      hostId: 'h1',
      status: 'quit',
      teams: [
        { name: 'Red', score: 0, players: ['u1'] },
        { name: 'Blue', score: 0, players: ['u2'] },
      ],
      questions: [],
    });
    assert.equal(getPlayerStats('u1').nights, null);
  });

  test('wins count only the nights their team won', () => {
    playNightFixture();
    playNightFixture({
      teams: [
        { name: 'Red', score: 1, won: false, players: ['u1', 'u2', 'u5'] },
        { name: 'Blue', score: 2, won: true, players: ['u3', 'u4'] },
      ],
    });
    assert.equal(getPlayerStats('u1').nights.played, 2);
    assert.equal(getPlayerStats('u1').nights.wins, 1);
    assert.equal(getPlayerStats('u3').nights.wins, 1);
  });

  test("formatStats adds a Trivia nights line, with singular and plural wording", () => {
    playNightFixture();
    assert.match(
      formatStats(getPlayerStats('u1'), 'u1'),
      /\n\*\*Trivia nights:\*\* 1 played · 1 team win · 2 answered \(50% correct\) · 0 assists given$/,
    );
    assert.match(
      formatStats(getPlayerStats('u4'), 'u4'),
      /\*\*Trivia nights:\*\* 1 played · 0 team wins · 1 answered \(100% correct\) · 1 assist given$/,
    );
  });

  test('a player who only watched has a short line and an "answers" placeholder', () => {
    playNightFixture();
    const text = formatStats(getPlayerStats('u5'), 'u5');
    assert.match(text, /\*\*Overall:\*\* no answers yet/);
    assert.match(text, /\*\*Trivia nights:\*\* 1 played · 1 team win · 0 assists given$/);
  });

  test('players without a night have no night line', () => {
    playSolo({ userId: 'u1', guesses: [right(-1)] });
    assert.ok(!formatStats(getPlayerStats('u1'), 'u1').includes('Trivia nights'));
  });
});

// ---- /leaderboard -----------------------------------------------------------------------

// `total` guesses on sample question -1, `correctCount` of them right, as one game.
function play(userId, name, total, correctCount, extra = {}) {
  return playSolo({
    userId,
    name,
    guesses: Array.from({ length: total }, (_, i) => (i < correctCount ? right(-1) : wrong(-1))),
    ...extra,
  });
}

// Server g1: Ann 20/25, Ben 20/22, Cat 24/30, Dan 10/10 (too few for accuracy), Eve a Casual
// run of 40/40 (never counts). Server g2: Fay 50/50.
function playLeaderboardFixture() {
  play('u1', 'Ann', 25, 20, { guildId: 'g1' });
  play('u2', 'Ben', 22, 20, { guildId: 'g1' });
  play('u3', 'Cat', 30, 24, { guildId: 'g1' });
  play('u4', 'Dan', 10, 10, { guildId: 'g1' });
  play('u5', 'Eve', 40, 40, { guildId: 'g1', difficulty: 'casual' });
  play('u6', 'Fay', 50, 50, { guildId: 'g2' });
}

describe('getLeaderboard', () => {
  test('accuracy ranks by % correct, for players with enough answers in this server', () => {
    playLeaderboardFixture();
    const rows = getLeaderboard({ guildId: 'g1', by: 'accuracy' });
    assert.deepEqual(
      rows.map((r) => [r.name, r.answered, r.correct, r.percent]),
      [
        ['Ben', 22, 20, 91],
        ['Cat', 30, 24, 80], // 80% like Ann, but more answers
        ['Ann', 25, 20, 80],
      ],
      'Dan has under 20 answers, Eve only played Casual, Fay is in another server',
    );
  });

  test('accuracy is the default and the minimum is adjustable', () => {
    playLeaderboardFixture();
    assert.deepEqual(getLeaderboard({ guildId: 'g1' }).map((r) => r.name), ['Ben', 'Cat', 'Ann']);
    assert.deepEqual(
      getLeaderboard({ guildId: 'g1', by: 'accuracy', minAnswers: 10 }).map((r) => r.name),
      ['Dan', 'Ben', 'Cat', 'Ann'],
    );
    assert.deepEqual(getLeaderboard({ guildId: 'g1', by: 'accuracy', minAnswers: 100 }), []);
  });

  test('correct ranks by total right answers, fewer answers winning a tie', () => {
    playLeaderboardFixture();
    assert.deepEqual(
      getLeaderboard({ guildId: 'g1', by: 'correct' }).map((r) => [r.name, r.correct, r.answered]),
      [['Cat', 24, 30], ['Ben', 20, 22], ['Ann', 20, 25], ['Dan', 10, 10]],
      'no minimum for this one, and Eve (Casual) and Fay (other server) are out',
    );
  });

  test('each server has its own board', () => {
    playLeaderboardFixture();
    assert.deepEqual(getLeaderboard({ guildId: 'g2', by: 'correct' }).map((r) => r.name), ['Fay']);
    assert.deepEqual(getLeaderboard({ guildId: 'g3', by: 'correct' }), []);
  });

  test("a player's answers in different servers are not added together", () => {
    play('u1', 'Ann', 5, 5, { guildId: 'g1' });
    play('u1', 'Ann', 7, 6, { guildId: 'g2' });
    assert.equal(getLeaderboard({ guildId: 'g1', by: 'correct' })[0].correct, 5);
    assert.equal(getLeaderboard({ guildId: 'g2', by: 'correct' })[0].correct, 6);
  });

  test('timeouts count as answers, so they lower accuracy', () => {
    playSolo({ userId: 'u1', name: 'Ann', guildId: 'g1', guesses: [...Array(10).fill(right(-1)), ...Array(10).fill(timeout(-1))] });
    assert.deepEqual(getLeaderboard({ guildId: 'g1' }).map((r) => [r.answered, r.correct, r.percent]), [[20, 10, 50]]);
  });

  test('shows at most the top ten', () => {
    for (let i = 1; i <= 12; i++) play(`p${i}`, `Player ${String(i).padStart(2, '0')}`, 20, i, { guildId: 'g1' });
    const rows = getLeaderboard({ guildId: 'g1', by: 'correct' });
    assert.equal(rows.length, 10);
    assert.deepEqual(rows.map((r) => r.correct), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  });

  test('night answers count toward accuracy and correct, in the night’s server', () => {
    playNight({
      hostId: 'h1',
      guildId: 'g1',
      teams: [
        { name: 'Red', score: 20, won: true, players: ['u1'] },
        { name: 'Blue', score: 0, players: ['u2'] },
      ],
      questions: Array.from({ length: 20 }, () => ({
        questionId: -1,
        guesses: [
          { team: 0, userId: 'u1', answer: 'B', correct: true },
          { team: 1, userId: 'u2', answer: 'A', correct: false },
        ],
      })),
    });
    assert.deepEqual(getLeaderboard({ guildId: 'g1' }).map((r) => [r.userId, r.percent]), [['u1', 100], ['u2', 0]]);
    assert.deepEqual(getLeaderboard({ guildId: 'g2' }), []);
  });

  test('wins ranks trivia-night team wins in this server only', () => {
    const night = (guildId, red, blue, winner) =>
      playNight({
        hostId: 'h1',
        guildId,
        teams: [
          { name: 'Red', score: 1, won: winner === 'red', players: red },
          { name: 'Blue', score: 1, won: winner === 'blue', players: blue },
        ],
      });
    night('g1', ['u1', 'u2'], ['u3'], 'red');
    night('g1', ['u1', 'u2'], ['u3'], 'red');
    night('g1', ['u3'], ['u1'], 'red');
    night('g1', ['u4'], ['u5'], null); // nobody won
    night('g2', ['u9'], ['u8'], 'blue');
    const rows = getLeaderboard({ guildId: 'g1', by: 'wins' });
    assert.deepEqual(rows.map((r) => [r.userId, r.wins]), [['u1', 2], ['u2', 2], ['u3', 1]]);
    assert.deepEqual(getLeaderboard({ guildId: 'g2', by: 'wins' }).map((r) => r.userId), ['u8']);
  });

  test('solo games have no wins', () => {
    playLeaderboardFixture();
    assert.deepEqual(getLeaderboard({ guildId: 'g1', by: 'wins' }), []);
  });
});

describe('formatLeaderboard', () => {
  test('accuracy: medals for the top three, then numbers', () => {
    playLeaderboardFixture();
    play('u7', 'Gus', 20, 12, { guildId: 'g1' });
    assert.equal(
      formatLeaderboard(getLeaderboard({ guildId: 'g1' }), 'accuracy'),
      [
        '🏆 **Leaderboard · Accuracy** (at least 20 answers)',
        '🥇 Ben · 91% (20/22)',
        '🥈 Cat · 80% (24/30)',
        '🥉 Ann · 80% (20/25)',
        '4. Gus · 60% (12/20)',
      ].join('\n'),
    );
  });

  test('correct and wins have their own lines', () => {
    playLeaderboardFixture();
    assert.equal(
      formatLeaderboard(getLeaderboard({ guildId: 'g1', by: 'correct' }).slice(0, 2), 'correct'),
      ['🏆 **Leaderboard · Correct answers**', '🥇 Cat · 24 correct (80% of 30)', '🥈 Ben · 20 correct (91% of 22)'].join('\n'),
    );
    assert.equal(
      formatLeaderboard([{ name: 'Ann', wins: 3 }, { name: 'Ben', wins: 1 }], 'wins'),
      ['🏆 **Leaderboard · Trivia night wins**', '🥇 Ann · 3 wins', '🥈 Ben · 1 win'].join('\n'),
    );
  });

  test('says so when there is nobody to show', () => {
    assert.equal(
      formatLeaderboard([], 'accuracy'),
      '🏆 **Leaderboard · Accuracy** (at least 20 answers)\nNobody in this server has answered 20 questions yet.',
    );
    assert.match(formatLeaderboard([], 'correct'), /Nobody in this server has played yet\./);
    assert.match(formatLeaderboard([], 'wins'), /No trivia night has been won in this server yet\./);
  });

  test('names cannot inject markdown, and the text stays under 2000 characters', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ userId: `u${i}`, name: `**${'x'.repeat(40)}**`, answered: 99999, correct: 99999, percent: 100 }));
    const text = formatLeaderboard(rows, 'accuracy');
    assert.ok(text.includes('\\*\\*'));
    assert.ok(text.length <= 2000);
  });
});
