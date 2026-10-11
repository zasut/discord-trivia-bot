// Database reads for stats, and the text of /stats (DESIGN.md "Stats").
//
// What counts: every guess is saved, but only "counted" ones feed stats: everything except
// guesses made in Casual solo runs. A timeout is a guess that was wrong. A solo "run" only
// counts if it got at least one guess.

import { escapeMarkdown } from 'discord.js';
import { GRADES } from './constants.js';
import { getDb } from './db.js';
import { ordinal } from './board.js';
import { clamp, mention } from './ui.js';

// SQL fragment: the guess `g` belongs to game `gm`, which isn't a Casual solo run.
export const COUNTED = "NOT (gm.format = 'solo' AND gm.difficulty = 'casual')";

const MAX_SUBJECTS = 10;

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

// --- /stats ------------------------------------------------------------------------------

const percent = (correct, answered) => (answered > 0 ? Math.round((100 * correct) / answered) : null);

// A player's stats from their counted guesses:
//   overall   { answered, correct, percent, avgMs }  (avgMs leaves timeouts out; null if none)
//   byGrade   [{ grade, answered, correct, percent }] for grades 1-5 (zeros if never asked)
//   bySubject the most-answered subjects, [{ subject, answered, correct, percent }]
//   solo      { standard, hard } each { runs, cleared, best }, and avgCorrectPerRun
//             (null with no runs)
// `hasData` is false when the player has no counted guesses at all.
export function getPlayerStats(userId) {
  const db = getDb();
  const counted = `FROM guesses g
                   JOIN games gm ON gm.id = g.game_id
                   JOIN questions q ON q.id = g.question_id
                  WHERE g.user_id = ? AND ${COUNTED}`;

  const total = db
    .prepare(
      `SELECT COUNT(*) AS answered, COALESCE(SUM(g.correct), 0) AS correct, AVG(g.response_ms) AS avgMs ${counted}`,
    )
    .get(userId);
  const overall = {
    answered: total.answered,
    correct: total.correct,
    percent: percent(total.correct, total.answered),
    avgMs: total.avgMs ?? null,
  };

  const gradeRows = new Map(
    db
      .prepare(
        `SELECT q.grade AS grade, COUNT(*) AS answered, SUM(g.correct) AS correct ${counted}
            AND q.grade IS NOT NULL GROUP BY q.grade`,
      )
      .all(userId)
      .map((row) => [row.grade, row]),
  );
  const byGrade = GRADES.map((grade) => {
    const row = gradeRows.get(grade);
    const answered = row?.answered ?? 0;
    const correct = row?.correct ?? 0;
    return { grade, answered, correct, percent: percent(correct, answered) };
  });

  const bySubject = db
    .prepare(
      `SELECT q.subject AS subject, COUNT(*) AS answered, SUM(g.correct) AS correct ${counted}
        GROUP BY q.subject ORDER BY answered DESC, q.subject ASC LIMIT ${MAX_SUBJECTS}`,
    )
    .all(userId)
    .map((row) => ({ ...row, percent: percent(row.correct, row.answered) }));

  // One row per counted solo run that got at least one guess.
  const runs = db
    .prepare(
      `SELECT gm.difficulty AS difficulty, gm.status AS status, SUM(g.correct) AS correct
         FROM guesses g
         JOIN games gm ON gm.id = g.game_id
        WHERE g.user_id = ? AND gm.format = 'solo' AND gm.difficulty IN ('standard', 'hard')
        GROUP BY gm.id`,
    )
    .all(userId);
  const summarize = (difficulty) => {
    const mine = runs.filter((run) => run.difficulty === difficulty);
    return {
      runs: mine.length,
      cleared: mine.filter((run) => run.status === 'completed').length,
      best: mine.reduce((best, run) => Math.max(best, run.correct), 0),
    };
  };

  return {
    hasData: overall.answered > 0,
    overall,
    byGrade,
    bySubject,
    solo: {
      standard: summarize('standard'),
      hard: summarize('hard'),
      avgCorrectPerRun: runs.length > 0 ? runs.reduce((sum, run) => sum + run.correct, 0) / runs.length : null,
    },
  };
}

// 1.5 -> "1.5", 2 -> "2"
const oneDecimal = (n) => String(Math.round(n * 10) / 10);

// The /stats text. Always under Discord's 2000-character limit.
export function formatStats(stats, userId) {
  const { overall, byGrade, bySubject, solo } = stats;
  const lines = [`📊 **Stats for ${mention(userId)}**`];

  const answered = [`${overall.answered} answered`, `${overall.correct} correct (${overall.percent}%)`];
  if (overall.avgMs !== null) answered.push(`avg ${oneDecimal(overall.avgMs / 1000)}s`);
  lines.push(`**Overall:** ${answered.join(' · ')}`);

  lines.push(
    `**By grade:** ${byGrade.map((g) => `${ordinal(g.grade)} ${g.percent === null ? '–' : `${g.percent}%`}`).join(' · ')}`,
  );
  if (bySubject.length > 0) {
    lines.push(
      `**By subject:** ${bySubject.map((s) => `${escapeMarkdown(s.subject)} ${s.percent}% (${s.answered})`).join(' · ')}`,
    );
  }

  if (solo.standard.runs > 0) {
    lines.push(
      `**Standard:** ${solo.standard.runs} ${solo.standard.runs === 1 ? 'run' : 'runs'} · ${solo.standard.cleared} cleared · best ${solo.standard.best} correct`,
    );
  }
  if (solo.hard.runs > 0) {
    lines.push(
      `**Hard:** ${solo.hard.runs} ${solo.hard.runs === 1 ? 'run' : 'runs'} · ${solo.hard.cleared} cleared · best run ${solo.hard.best} correct`,
    );
  }
  if (solo.avgCorrectPerRun !== null) {
    lines.push(`**Average correct per run:** ${oneDecimal(solo.avgCorrectPerRun)}`);
  }
  return clamp(lines.join('\n'));
}
