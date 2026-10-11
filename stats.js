// Database reads for stats (DESIGN.md "Stats"). Every query here counts only "counted"
// guesses: everything except guesses made in Casual solo runs.

import { getDb } from './db.js';

// SQL fragment: the guess `g` belongs to game `gm`, which isn't a Casual solo run.
export const COUNTED = "NOT (gm.format = 'solo' AND gm.difficulty = 'casual')";

// Peek's data: counted guesses other games gave this question, leaving out timeouts (they
// aren't an answer) and the game being played.
const PEEK_FROM = `FROM guesses g
                   JOIN games gm ON gm.id = g.game_id
                  WHERE g.question_id = ? AND g.game_id != ? AND g.timed_out = 0 AND ${COUNTED}`;

export function peekCount(questionId, excludeGameId) {
  return getDb().prepare(`SELECT COUNT(*) AS n ${PEEK_FROM}`).get(questionId, excludeGameId).n;
}

// The stored answers themselves: original letters for choice questions, text for typed.
export function peekAnswers(questionId, excludeGameId) {
  return getDb()
    .prepare(`SELECT g.answer AS answer ${PEEK_FROM}`)
    .all(questionId, excludeGameId)
    .map((row) => row.answer);
}

// The most correct answers the player has given in a single Hard run (0 if none).
export function bestHardRun(userId) {
  const row = getDb()
    .prepare(
      `SELECT MAX(correct_count) AS best
         FROM (SELECT SUM(g.correct) AS correct_count
                 FROM guesses g
                 JOIN games gm ON gm.id = g.game_id
                WHERE g.user_id = ? AND gm.format = 'solo' AND gm.difficulty = 'hard'
                GROUP BY g.game_id)`,
    )
    .get(userId);
  return row.best ?? 0;
}
