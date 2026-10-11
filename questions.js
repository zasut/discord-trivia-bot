// Question queries. (Reads only: the import in importer.js is the only writer.)

import { getDb } from './db.js';

export function countActiveQuestions() {
  return getDb().prepare('SELECT COUNT(*) AS n FROM questions WHERE active = 1').get().n;
}
