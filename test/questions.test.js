import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { closeDb, initDb, getDb } from '../db.js';
import { seedSampleQuestions } from '../importer.js';
import { getQuestion, pickQuestionForTile, subjectsAvailable } from '../questions.js';
import {
  createGame,
  recordGuess,
  recordQuestionShown,
  upsertPlayer,
} from '../records.js';
import { resetRng, setRng } from '../rng.js';
import { seededRng } from '../scripts/fakes.js';

beforeEach(() => {
  initDb(':memory:');
  seedSampleQuestions();
  setRng(seededRng(1));
});
afterEach(() => {
  resetRng();
  closeDb();
});

// Record that `userId` has guessed on `questionId` `times` times.
function guess(userId, questionId, times = 1) {
  upsertPlayer(userId, userId);
  const gameId = createGame({ guildId: 'g', channelId: 'c', pack: 'fifthgrader', format: 'solo', difficulty: 'standard', hostId: userId });
  for (let i = 0; i < times; i++) {
    const gqId = recordQuestionShown({ gameId, questionId, seq: i });
    recordGuess({ gameQuestionId: gqId, gameId, questionId, userId, answer: 'A', correct: false });
  }
}

const tile = (extra = {}) => ({ pack: 'fifthgrader', grade: 1, subject: 'Animals', ...extra });

describe('getQuestion', () => {
  test('parses choices and accepted from JSON', () => {
    const choice = getQuestion(-1);
    assert.deepEqual(choice.choices, ['3', '4', '5', '6']);
    assert.equal(choice.answer, 'B');
    assert.equal(choice.accepted, null);
    assert.equal(choice.type, 'choice');
    const typed = getQuestion(-10);
    assert.equal(typed.choices, null);
    assert.equal(typed.answer, 'Earth');
    assert.deepEqual(typed.accepted, ['the earth', 'planet earth']);
  });

  test('is undefined for an unknown id', () => {
    assert.equal(getQuestion(12345), undefined);
  });
});

describe('subjectsAvailable', () => {
  test('lists subjects with their unused question counts, sorted', () => {
    assert.deepEqual(subjectsAvailable('fifthgrader', 1), [
      { subject: 'Animals', count: 2 },
      { subject: 'Math', count: 2 },
    ]);
  });

  test('excluded ids are not counted, and empty subjects drop out', () => {
    assert.deepEqual(subjectsAvailable('fifthgrader', 1, [-1, -3, -4]), [{ subject: 'Math', count: 1 }]);
  });

  test('inactive questions are not counted', () => {
    getDb().prepare('UPDATE questions SET active = 0 WHERE id = -2').run();
    assert.deepEqual(subjectsAvailable('fifthgrader', 1), [
      { subject: 'Animals', count: 2 },
      { subject: 'Math', count: 1 },
    ]);
  });

  test('is empty for a grade with no questions or another pack', () => {
    assert.deepEqual(subjectsAvailable('fifthgrader', 6), []);
    assert.deepEqual(subjectsAvailable('trivia2', 1), []);
  });
});

describe('pickQuestionForTile', () => {
  test('returns a question from exactly that tile', () => {
    for (let seed = 0; seed < 30; seed++) {
      setRng(seededRng(seed));
      const q = pickQuestionForTile(tile());
      assert.ok([-3, -4].includes(q.id), `got ${q.id}`);
      assert.equal(q.grade, 1);
      assert.equal(q.subject, 'Animals');
    }
  });

  test('both questions come up across different draws', () => {
    const ids = new Set();
    for (let seed = 0; seed < 40; seed++) {
      setRng(seededRng(seed));
      ids.add(pickQuestionForTile(tile()).id);
    }
    assert.deepEqual([...ids].sort((a, b) => a - b), [-4, -3]);
  });

  test('never returns an excluded question', () => {
    for (let seed = 0; seed < 20; seed++) {
      setRng(seededRng(seed));
      assert.equal(pickQuestionForTile(tile({ excludeIds: [-3] })).id, -4);
    }
  });

  test('is undefined when nothing is left, or the tile is unknown', () => {
    assert.equal(pickQuestionForTile(tile({ excludeIds: [-3, -4] })), undefined);
    assert.equal(pickQuestionForTile(tile({ subject: 'Nope' })), undefined);
    assert.equal(pickQuestionForTile(tile({ grade: 5 })), undefined);
  });

  test('skips inactive questions', () => {
    getDb().prepare('UPDATE questions SET active = 0 WHERE id = -3').run();
    for (let seed = 0; seed < 10; seed++) {
      setRng(seededRng(seed));
      assert.equal(pickQuestionForTile(tile()).id, -4);
    }
  });

  test('prefers the question this player has seen the fewest times', () => {
    guess('u1', -3, 2);
    guess('u1', -4, 1);
    for (let seed = 0; seed < 20; seed++) {
      setRng(seededRng(seed));
      assert.equal(pickQuestionForTile(tile({ userId: 'u1' })).id, -4);
    }
  });

  test('an unseen question beats seen ones', () => {
    guess('u1', -3, 1);
    for (let seed = 0; seed < 20; seed++) {
      setRng(seededRng(seed));
      assert.equal(pickQuestionForTile(tile({ userId: 'u1' })).id, -4);
    }
  });

  test('ties are broken at random', () => {
    guess('u1', -3, 1);
    guess('u1', -4, 1);
    const ids = new Set();
    for (let seed = 0; seed < 40; seed++) {
      setRng(seededRng(seed));
      ids.add(pickQuestionForTile(tile({ userId: 'u1' })).id);
    }
    assert.equal(ids.size, 2);
  });

  test("other players' history does not matter", () => {
    guess('u2', -3, 5);
    const ids = new Set();
    for (let seed = 0; seed < 40; seed++) {
      setRng(seededRng(seed));
      ids.add(pickQuestionForTile(tile({ userId: 'u1' })).id);
    }
    assert.equal(ids.size, 2);
  });

  test('without a user there is no preference', () => {
    guess('u1', -3, 5);
    const ids = new Set();
    for (let seed = 0; seed < 40; seed++) {
      setRng(seededRng(seed));
      ids.add(pickQuestionForTile(tile()).id);
    }
    assert.equal(ids.size, 2);
  });
});
