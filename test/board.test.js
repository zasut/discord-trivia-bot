import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ButtonStyle } from 'discord.js';
import {
  boardComponents,
  buildBoard,
  currentGrade,
  isClickable,
  isCleared,
  ordinal,
  tileLabel,
} from '../board.js';
import { cid, parseCustomId } from '../constants.js';
import { closeDb, getDb, initDb } from '../db.js';
import { importQuestions, seedSampleQuestions } from '../importer.js';
import { resetRng, setRng } from '../rng.js';
import { seededRng } from '../scripts/fakes.js';

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

beforeEach(() => {
  initDb(':memory:');
  seedSampleQuestions();
  setRng(seededRng(1));
});
afterEach(() => {
  resetRng();
  closeDb();
});

// A real (positive id) choice question.
function addQuestion(id, grade, subject) {
  importQuestions(
    [
      {
        id,
        pack: 'fifthgrader',
        grade,
        subject,
        type: 'choice',
        prompt: `Question ${id}?`,
        choices: ['a', 'b'],
        answer: 'A',
        accepted: null,
        source: null,
      },
    ],
    { deactivateMissing: false },
  );
}

const open = (grade, subject, index = 0) => ({ index, grade, subject, state: 'open' });

describe('labels', () => {
  test('ordinal', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(ordinal), ['1st', '2nd', '3rd', '4th', '5th']);
  });
  test('tileLabel', () => {
    assert.equal(tileLabel({ grade: 3, subject: 'Science' }), '3rd · Science');
  });
});

describe('buildBoard', () => {
  test('gives two tiles per grade from the sample bank, in grade order', () => {
    const board = buildBoard('fifthgrader');
    assert.equal(board.ok, true);
    assert.equal(board.tiles.length, 10);
    assert.deepEqual(board.tiles.map((t) => t.grade), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    assert.deepEqual(board.tiles.map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.ok(board.tiles.every((t) => t.state === 'open'));
  });

  test('the two subjects in a grade are different and sorted', () => {
    for (let seed = 0; seed < 20; seed++) {
      setRng(seededRng(seed));
      const { tiles } = buildBoard('fifthgrader');
      for (let grade = 1; grade <= 5; grade++) {
        const [a, b] = tiles.filter((t) => t.grade === grade).map((t) => t.subject);
        assert.notEqual(a, b);
        assert.ok(a.localeCompare(b) < 0, `${a} before ${b}`);
      }
    }
  });

  test('with more subjects than tiles, picks two at random, and all get a turn', () => {
    addQuestion(1, 2, 'Science');
    addQuestion(2, 2, 'Music');
    // grade 2 now has Geography, Spelling, Science and Music
    const seen = new Set();
    for (let seed = 0; seed < 60; seed++) {
      setRng(seededRng(seed));
      const tiles = buildBoard('fifthgrader').tiles.filter((t) => t.grade === 2);
      assert.equal(tiles.length, 2);
      tiles.forEach((t) => seen.add(t.subject));
    }
    assert.deepEqual([...seen].sort(), ['Geography', 'Music', 'Science', 'Spelling']);
  });

  test('is deterministic for a given rng', () => {
    addQuestion(1, 2, 'Science');
    setRng(seededRng(99));
    const first = buildBoard('fifthgrader');
    setRng(seededRng(99));
    assert.deepEqual(buildBoard('fifthgrader'), first);
  });

  test('a grade with a single subject gets a single tile', () => {
    getDb().prepare("UPDATE questions SET active = 0 WHERE grade = 4 AND subject = 'Health'").run();
    const { ok, tiles } = buildBoard('fifthgrader');
    assert.equal(ok, true);
    assert.equal(tiles.length, 9);
    assert.deepEqual(tiles.filter((t) => t.grade === 4).map((t) => t.subject), ['Grammar']);
    assert.deepEqual(tiles.map((t) => t.index), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'indexes stay contiguous');
  });

  test('reports the first grade with no questions', () => {
    getDb().prepare('UPDATE questions SET active = 0 WHERE grade = 3').run();
    assert.deepEqual(buildBoard('fifthgrader'), { ok: false, missingGrade: 3 });
    getDb().prepare('UPDATE questions SET active = 0 WHERE grade = 1').run();
    assert.deepEqual(buildBoard('fifthgrader'), { ok: false, missingGrade: 1 });
  });

  test('ignores inactive questions', () => {
    getDb().prepare("UPDATE questions SET active = 0 WHERE subject = 'Math'").run();
    const { tiles } = buildBoard('fifthgrader');
    assert.deepEqual(tiles.filter((t) => t.grade === 1).map((t) => t.subject), ['Animals']);
  });

  test('excluded question ids are treated as used', () => {
    // Animals in grade 1 are ids -3 and -4: exclude both and the subject disappears.
    const { tiles } = buildBoard('fifthgrader', { excludeIds: [-3, -4] });
    assert.deepEqual(tiles.filter((t) => t.grade === 1).map((t) => t.subject), ['Math']);
    // One left is still enough.
    const some = buildBoard('fifthgrader', { excludeIds: [-3] });
    assert.deepEqual(some.tiles.filter((t) => t.grade === 1).map((t) => t.subject), ['Animals', 'Math']);
    // Everything in a grade excluded: the board can't be built.
    assert.deepEqual(buildBoard('fifthgrader', { excludeIds: [-5, -6, -7, -8] }), { ok: false, missingGrade: 2 });
  });

  test('other packs are not mixed in', () => {
    assert.deepEqual(buildBoard('trivia2'), { ok: false, missingGrade: 1 });
  });
});

describe('the climb rule', () => {
  const tiles = () => [open(1, 'A', 0), open(1, 'B', 1), open(2, 'C', 2), open(2, 'D', 3)];

  test('only the lowest grade with unplayed tiles is clickable', () => {
    const board = tiles();
    assert.equal(currentGrade(board), 1);
    assert.deepEqual(board.map((t) => isClickable(board, t)), [true, true, false, false]);
  });

  test('both tiles of a grade must be played before the next unlocks', () => {
    const board = tiles();
    board[0].state = 'right';
    assert.equal(currentGrade(board), 1);
    assert.deepEqual(board.map((t) => isClickable(board, t)), [false, true, false, false]);
    board[1].state = 'wrong';
    assert.equal(currentGrade(board), 2);
    assert.deepEqual(board.map((t) => isClickable(board, t)), [false, false, true, true]);
  });

  test('a skipped tile counts as played', () => {
    const board = tiles();
    board[0].state = 'skipped';
    board[1].state = 'right';
    assert.equal(currentGrade(board), 2);
  });

  test('the board is cleared when nothing is open', () => {
    const board = tiles();
    assert.equal(isCleared(board), false);
    board.forEach((t) => (t.state = 'right'));
    assert.equal(isCleared(board), true);
    assert.equal(currentGrade(board), null);
    assert.equal(isClickable(board, board[0]), false);
  });

  test('an unknown tile is never clickable', () => {
    assert.equal(isClickable(tiles(), undefined), false);
  });
});

describe('boardComponents', () => {
  const full = () => buildBoard('fifthgrader').tiles;
  const control = { type: 2, custom_id: cid.quit(SID), label: 'Quit', style: ButtonStyle.Secondary };

  test('one row per grade, each within Discord limits, with the control last', () => {
    const rows = boardComponents(SID, full(), control);
    assert.equal(rows.length, 5);
    assert.ok(rows.length <= 5);
    rows.slice(0, 4).forEach((r) => assert.equal(r.components.length, 2));
    assert.equal(rows[4].components.length, 3, 'two tiles plus the control');
    assert.equal(rows[4].components.at(-1), control);
    rows.forEach((r) => assert.ok(r.components.length <= 5));
    rows.forEach((r) => r.components.forEach((c) => assert.ok(c.label.length <= 80)));
  });

  test('works without a control button', () => {
    const rows = boardComponents(SID, full());
    assert.equal(rows[4].components.length, 2);
  });

  test('tile ids parse back to their index, and only grade 1 is enabled at the start', () => {
    const rows = boardComponents(SID, full(), control);
    const tileButtons = rows.flatMap((r) => r.components).filter((c) => parseCustomId(c.custom_id).kind === 'tile');
    assert.deepEqual(tileButtons.map((c) => Number(parseCustomId(c.custom_id).args[0])), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(tileButtons.map((c) => c.disabled), [false, false, true, true, true, true, true, true, true, true]);
    assert.equal(tileButtons[0].style, ButtonStyle.Primary);
    assert.equal(tileButtons[2].style, ButtonStyle.Secondary);
  });

  test('played tiles show their result and are disabled', () => {
    const tiles = full();
    tiles[0].state = 'right';
    tiles[1].state = 'wrong';
    const [first, second] = boardComponents(SID, tiles, control)[0].components;
    assert.match(first.label, /^✅ 1st · /);
    assert.equal(first.style, ButtonStyle.Success);
    assert.equal(first.disabled, true);
    assert.match(second.label, /^❌ 1st · /);
    assert.equal(second.style, ButtonStyle.Danger);
    assert.equal(second.disabled, true);
    const next = boardComponents(SID, tiles, control)[1].components[0];
    assert.equal(next.disabled, false, 'grade 2 unlocks');
  });

  test('skipped tiles are shown disabled', () => {
    const tiles = full();
    tiles[0].state = 'skipped';
    const first = boardComponents(SID, tiles, control)[0].components[0];
    assert.match(first.label, /^➖ /);
    assert.equal(first.disabled, true);
  });

  test('a grade with one tile makes a one-button row', () => {
    const tiles = [open(1, 'A', 0), open(2, 'B', 1), open(3, 'C', 2), open(4, 'D', 3), open(5, 'E', 4)];
    const rows = boardComponents(SID, tiles, control);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((r) => r.components.length), [1, 1, 1, 1, 2]);
  });

  test('a full-length subject still fits in a button label', () => {
    const tiles = [open(5, 'x'.repeat(40), 0)];
    tiles[0].state = 'right';
    const [button] = boardComponents(SID, tiles)[0].components;
    assert.ok(button.label.length <= 80);
  });
});
