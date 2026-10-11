// Question-bank import: validate a CSV (DESIGN.md "Question bank"), then upsert it into
// the database. Shared by `npm run import` and the sample auto-seed in app.js.
//
// Validation is all-or-nothing: parseQuestions() reports every problem with its CSV line
// number and importQuestions() is only called when there are none.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCsv } from './csv.js';
import { PACKS } from './constants.js';
import { getDb, transaction, nowIso } from './db.js';

export const SAMPLE_CSV_PATH = fileURLToPath(new URL('./questions/sample.csv', import.meta.url));
export const DEFAULT_QUESTIONS_PATH = fileURLToPath(new URL('./data/questions.csv', import.meta.url));

const LETTERS = ['A', 'B', 'C', 'D'];
const CHOICE_COLUMNS = ['choice_a', 'choice_b', 'choice_c', 'choice_d'];
const REQUIRED_COLUMNS = ['id', 'pack', 'subject', 'type', 'prompt', 'answer'];
const KNOWN_COLUMNS = new Set([...REQUIRED_COLUMNS, 'grade', ...CHOICE_COLUMNS, 'accepted', 'source']);

export const MAX_SUBJECT = 40;
export const MAX_PROMPT = 1000;
export const MAX_CHOICE = 200;

// Parse and validate CSV text. With `sample: true` ids must be negative (the bundled
// sample file); otherwise they must be positive.
// Returns { questions, errors, warnings }. Only use `questions` when `errors` is empty.
export function parseQuestions(text, { sample = false } = {}) {
  const errors = [];
  const warnings = [];
  const questions = [];

  let records;
  try {
    records = parseCsv(text);
  } catch (err) {
    return { questions, errors: [err.message], warnings };
  }
  if (records.length === 0) {
    return { questions, errors: ['the file is empty'], warnings };
  }

  const [head, ...rows] = records;
  const header = head.fields.map((name) => name.trim().toLowerCase());
  const columns = new Map();
  header.forEach((name, i) => {
    if (columns.has(name)) errors.push(`line ${head.line}: column "${name}" appears more than once`);
    else columns.set(name, i);
    if (name && !KNOWN_COLUMNS.has(name)) warnings.push(`ignoring unknown column "${name}"`);
  });
  for (const name of REQUIRED_COLUMNS) {
    if (!columns.has(name)) errors.push(`line ${head.line}: missing required column "${name}"`);
  }
  if (errors.length > 0) return { questions, errors, warnings };

  const idLines = new Map();

  for (const { line, fields } of rows) {
    const get = (name) => {
      const i = columns.get(name);
      return i === undefined ? '' : (fields[i] ?? '').trim();
    };
    const problems = [];
    const fail = (message) => problems.push(`line ${line}: ${message}`);

    if (fields.slice(header.length).some((value) => value.trim() !== '')) {
      fail(`has ${fields.length} values but the header only has ${header.length} columns`);
    }

    // id
    const idRaw = get('id');
    let id = null;
    if (idRaw === '') {
      fail('id is required');
    } else if (!(sample ? /^-[1-9]\d*$/ : /^[1-9]\d*$/).test(idRaw) || !Number.isSafeInteger(Number(idRaw))) {
      fail(
        sample
          ? `id "${idRaw}" must be a negative whole number (sample ids are negative)`
          : `id "${idRaw}" must be a positive whole number`,
      );
    } else if (idLines.has(Number(idRaw))) {
      fail(`id ${idRaw} is already used on line ${idLines.get(Number(idRaw))}`);
    } else {
      id = Number(idRaw);
      idLines.set(id, line);
    }

    // pack + grade
    const packKey = get('pack');
    const pack = PACKS.find((p) => p.key === packKey);
    if (packKey === '') fail('pack is required');
    else if (!pack) fail(`pack "${packKey}" is not one of: ${PACKS.map((p) => p.key).join(', ')}`);

    const gradeRaw = get('grade');
    let grade = null;
    if (pack?.graded) {
      if (gradeRaw === '') fail(`grade is required for pack "${pack.key}" (a whole number from 1 to 5)`);
      else if (!/^[1-5]$/.test(gradeRaw)) fail(`grade "${gradeRaw}" must be a whole number from 1 to 5`);
      else grade = Number(gradeRaw);
    } else if (pack && gradeRaw !== '') {
      fail(`pack "${pack.key}" has no grades, so grade must be empty`);
    }

    // subject / prompt
    const subject = get('subject');
    if (subject === '') fail('subject is required');
    else if (subject.length > MAX_SUBJECT) fail(`subject is longer than ${MAX_SUBJECT} characters`);

    const prompt = get('prompt');
    if (prompt === '') fail('prompt is required');
    else if (prompt.length > MAX_PROMPT) fail(`prompt is longer than ${MAX_PROMPT} characters`);

    // type, choices, answer, accepted
    const type = get('type').toLowerCase();
    const answerRaw = get('answer');
    const choiceValues = CHOICE_COLUMNS.map(get);
    let choices = null;
    let answer = answerRaw;
    let accepted = null;

    if (type !== 'choice' && type !== 'typed') {
      fail(`type "${get('type')}" must be "choice" or "typed"`);
    } else if (type === 'choice') {
      let filled = 0;
      while (filled < CHOICE_COLUMNS.length && choiceValues[filled] !== '') filled++;
      if (choiceValues.slice(filled).some((value) => value !== '')) {
        fail('choices must be filled in from choice_a onwards with no gaps');
      } else if (filled < 2) {
        fail('choice questions need at least 2 choices');
      } else {
        choices = choiceValues.slice(0, filled);
        choices.forEach((value, i) => {
          if (value.length > MAX_CHOICE) fail(`${CHOICE_COLUMNS[i]} is longer than ${MAX_CHOICE} characters`);
        });
        if (new Set(choices.map((value) => value.toLowerCase())).size !== choices.length) {
          fail('choices must all be different');
        }
        const letter = answerRaw.toUpperCase();
        if (answerRaw === '') fail('answer is required');
        else if (!LETTERS.includes(letter) || LETTERS.indexOf(letter) >= filled) {
          fail(`answer "${answerRaw}" is not one of the filled choices (A–${LETTERS[filled - 1]})`);
        } else {
          answer = letter;
        }
      }
      if (get('accepted') !== '') fail('accepted is only for typed questions');
    } else {
      if (choiceValues.some((value) => value !== '')) fail('typed questions must leave choice_a to choice_d empty');
      if (answerRaw === '') fail('answer is required');
      const extras = get('accepted')
        .split(';')
        .map((value) => value.trim())
        .filter((value) => value !== '');
      accepted = extras.length > 0 ? extras : null;
    }

    if (problems.length > 0) {
      errors.push(...problems);
      continue;
    }
    questions.push({
      id,
      pack: packKey,
      grade,
      subject,
      type,
      prompt,
      choices,
      answer,
      accepted,
      source: get('source') || null,
    });
  }

  if (errors.length === 0 && questions.length === 0) {
    errors.push('no questions found (the file only has a header row)');
  }
  return { questions, errors, warnings };
}

function toRow(q) {
  return {
    pack: q.pack,
    grade: q.grade,
    subject: q.subject,
    type: q.type,
    prompt: q.prompt,
    choices: q.choices ? JSON.stringify(q.choices) : null,
    answer: q.answer,
    accepted: q.accepted ? JSON.stringify(q.accepted) : null,
    source: q.source,
  };
}

const COMPARED_FIELDS = ['pack', 'grade', 'subject', 'type', 'prompt', 'choices', 'answer', 'accepted', 'source'];

// Upsert validated questions by id inside one transaction. Questions already in the
// database but missing from `questions` are set inactive, never deleted, because
// guesses reference them. Returns { added, updated, unchanged, deactivated }.
export function importQuestions(questions, { deactivateMissing = true } = {}) {
  const db = getDb();
  return transaction(() => {
    const existing = new Map(db.prepare('SELECT * FROM questions').all().map((row) => [row.id, row]));
    const insert = db.prepare(
      `INSERT INTO questions
         (id, pack, grade, subject, type, prompt, choices, answer, accepted, source, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    );
    const update = db.prepare(
      `UPDATE questions
          SET pack = ?, grade = ?, subject = ?, type = ?, prompt = ?, choices = ?,
              answer = ?, accepted = ?, source = ?, active = 1, updated_at = ?
        WHERE id = ?`,
    );
    const stamp = nowIso();
    const result = { added: 0, updated: 0, unchanged: 0, deactivated: 0 };
    const keep = new Set();

    for (const q of questions) {
      keep.add(q.id);
      const row = toRow(q);
      const values = COMPARED_FIELDS.map((field) => row[field]);
      const old = existing.get(q.id);
      if (!old) {
        insert.run(q.id, ...values, stamp);
        result.added++;
      } else if (!old.active || COMPARED_FIELDS.some((field) => old[field] !== row[field])) {
        update.run(...values, stamp, q.id);
        result.updated++;
      } else {
        result.unchanged++;
      }
    }

    if (deactivateMissing) {
      const deactivate = db.prepare('UPDATE questions SET active = 0, updated_at = ? WHERE id = ?');
      for (const old of existing.values()) {
        if (old.active && !keep.has(old.id)) {
          deactivate.run(stamp, old.id);
          result.deactivated++;
        }
      }
    }
    return result;
  });
}

// Active question counts per pack / grade / subject, for the import summary.
export function summarizeQuestions() {
  return getDb()
    .prepare(
      `SELECT pack, grade, subject, COUNT(*) AS count
         FROM questions
        WHERE active = 1
        GROUP BY pack, grade, subject
        ORDER BY pack, grade, subject`,
    )
    .all()
    .map((row) => ({ ...row }));
}

// Read, validate and (if clean) import a CSV file. Never throws on bad content: returns
// { ok: false, errors } instead. A missing file does throw.
export function importFile(path, options = {}) {
  const text = readFileSync(path, 'utf8');
  const { questions, errors, warnings } = parseQuestions(text, options);
  if (errors.length > 0) return { ok: false, errors, warnings };
  const result = importQuestions(questions, options);
  return { ok: true, errors, warnings, ...result, counts: summarizeQuestions() };
}

// Load the bundled placeholder questions. Used when the database has no active
// questions, so a fresh clone is playable. Never deactivates anything.
export function seedSampleQuestions() {
  const text = readFileSync(SAMPLE_CSV_PATH, 'utf8');
  const { questions, errors } = parseQuestions(text, { sample: true });
  if (errors.length > 0) throw new Error(`questions/sample.csv is invalid:\n${errors.join('\n')}`);
  return importQuestions(questions, { deactivateMissing: false });
}
