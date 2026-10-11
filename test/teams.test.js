import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetRng, setRng } from '../rng.js';
import { seededRng } from '../scripts/fakes.js';
import {
  answerOrder,
  currentAnswerer,
  dealTeams,
  nextPickIndex,
  teamLabel,
  winningTeams,
} from '../teams.js';

afterEach(() => resetRng());

const ids = (n) => Array.from({ length: n }, (_, i) => `u${i + 1}`);

describe('dealTeams', () => {
  test('puts every player on exactly one team', () => {
    setRng(seededRng(1));
    const players = ids(7);
    for (const count of [2, 3, 4]) {
      const teams = dealTeams(players, count);
      assert.equal(teams.length, count);
      assert.deepEqual(teams.flat().sort(), [...players].sort());
    }
  });

  test('deals round-robin, so team sizes differ by at most one', () => {
    setRng(seededRng(2));
    assert.deepEqual(dealTeams(ids(5), 2).map((t) => t.length), [3, 2]);
    assert.deepEqual(dealTeams(ids(5), 3).map((t) => t.length), [2, 2, 1]);
    assert.deepEqual(dealTeams(ids(5), 4).map((t) => t.length), [2, 1, 1, 1]);
    assert.deepEqual(dealTeams(ids(8), 4).map((t) => t.length), [2, 2, 2, 2]);
  });

  test('is shuffled: different draws give different teams', () => {
    const seen = new Set();
    for (let seed = 0; seed < 30; seed++) {
      setRng(seededRng(seed));
      seen.add(JSON.stringify(dealTeams(ids(6), 2)));
    }
    assert.ok(seen.size > 5, `${seen.size} distinct deals`);
  });

  test('is deterministic for a given rng', () => {
    setRng(seededRng(9));
    const first = dealTeams(ids(6), 3);
    setRng(seededRng(9));
    assert.deepEqual(dealTeams(ids(6), 3), first);
  });

  test('leaves the input alone', () => {
    const players = ids(4);
    dealTeams(players, 2);
    assert.deepEqual(players, ids(4));
  });

  test('more teams than players leaves some empty', () => {
    assert.deepEqual(dealTeams(['u1'], 2).map((t) => t.length), [1, 0]);
  });
});

describe('answerOrder', () => {
  const names = (entries) => new Map(Object.entries(entries));

  test('is alphabetical by name, ignoring case', () => {
    const order = answerOrder(['1', '2', '3', '4'], names({ 1: 'zed', 2: 'Amy', 3: 'bob', 4: 'ÉMILE' }));
    assert.deepEqual(order, ['2', '3', '4', '1']);
  });

  test('ties are broken by user id, numerically for real ids', () => {
    const tied = names({ 3: 'Sam', 20: 'sam', 100: 'SAM' });
    assert.deepEqual(answerOrder(['100', '3', '20'], tied), ['3', '20', '100']);
    const big = names({ 1234567890123456789: 'Sam', 999999999999999999: 'Sam' });
    assert.deepEqual(answerOrder(['1234567890123456789', '999999999999999999'], big), ['999999999999999999', '1234567890123456789']);
  });

  test('ids that are not numbers fall back to plain text order', () => {
    assert.deepEqual(answerOrder(['b', 'a'], names({ a: 'Sam', b: 'Sam' })), ['a', 'b']);
  });

  test('the result does not depend on the order the players were given in', () => {
    const n = names({ a: 'Cy', b: 'Al', c: 'Bo' });
    assert.deepEqual(answerOrder(['a', 'b', 'c'], n), answerOrder(['c', 'a', 'b'], n));
  });

  test('leaves the input alone', () => {
    const input = ['a', 'b'];
    answerOrder(input, names({ a: 'Z', b: 'A' }));
    assert.deepEqual(input, ['a', 'b']);
  });
});

describe('currentAnswerer', () => {
  const team = { members: ['a', 'b', 'c'], turn: 0 };

  test('walks the members in order and wraps around', () => {
    const seen = [];
    for (let turn = 0; turn < 7; turn++) seen.push(currentAnswerer({ ...team, turn }));
    assert.deepEqual(seen, ['a', 'b', 'c', 'a', 'b', 'c', 'a']);
  });

  test('a one-person team always answers itself', () => {
    assert.equal(currentAnswerer({ members: ['solo'], turn: 5 }), 'solo');
  });
});

describe('nextPickIndex', () => {
  test('rotates through the teams in order and wraps', () => {
    let index = 0;
    const picks = [];
    for (let i = 0; i < 7; i++) {
      picks.push(index);
      index = nextPickIndex(index, 3);
    }
    assert.deepEqual(picks, [0, 1, 2, 0, 1, 2, 0]);
  });
});

describe('winningTeams', () => {
  const team = (score) => ({ score });

  test('the highest score wins', () => {
    const teams = [team(2), team(5), team(3)];
    assert.deepEqual(winningTeams(teams), [teams[1]]);
  });

  test('ties share the win', () => {
    const teams = [team(4), team(4), team(1)];
    assert.deepEqual(winningTeams(teams), [teams[0], teams[1]]);
  });

  test('if nobody scored there is no winner', () => {
    assert.deepEqual(winningTeams([team(0), team(0)]), []);
    assert.deepEqual(winningTeams([]), []);
  });
});

describe('teamLabel', () => {
  test('the four teams', () => {
    assert.deepEqual([0, 1, 2, 3].map(teamLabel), ['🟥 Red', '🟦 Blue', '🟩 Green', '🟨 Yellow']);
  });
});
