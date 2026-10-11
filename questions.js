// Question queries. (Reads only: the import in importer.js is the only writer.)

import { getDb } from './db.js';
import { pick } from './rng.js';

// A questions row with its JSON columns parsed.
function toQuestion(row) {
  return {
    id: row.id,
    pack: row.pack,
    grade: row.grade,
    subject: row.subject,
    type: row.type,
    prompt: row.prompt,
    choices: row.choices ? JSON.parse(row.choices) : null,
    answer: row.answer,
    accepted: row.accepted ? JSON.parse(row.accepted) : null,
    source: row.source,
  };
}

// `AND id NOT IN (?, ?, ...)` for a list of question ids, or nothing for an empty list.
function notIn(column, ids) {
  if (ids.length === 0) return { sql: '', params: [] };
  return { sql: ` AND ${column} NOT IN (${ids.map(() => '?').join(', ')})`, params: [...ids] };
}

export function countActiveQuestions() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM questions WHERE active = 1').get().n;
}

export function getQuestion(id) {
  const row = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? toQuestion(row) : undefined;
}

// Subjects at a grade that still have at least one unused active question, as
// [{ subject, count }] sorted by subject.
export function subjectsAvailable(pack, grade, excludeIds = []) {
  const exclude = notIn('id', excludeIds);
  return getDb()
    .prepare(
      `SELECT subject, COUNT(*) AS count
         FROM questions
        WHERE pack = ? AND grade IS ? AND active = 1${exclude.sql}
        GROUP BY subject
        ORDER BY subject`,
    )
    .all(pack, grade, ...exclude.params)
    .map((row) => ({ ...row }));
}

// Is there at least one unused active question for this tile? (Swap needs one.)
export function hasUnusedQuestion({ pack, grade, subject, excludeIds = [] }) {
  const exclude = notIn('id', excludeIds);
  return (
    getDb()
      .prepare(
        `SELECT 1 AS found FROM questions
          WHERE pack = ? AND grade IS ? AND subject = ? AND active = 1${exclude.sql} LIMIT 1`,
      )
      .get(pack, grade, subject, ...exclude.params) !== undefined
  );
}

// A random unused active question for a tile (pack + grade + subject), or undefined.
// With a `userId`, prefers the questions that player has guessed on the fewest times, so
// repeat players see fresh questions first.
export function pickQuestionForTile({ pack, grade, subject, excludeIds = [], userId = null }) {
  const exclude = notIn('q.id', excludeIds);
  const rows = getDb()
    .prepare(
      `SELECT q.*,
              (SELECT COUNT(*) FROM guesses g WHERE g.question_id = q.id AND g.user_id = ?) AS seen
         FROM questions q
        WHERE q.pack = ? AND q.grade IS ? AND q.subject = ? AND q.active = 1${exclude.sql}`,
    )
    .all(userId ?? '', pack, grade, subject, ...exclude.params);
  if (rows.length === 0) return undefined;
  const fewest = Math.min(...rows.map((row) => row.seen));
  return toQuestion(pick(rows.filter((row) => row.seen === fewest)));
}
