import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChoice, checkTyped, normalize, toNumber } from '../answers.js';

describe('normalize', () => {
  const cases = [
    ['Paris.', 'paris'],
    ['  Hello   World  ', 'hello world'],
    ['"Quoted"', 'quoted'],
    ['(parentheses)', 'parentheses'],
    ['ÉCOLE', 'école'],
    ['ＡＢＣ', 'abc'], // full-width letters fold to ASCII (NFKC)
    ['co-op', 'co-op'], // inner punctuation stays
    ['$5', '5'],
    ['5%', '5'],
    ['12.', '12'],
    ['-5', '-5'], // a minus sign that belongs to a number is kept
    ['−5', '-5'], // including the Unicode minus
    ['.5', '.5'], // and so is a leading decimal point
    ['-.5', '-.5'],
    ['-dog', 'dog'], // but a dash before a word is stripped
    ['!!!', ''],
    ['', ''],
    ['   ', ''],
    ['😀', ''],
    ['😀 smile 😀', 'smile'],
    ['日本語', '日本語'],
    ['new\tyork\ncity', 'new york city'],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(normalize(input), expected);
    });
  }
});

describe('toNumber', () => {
  const numbers = [
    ['12', 12],
    ['12.0', 12],
    ['0', 0],
    ['-3', -3],
    ['.5', 0.5],
    ['1,000', 1000],
    ['1,000,000.5', 1000000.5],
    ['012', 12],
  ];
  for (const [input, expected] of numbers) {
    test(`${input} is ${expected}`, () => assert.equal(toNumber(input), expected));
  }
  for (const input of ['', 'abc', '1,5', '1,00', '12abc', '1e3', '--1', '1.2.3', 'Infinity']) {
    test(`${JSON.stringify(input)} is not a number`, () => assert.equal(toNumber(input), null));
  }
});

describe('checkTyped', () => {
  const q = (answer, accepted = null) => ({ type: 'typed', answer, accepted });

  test('ignores case, spacing and surrounding punctuation', () => {
    const paris = q('Paris');
    for (const guess of ['paris', 'PARIS', ' Paris ', 'Paris.', 'paris!', '"Paris"']) {
      assert.equal(checkTyped(paris, guess), true, guess);
    }
  });

  test('is exact otherwise: no fuzzy matching', () => {
    const paris = q('Paris');
    for (const guess of ['Pariss', 'Parris', 'Pari', 'London', 'Paris France', '']) {
      assert.equal(checkTyped(paris, guess), false, JSON.stringify(guess));
    }
  });

  test('collapses inner whitespace', () => {
    assert.equal(checkTyped(q('New York'), 'new   york'), true);
  });

  test('numbers are compared as numbers', () => {
    const twelve = q('12');
    for (const guess of ['12', '12.0', ' 12 ', '12.', '$12', '012', '12.00']) {
      assert.equal(checkTyped(twelve, guess), true, guess);
    }
    for (const guess of ['13', '1.2', '120', 'twelve']) {
      assert.equal(checkTyped(twelve, guess), false, guess);
    }
  });

  test('thousands separators', () => {
    assert.equal(checkTyped(q('1000'), '1,000'), true);
    assert.equal(checkTyped(q('1,000'), '1000'), true);
    assert.equal(checkTyped(q('1000'), '1,00'), false);
  });

  test('negative numbers keep their sign', () => {
    const minusFive = q('-5');
    assert.equal(checkTyped(minusFive, '-5'), true);
    assert.equal(checkTyped(minusFive, '-5.0'), true);
    assert.equal(checkTyped(minusFive, '−5'), true);
    assert.equal(checkTyped(minusFive, '5'), false);
    assert.equal(checkTyped(q('5'), '-5'), false);
  });

  test('decimals', () => {
    assert.equal(checkTyped(q('0.5'), '.5'), true);
    assert.equal(checkTyped(q('0.5'), '0.50'), true);
    assert.equal(checkTyped(q('0.5'), '5'), false);
  });

  test('accepted alternatives count, each normalised', () => {
    const two = q('2', ['two', 'Two!']);
    assert.equal(checkTyped(two, '2'), true);
    assert.equal(checkTyped(two, 'TWO'), true);
    assert.equal(checkTyped(two, 'too'), false);
    const earth = q('Earth', ['the earth', 'planet earth']);
    assert.equal(checkTyped(earth, 'The Earth'), true);
    assert.equal(checkTyped(earth, 'Planet  Earth.'), true);
    assert.equal(checkTyped(earth, 'mars'), false);
  });

  test('a number answer does not match a word guess unless accepted', () => {
    assert.equal(checkTyped(q('12'), 'twelve'), false);
    assert.equal(checkTyped(q('12', ['twelve']), 'Twelve'), true);
  });

  test('a guess with nothing readable never matches', () => {
    assert.equal(checkTyped(q('!!!'), '???'), false);
    assert.equal(checkTyped(q('Paris'), '   '), false);
  });
});

describe('checkChoice', () => {
  const question = { type: 'choice', answer: 'C' };
  test('compares the original letter', () => {
    assert.equal(checkChoice(question, 'C'), true);
    assert.equal(checkChoice(question, 'A'), false);
    assert.equal(checkChoice(question, 'c'), false);
  });
});
