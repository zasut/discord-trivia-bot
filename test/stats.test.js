import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, initDb } from '../db.js';
import { seedSampleQuestions } from '../importer.js';
import { bestHardRun, peekAnswers, peekCount } from '../stats.js';
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
