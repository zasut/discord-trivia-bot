// Question loading + answer checking for the "Are You Smarter Than a Fifth Grader"
// mode. Keeps game data/logic out of app.js.
//
// The question bank is read with fs.readFileSync + JSON.parse (rather than an
// `import ... with { type: 'json' }` assertion) so this works across Node versions
// without depending on import-attribute support. Path is resolved relative to this
// module via import.meta.url.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const QUESTIONS_PATH = fileURLToPath(
  new URL('./questions/aystafg.json', import.meta.url),
);

const questions = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8'));

// Returns the full question array. Each entry: { id, prompt, answer } where
// answer is the lowercase string 'yes' or 'no'.
export function getQuestions() {
  return questions;
}

// One question by 0-based index, or undefined if out of range.
export function getQuestion(index) {
  return questions[index];
}

// Compare a submitted button value ('yes' | 'no') against the question's answer.
export function checkAnswer(question, value) {
  return question.answer === value;
}

// Total number of questions in the bank.
export const QUESTION_COUNT = getQuestions().length;
