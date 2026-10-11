// Load your question CSV into the database.
//
//   npm run import                      -> data/questions.csv
//   npm run import -- path/to/file.csv  -> any other file
//
// The whole file is checked first. If anything is wrong, every problem is listed with
// its line number and nothing is imported.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDb, closeDb } from '../db.js';
import { importFile, DEFAULT_QUESTIONS_PATH } from '../importer.js';

const path = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_QUESTIONS_PATH;

if (!existsSync(path)) {
  console.error(`No question file at ${path}`);
  console.error('Export your spreadsheet as CSV UTF-8 to that path, or pass a path: npm run import -- path/to/questions.csv');
  process.exit(1);
}

initDb();
const result = importFile(path);
closeDb();

result.warnings.forEach((warning) => console.warn(`warning: ${warning}`));

if (!result.ok) {
  result.errors.forEach((error) => console.error(error));
  console.error(`\n${result.errors.length} problem(s) found. Nothing was imported.`);
  process.exit(1);
}

console.log(`Imported ${path}`);
console.log(
  `  ${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged, ${result.deactivated} deactivated`,
);
console.log('\nActive questions:');
for (const { pack, grade, subject, count } of result.counts) {
  console.log(`  ${pack}${grade ? ` · grade ${grade}` : ''} · ${subject}: ${count}`);
}
