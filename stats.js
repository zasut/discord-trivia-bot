// Database reads for stats (DESIGN.md "Stats"). Every query here counts only "counted"
// guesses: everything except guesses made in Casual solo runs.

import { getDb } from './db.js';

// SQL fragment: the guess `g` belongs to game `gm`, which isn't a Casual solo run.
export const COUNTED = "NOT (gm.format = 'solo' AND gm.difficulty = 'casual')";

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
