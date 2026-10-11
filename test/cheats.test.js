import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CHEATS, CHEAT_KINDS, cheatAvailability, peekText, pickStruck } from '../cheats.js';
import { PEEK_MIN_ANSWERS } from '../constants.js';
import { resetRng, setRng } from '../rng.js';
import { seededRng } from '../scripts/fakes.js';

afterEach(() => resetRng());

const four = { type: 'choice', choices: ['a', 'b', 'c', 'd'], answer: 'C' };
const three = { type: 'choice', choices: ['a', 'b', 'c'], answer: 'B' };
const two = { type: 'choice', choices: ['a', 'b'], answer: 'A' };
const typed = { type: 'typed', answer: '42' };

// Everything available unless a test says otherwise.
const base = { question: four, struck: [], used: new Set(), peekTotal: PEEK_MIN_ANSWERS, swapAvailable: true };

describe('the cheat list', () => {
  test('is in button order, with the names stored in cheat_uses', () => {
    assert.deepEqual(CHEAT_KINDS, ['peek', 'fifty', 'swap', 'time']);
    assert.deepEqual(CHEATS.map((c) => c.db), ['peek', 'fifty', 'swap', 'extra_time']);
    assert.ok(CHEATS.every((c) => c.label.length <= 80));
  });
});

describe('cheatAvailability', () => {
  test('everything is available on a fresh multiple-choice question', () => {
    assert.deepEqual(cheatAvailability(base), { peek: true, fifty: true, swap: true, time: true });
  });

  test('Peek needs enough answers from other games', () => {
    assert.equal(cheatAvailability({ ...base, peekTotal: PEEK_MIN_ANSWERS - 1 }).peek, false);
    assert.equal(cheatAvailability({ ...base, peekTotal: PEEK_MIN_ANSWERS }).peek, true);
    assert.equal(cheatAvailability({ ...base, peekTotal: 0 }).peek, false);
  });

  test('50/50 needs a multiple-choice question with 3 or more choices', () => {
    assert.equal(cheatAvailability({ ...base, question: typed }).fifty, false);
    assert.equal(cheatAvailability({ ...base, question: two }).fifty, false);
    assert.equal(cheatAvailability({ ...base, question: three }).fifty, true);
    assert.equal(cheatAvailability({ ...base, question: four }).fifty, true);
  });

  test('50/50 is unavailable once only two choices remain', () => {
    assert.equal(cheatAvailability({ ...base, struck: [0, 1] }).fifty, false);
    assert.equal(cheatAvailability({ ...base, question: three, struck: [0] }).fifty, false);
  });

  test('Swap needs another question for the tile', () => {
    assert.equal(cheatAvailability({ ...base, swapAvailable: false }).swap, false);
    assert.equal(cheatAvailability({ ...base, swapAvailable: undefined }).swap, false);
  });

  test('Extra time is always available', () => {
    assert.equal(cheatAvailability({ ...base, question: typed, peekTotal: 0, swapAvailable: false }).time, true);
  });

  test('each cheat can be used once per question', () => {
    for (const kind of CHEAT_KINDS) {
      const available = cheatAvailability({ ...base, used: new Set([kind]) });
      assert.equal(available[kind], false, `${kind} after use`);
      for (const other of CHEAT_KINDS.filter((k) => k !== kind)) {
        assert.equal(available[other], true, `${other} unaffected by ${kind}`);
      }
    }
  });

  test('a typed question can still use everything except 50/50', () => {
    assert.deepEqual(cheatAvailability({ ...base, question: typed }), { peek: true, fifty: false, swap: true, time: true });
  });
});

describe('pickStruck', () => {
  const orders = [
    [0, 1, 2, 3],
    [3, 2, 1, 0],
    [2, 0, 3, 1],
    [1, 3, 0, 2],
  ];

  test('strikes two wrong answers on a 4-choice question and never the right one', () => {
    for (const order of orders) {
      for (let seed = 0; seed < 25; seed++) {
        setRng(seededRng(seed));
        const struck = pickStruck(four, order);
        assert.equal(struck.length, 2);
        assert.equal(new Set(struck).size, 2);
        const correctPosition = order.indexOf(2); // 'C' is original index 2
        assert.ok(!struck.includes(correctPosition), `order ${order} seed ${seed}`);
        assert.ok(struck.every((p) => p >= 0 && p < 4));
        assert.deepEqual(struck, [...struck].sort((a, b) => a - b));
      }
    }
  });

  test('strikes one on a 3-choice question', () => {
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
      for (let seed = 0; seed < 25; seed++) {
        setRng(seededRng(seed));
        const struck = pickStruck(three, order);
        assert.equal(struck.length, 1);
        assert.notEqual(struck[0], order.indexOf(1)); // 'B' is original index 1
      }
    }
  });

  test('strikes nothing on a 2-choice question', () => {
    assert.deepEqual(pickStruck(two, [1, 0]), []);
  });

  test('every wrong answer gets struck sometimes', () => {
    const seen = new Set();
    for (let seed = 0; seed < 60; seed++) {
      setRng(seededRng(seed));
      pickStruck(four, [0, 1, 2, 3]).forEach((p) => seen.add(p));
    }
    assert.deepEqual([...seen].sort(), [0, 1, 3]);
  });

  test('is deterministic for a given rng', () => {
    setRng(seededRng(5));
    const first = pickStruck(four, [0, 1, 2, 3]);
    setRng(seededRng(5));
    assert.deepEqual(pickStruck(four, [0, 1, 2, 3]), first);
  });
});

describe('peekText', () => {
  test('choice results use the letters as displayed, not the original ones', () => {
    // Shown as A) original C, B) original A, C) original D, D) original B.
    const order = [2, 0, 3, 1];
    const answers = ['A', 'A', 'B', 'C', 'C']; // original letters: A x2, B x1, C x2
    assert.equal(
      peekText({ question: four, order, answers }),
      '👀 **Peek**\nA 40% · B 40% · C 0% · D 20% (5 answers)',
    );
  });

  test('percentages are rounded', () => {
    const answers = ['A', 'A', 'B', 'C', 'C', 'C', 'D'];
    assert.equal(
      peekText({ question: four, order: [0, 1, 2, 3], answers }),
      '👀 **Peek**\nA 29% · B 14% · C 43% · D 14% (7 answers)',
    );
  });

  test('a 3-choice question lists three letters', () => {
    const text = peekText({ question: three, order: [1, 2, 0], answers: ['A', 'B', 'B', 'C', 'B'] });
    assert.equal(text, '👀 **Peek**\nA 60% · B 20% · C 20% (5 answers)');
  });

  test('typed answers are grouped after normalising, most common first, top three', () => {
    const answers = ['Mice', 'mice', 'mice.', 'mouse', 'Mouse!', 'mices', 'x'];
    assert.equal(
      peekText({ question: typed, order: null, answers }),
      '👀 **Peek**\n"mice" 43% · "mouse" 29% · "mices" 14% (7 answers)',
    );
  });

  test('typed ties are listed alphabetically, and blanks are labelled', () => {
    const text = peekText({ question: typed, order: null, answers: ['b', 'a', '', '  ', 'c'] });
    assert.equal(text, '👀 **Peek**\n"(blank)" 40% · "a" 20% · "b" 20% (5 answers)');
  });

  test('typed text cannot inject markdown', () => {
    const text = peekText({ question: typed, order: null, answers: ['a*b*c', 'a*b*c', 'x', 'y', 'z'] });
    assert.match(text, /"a\\\*b\\\*c" 40%/);
  });
});
