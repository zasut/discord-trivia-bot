import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb, closeDb, getDb } from '../db.js';
import {
  parseQuestions,
  importQuestions,
  importFile,
  seedSampleQuestions,
  summarizeQuestions,
  SAMPLE_CSV_PATH,
} from '../importer.js';
import { countActiveQuestions } from '../questions.js';

const HEADER = 'id,pack,grade,subject,type,prompt,choice_a,choice_b,choice_c,choice_d,answer,accepted,source';

// One valid multiple-choice row, with any column overridden.
function row(overrides = {}) {
  const base = {
    id: '1',
    pack: 'fifthgrader',
    grade: '3',
    subject: 'Science',
    type: 'choice',
    prompt: 'Which planet is red?',
    choice_a: 'Mars',
    choice_b: 'Venus',
    choice_c: 'Earth',
    choice_d: '',
    answer: 'A',
    accepted: '',
    source: '',
  };
  const values = { ...base, ...overrides };
  return HEADER.split(',').map((name) => values[name]).join(',');
}

const csv = (...rows) => [HEADER, ...rows].join('\n') + '\n';
const errorsFor = (...rows) => parseQuestions(csv(...rows)).errors;

describe('parseQuestions', () => {
  test('accepts a valid choice and a valid typed question', () => {
    const { questions, errors } = parseQuestions(
      csv(
        row(),
        row({ id: '2', type: 'typed', choice_a: '', choice_b: '', choice_c: '', answer: '144', accepted: 'one hundred forty-four; 144.0', source: 'https://example.com' }),
      ),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(questions[0], {
      id: 1,
      pack: 'fifthgrader',
      grade: 3,
      subject: 'Science',
      type: 'choice',
      prompt: 'Which planet is red?',
      choices: ['Mars', 'Venus', 'Earth'],
      answer: 'A',
      accepted: null,
      source: null,
    });
    assert.deepEqual(questions[1].choices, null);
    assert.equal(questions[1].answer, '144');
    assert.deepEqual(questions[1].accepted, ['one hundred forty-four', '144.0']);
    assert.equal(questions[1].source, 'https://example.com');
  });

  test('columns are matched by name, in any order', () => {
    const text = 'answer,prompt,type,subject,pack,id,grade,choice_a,choice_b\nB,Pick one,choice,Math,fifthgrader,7,1,x,y\n';
    const { questions, errors } = parseQuestions(text);
    assert.deepEqual(errors, []);
    assert.equal(questions[0].id, 7);
    assert.deepEqual(questions[0].choices, ['x', 'y']);
    assert.equal(questions[0].answer, 'B');
  });

  test('values are trimmed and the answer letter is upper-cased', () => {
    const { questions, errors } = parseQuestions(csv(row({ subject: '  Science  ', answer: ' b ' })));
    assert.deepEqual(errors, []);
    assert.equal(questions[0].subject, 'Science');
    assert.equal(questions[0].answer, 'B');
  });

  test('warns about unknown columns and ignores them', () => {
    const { questions, errors, warnings } = parseQuestions(`${HEADER},notes\n${row()},hello\n`);
    assert.deepEqual(errors, []);
    assert.equal(questions.length, 1);
    assert.deepEqual(warnings, ['ignoring unknown column "notes"']);
  });

  test('empty file and header-only file are errors', () => {
    assert.deepEqual(parseQuestions('').errors, ['the file is empty']);
    assert.deepEqual(parseQuestions(`${HEADER}\n`).errors, ['no questions found (the file only has a header row)']);
  });

  test('missing and duplicate header columns', () => {
    const missing = parseQuestions('id,pack,grade,subject,type,answer\n1,fifthgrader,1,Math,typed,2\n');
    assert.deepEqual(missing.errors, ['line 1: missing required column "prompt"']);
    const dup = parseQuestions(`${HEADER},id\n`);
    assert.ok(dup.errors.includes('line 1: column "id" appears more than once'));
  });

  test('an unterminated quote is reported', () => {
    const { errors } = parseQuestions(`${HEADER}\n1,"oops\n`);
    assert.deepEqual(errors, ['line 2: quoted field is never closed']);
  });

  describe('row errors, each with its line number', () => {
    const cases = [
      ['id missing', { id: '' }, 'line 2: id is required'],
      ['id not a number', { id: 'abc' }, 'line 2: id "abc" must be a positive whole number'],
      ['id zero', { id: '0' }, 'line 2: id "0" must be a positive whole number'],
      ['id negative', { id: '-4' }, 'line 2: id "-4" must be a positive whole number'],
      ['id decimal', { id: '1.5' }, 'line 2: id "1.5" must be a positive whole number'],
      ['pack missing', { pack: '' }, 'line 2: pack is required'],
      ['pack unknown', { pack: 'nope' }, 'line 2: pack "nope" is not one of: fifthgrader, trivia2'],
      ['grade missing', { grade: '' }, 'line 2: grade is required for pack "fifthgrader" (a whole number from 1 to 5)'],
      ['grade too high', { grade: '6' }, 'line 2: grade "6" must be a whole number from 1 to 5'],
      ['grade zero', { grade: '0' }, 'line 2: grade "0" must be a whole number from 1 to 5'],
      ['grade not a number', { grade: 'three' }, 'line 2: grade "three" must be a whole number from 1 to 5'],
      ['grade on an ungraded pack', { pack: 'trivia2', grade: '2' }, 'line 2: pack "trivia2" has no grades, so grade must be empty'],
      ['subject missing', { subject: '' }, 'line 2: subject is required'],
      ['subject too long', { subject: 'x'.repeat(41) }, 'line 2: subject is longer than 40 characters'],
      ['prompt missing', { prompt: '' }, 'line 2: prompt is required'],
      ['prompt too long', { prompt: 'x'.repeat(1001) }, 'line 2: prompt is longer than 1000 characters'],
      ['type unknown', { type: 'essay' }, 'line 2: type "essay" must be "choice" or "typed"'],
      ['choice with one choice', { choice_b: '', choice_c: '' }, 'line 2: choice questions need at least 2 choices'],
      ['choice with a gap', { choice_b: '', choice_c: 'Earth' }, 'line 2: choices must be filled in from choice_a onwards with no gaps'],
      ['choice too long', { choice_b: 'x'.repeat(201) }, 'line 2: choice_b is longer than 200 characters'],
      ['duplicate choices', { choice_b: 'mars' }, 'line 2: choices must all be different'],
      ['answer missing', { answer: '' }, 'line 2: answer is required'],
      ['answer not a filled choice', { answer: 'E' }, 'line 2: answer "E" is not one of the filled choices (A–C)'],
      ['answer an empty choice slot', { answer: 'D' }, 'line 2: answer "D" is not one of the filled choices (A–C)'],
      ['answer is not a letter', { answer: 'Mars' }, 'line 2: answer "Mars" is not one of the filled choices (A–C)'],
      ['accepted on a choice question', { accepted: 'red planet' }, 'line 2: accepted is only for typed questions'],
      ['typed with choices', { type: 'typed', answer: 'Mars' }, 'line 2: typed questions must leave choice_a to choice_d empty'],
    ];
    for (const [name, overrides, expected] of cases) {
      test(name, () => {
        assert.deepEqual(errorsFor(row(overrides)), [expected]);
      });
    }

    test('typed question needs an answer', () => {
      const errors = errorsFor(row({ type: 'typed', choice_a: '', choice_b: '', choice_c: '', answer: '' }));
      assert.deepEqual(errors, ['line 2: answer is required']);
    });

    test('duplicate ids name the earlier line', () => {
      assert.deepEqual(errorsFor(row({ id: '5' }), row({ id: '5', prompt: 'Another?' })), [
        'line 3: id 5 is already used on line 2',
      ]);
    });

    test('too many values for the header', () => {
      assert.deepEqual(errorsFor(`${row()},extra`), ['line 2: has 14 values but the header only has 13 columns']);
    });

    test('reports every bad row, not just the first', () => {
      const errors = errorsFor(row({ id: '1', grade: '9' }), row({ id: '2' }), row({ id: '3', answer: 'Z' }));
      assert.equal(errors.length, 2);
      assert.match(errors[0], /^line 2: grade/);
      assert.match(errors[1], /^line 4: answer/);
    });

    test('line numbers account for newlines inside quoted fields', () => {
      const text = `${HEADER}\n${row({ prompt: '"two\nlines"' })}\n${row({ id: '2', grade: '9' })}\n`;
      assert.deepEqual(parseQuestions(text).errors, ['line 4: grade "9" must be a whole number from 1 to 5']);
    });
  });

  test('sample mode needs negative ids and rejects positive ones', () => {
    assert.deepEqual(parseQuestions(csv(row({ id: '-1' })), { sample: true }).errors, []);
    assert.deepEqual(parseQuestions(csv(row({ id: '1' })), { sample: true }).errors, [
      'line 2: id "1" must be a negative whole number (sample ids are negative)',
    ]);
  });
});

describe('questions/sample.csv', () => {
  const { questions, errors } = parseQuestions(readFileSync(SAMPLE_CSV_PATH, 'utf8'), { sample: true });

  test('is valid', () => {
    assert.deepEqual(errors, []);
    assert.equal(questions.length, 20);
  });

  test('uses ids -1 to -20 and marks every prompt as a sample', () => {
    assert.deepEqual(questions.map((q) => q.id), Array.from({ length: 20 }, (_, i) => -(i + 1)));
    assert.ok(questions.every((q) => q.prompt.startsWith('[Sample]')));
  });

  test('covers grades 1-5 with two subjects of two questions each and a typed question per grade', () => {
    for (let grade = 1; grade <= 5; grade++) {
      const inGrade = questions.filter((q) => q.grade === grade);
      const subjects = new Set(inGrade.map((q) => q.subject));
      assert.equal(subjects.size, 2, `grade ${grade} subjects`);
      for (const subject of subjects) {
        assert.equal(inGrade.filter((q) => q.subject === subject).length, 2, `grade ${grade} ${subject}`);
      }
      assert.ok(inGrade.some((q) => q.type === 'typed'), `grade ${grade} has a typed question`);
    }
  });

  test('is not a real CSV that real imports would accept', () => {
    assert.ok(parseQuestions(readFileSync(SAMPLE_CSV_PATH, 'utf8')).errors.length > 0);
  });
});

describe('importQuestions', () => {
  beforeEach(() => initDb(':memory:'));
  afterEach(() => closeDb());

  const valid = (...rows) => parseQuestions(csv(...rows)).questions;

  test('inserts new questions with choices and accepted stored as JSON', () => {
    const result = importQuestions(valid(row(), row({ id: '2', type: 'typed', choice_a: '', choice_b: '', choice_c: '', answer: '12', accepted: 'twelve' })));
    assert.deepEqual(result, { added: 2, updated: 0, unchanged: 0, deactivated: 0 });
    const one = getDb().prepare('SELECT * FROM questions WHERE id = 1').get();
    assert.equal(one.choices, '["Mars","Venus","Earth"]');
    assert.equal(one.accepted, null);
    assert.equal(one.active, 1);
    const two = getDb().prepare('SELECT * FROM questions WHERE id = 2').get();
    assert.equal(two.choices, null);
    assert.equal(two.accepted, '["twelve"]');
  });

  test('re-importing the same file changes nothing', () => {
    importQuestions(valid(row()));
    const before = { ...getDb().prepare('SELECT * FROM questions WHERE id = 1').get() };
    const result = importQuestions(valid(row()));
    assert.deepEqual(result, { added: 0, updated: 0, unchanged: 1, deactivated: 0 });
    assert.deepEqual({ ...getDb().prepare('SELECT * FROM questions WHERE id = 1').get() }, before);
  });

  test('upserts by id: a changed row is updated in place', () => {
    importQuestions(valid(row()));
    const result = importQuestions(valid(row({ prompt: 'Which planet is the Red Planet?', answer: 'B' })));
    assert.deepEqual(result, { added: 0, updated: 1, unchanged: 0, deactivated: 0 });
    const q = getDb().prepare('SELECT * FROM questions WHERE id = 1').get();
    assert.equal(q.prompt, 'Which planet is the Red Planet?');
    assert.equal(q.answer, 'B');
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM questions').get().n, 1);
  });

  test('questions missing from the file are deactivated, never deleted', () => {
    importQuestions(valid(row({ id: '1' }), row({ id: '2', prompt: 'Second?' })));
    const result = importQuestions(valid(row({ id: '1' })));
    assert.deepEqual(result, { added: 0, updated: 0, unchanged: 1, deactivated: 1 });
    assert.equal(getDb().prepare('SELECT active FROM questions WHERE id = 2').get().active, 0);
    assert.equal(countActiveQuestions(), 1);
  });

  test('a question that returns to the file is reactivated', () => {
    importQuestions(valid(row({ id: '1' }), row({ id: '2', prompt: 'Second?' })));
    importQuestions(valid(row({ id: '1' })));
    const result = importQuestions(valid(row({ id: '1' }), row({ id: '2', prompt: 'Second?' })));
    assert.deepEqual(result, { added: 0, updated: 1, unchanged: 1, deactivated: 0 });
    assert.equal(countActiveQuestions(), 2);
  });

  test('deactivateMissing: false leaves other questions alone', () => {
    importQuestions(valid(row({ id: '1' })));
    const result = importQuestions(valid(row({ id: '2', prompt: 'Second?' })), { deactivateMissing: false });
    assert.equal(result.deactivated, 0);
    assert.equal(countActiveQuestions(), 2);
  });

  test('is all-or-nothing: a failure rolls everything back', () => {
    importQuestions(valid(row({ id: '1' })));
    const bad = [...valid(row({ id: '2', prompt: 'Second?' })), { ...valid(row({ id: '3' }))[0], type: 'bogus' }];
    assert.throws(() => importQuestions(bad));
    assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM questions').get().n, 1);
  });

  test('summarizeQuestions counts active questions per pack, grade and subject', () => {
    importQuestions(valid(row({ id: '1' }), row({ id: '2', prompt: 'B?' }), row({ id: '3', prompt: 'C?', grade: '1', subject: 'Math' })));
    assert.deepEqual(summarizeQuestions(), [
      { pack: 'fifthgrader', grade: 1, subject: 'Math', count: 1 },
      { pack: 'fifthgrader', grade: 3, subject: 'Science', count: 2 },
    ]);
  });
});

describe('importFile and seeding', () => {
  let dir;
  beforeEach(() => {
    initDb(':memory:');
    dir = mkdtempSync(join(tmpdir(), 'trivia-import-'));
  });
  afterEach(() => {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  test('imports a valid file and reports counts', () => {
    const file = join(dir, 'q.csv');
    writeFileSync(file, csv(row({ id: '1' }), row({ id: '2', prompt: 'Second?' })));
    const result = importFile(file);
    assert.equal(result.ok, true);
    assert.equal(result.added, 2);
    assert.deepEqual(result.counts, [{ pack: 'fifthgrader', grade: 3, subject: 'Science', count: 2 }]);
  });

  test('an invalid file imports nothing at all', () => {
    const file = join(dir, 'q.csv');
    writeFileSync(file, csv(row({ id: '1' }), row({ id: '2', grade: '9' })));
    const result = importFile(file);
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, ['line 3: grade "9" must be a whole number from 1 to 5']);
    assert.equal(countActiveQuestions(), 0);
  });

  test('a missing file throws', () => {
    assert.throws(() => importFile(join(dir, 'nope.csv')), { code: 'ENOENT' });
  });

  test('seedSampleQuestions loads the 20 samples', () => {
    assert.equal(countActiveQuestions(), 0);
    assert.equal(seedSampleQuestions().added, 20);
    assert.equal(countActiveQuestions(), 20);
  });

  test('seeding twice is harmless', () => {
    seedSampleQuestions();
    assert.deepEqual(seedSampleQuestions(), { added: 0, updated: 0, unchanged: 20, deactivated: 0 });
  });

  test('a real import deactivates the samples', () => {
    seedSampleQuestions();
    const file = join(dir, 'q.csv');
    writeFileSync(file, csv(row({ id: '1' })));
    const result = importFile(file);
    assert.equal(result.deactivated, 20);
    assert.equal(countActiveQuestions(), 1);
  });

  test('seeding next to real questions leaves them active', () => {
    const file = join(dir, 'q.csv');
    writeFileSync(file, csv(row({ id: '1' })));
    importFile(file);
    seedSampleQuestions();
    assert.equal(getDb().prepare('SELECT active FROM questions WHERE id = 1').get().active, 1);
  });
});
