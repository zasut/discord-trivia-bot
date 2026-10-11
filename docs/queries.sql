-- =====================================================================================
-- Trivia bot: example analysis queries for data/trivia.db
--
-- Open the database in DB Browser for SQLite (read-only is safest), go to "Execute SQL",
-- paste ONE query, and press Ctrl+Return. Every query only reads: nothing here changes data.
--
-- How the data is laid out (see DESIGN.md "Database" for the full schema):
--   questions      one row per question (the bank)
--   players        one row per Discord user
--   games          one row per solo run or trivia night
--   teams          trivia-night teams (name, score, won)
--   game_players   who was in which game / on which team
--   game_questions each time a question was asked in a game
--   guesses        EVERY answer given, including timeouts (timed_out = 1, answer NULL)
--   cheat_uses     every cheat used in a solo run
--
-- "Counted" guesses are all guesses except those from Casual solo runs. Stats and
-- leaderboards only use counted ones, and most queries below do too, through this
-- condition (it needs the games table aliased as gm):
--
--     NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
--
-- Leave that line out of a query to include Casual runs as well. For `guesses.answer`,
-- choice questions store the ORIGINAL letter A-D (not the shuffled position the player
-- saw), and typed questions store what was typed.
-- =====================================================================================


-- 1. What has been played? Games by format and difficulty, and how they ended.
SELECT format,
       COALESCE(difficulty, '-') AS difficulty,
       status,
       COUNT(*) AS games
FROM games
GROUP BY format, difficulty, status
ORDER BY format, difficulty, status;


-- 2. Everyone's overall numbers (counted guesses only).
SELECT p.display_name AS player,
       COUNT(*) AS answered,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct,
       ROUND(AVG(g.response_ms) / 1000.0, 1) AS avg_seconds
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN players p ON p.user_id = g.user_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY g.user_id
ORDER BY answered DESC;


-- 3. Average questions correct per solo run, per player and difficulty.
--    A run with no guesses isn't a run, so it doesn't appear.
SELECT p.display_name AS player,
       r.difficulty,
       COUNT(*) AS runs,
       ROUND(AVG(r.correct), 2) AS avg_correct,
       MAX(r.correct) AS best_run
FROM (
  SELECT g.user_id, gm.id AS game_id, gm.difficulty, SUM(g.correct) AS correct
  FROM guesses g
  JOIN games gm ON gm.id = g.game_id
  WHERE gm.format = 'solo' AND gm.difficulty IN ('standard', 'hard')
  GROUP BY gm.id
) r
JOIN players p ON p.user_id = r.user_id
GROUP BY r.user_id, r.difficulty
ORDER BY avg_correct DESC;


-- 4. The hardest questions: lowest % correct (at least 5 counted answers).
SELECT q.id,
       q.grade,
       q.subject,
       substr(q.prompt, 1, 60) AS prompt,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN questions q ON q.id = g.question_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY q.id
HAVING COUNT(*) >= 5
ORDER BY pct_correct ASC, answers DESC
LIMIT 20;


-- 5. The easiest questions: highest % correct (at least 5 counted answers). Questions
--    nearly everyone gets right may be too easy for their grade.
SELECT q.id,
       q.grade,
       q.subject,
       substr(q.prompt, 1, 60) AS prompt,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN questions q ON q.id = g.question_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY q.id
HAVING COUNT(*) >= 5
ORDER BY pct_correct DESC, answers DESC
LIMIT 20;


-- 6. What did people pick on ONE question? Change both 1s to the question id you want.
--    (Timeouts are left out: they're not an answer.)
SELECT g.answer AS picked,
       COUNT(*) AS times,
       ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM guesses WHERE question_id = 1 AND timed_out = 0), 1) AS pct
FROM guesses g
WHERE g.question_id = 1 AND g.timed_out = 0
GROUP BY g.answer
ORDER BY times DESC;


-- 7. Which wrong answers tempt people most? The most-picked wrong choice per question,
--    for multiple-choice questions. A distractor that gets picked more than the right
--    answer is worth a second look.
SELECT q.id,
       q.subject,
       substr(q.prompt, 1, 50) AS prompt,
       q.answer AS right_letter,
       g.answer AS wrong_letter,
       COUNT(*) AS times
FROM guesses g
JOIN questions q ON q.id = g.question_id
WHERE q.type = 'choice' AND g.correct = 0 AND g.timed_out = 0
GROUP BY q.id, g.answer
ORDER BY times DESC
LIMIT 20;


-- 8. Questions people run out of time on.
SELECT q.id,
       q.grade,
       q.subject,
       substr(q.prompt, 1, 60) AS prompt,
       SUM(g.timed_out) AS timeouts,
       COUNT(*) AS answers,
       ROUND(100.0 * SUM(g.timed_out) / COUNT(*), 1) AS pct_timed_out
FROM guesses g
JOIN questions q ON q.id = g.question_id
GROUP BY q.id
HAVING SUM(g.timed_out) > 0
ORDER BY pct_timed_out DESC, timeouts DESC
LIMIT 20;


-- 9. Accuracy by grade (counted guesses).
SELECT q.grade,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN questions q ON q.id = g.question_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY q.grade
ORDER BY q.grade;


-- 10. Accuracy by subject, within each grade (counted guesses).
SELECT q.grade,
       q.subject,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN questions q ON q.id = g.question_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY q.grade, q.subject
ORDER BY q.grade, pct_correct DESC;


-- 11. Each player's accuracy by grade, side by side (counted guesses; blank = never asked).
SELECT p.display_name AS player,
       ROUND(100.0 * SUM(CASE WHEN q.grade = 1 THEN g.correct END) / NULLIF(SUM(q.grade = 1), 0), 0) AS grade_1,
       ROUND(100.0 * SUM(CASE WHEN q.grade = 2 THEN g.correct END) / NULLIF(SUM(q.grade = 2), 0), 0) AS grade_2,
       ROUND(100.0 * SUM(CASE WHEN q.grade = 3 THEN g.correct END) / NULLIF(SUM(q.grade = 3), 0), 0) AS grade_3,
       ROUND(100.0 * SUM(CASE WHEN q.grade = 4 THEN g.correct END) / NULLIF(SUM(q.grade = 4), 0), 0) AS grade_4,
       ROUND(100.0 * SUM(CASE WHEN q.grade = 5 THEN g.correct END) / NULLIF(SUM(q.grade = 5), 0), 0) AS grade_5
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN players p ON p.user_id = g.user_id
JOIN questions q ON q.id = g.question_id
WHERE NOT (gm.format = 'solo' AND gm.difficulty = 'casual')
GROUP BY g.user_id
ORDER BY p.display_name;


-- 12. Average answer time in seconds, by question type and grade. Timeouts have no time,
--     so they're left out automatically.
SELECT q.type,
       q.grade,
       COUNT(*) AS answers,
       ROUND(AVG(g.response_ms) / 1000.0, 1) AS avg_seconds
FROM guesses g
JOIN questions q ON q.id = g.question_id
WHERE g.response_ms IS NOT NULL
GROUP BY q.type, q.grade
ORDER BY q.type, q.grade;


-- 13. Do right answers come faster than wrong ones?
SELECT CASE g.correct WHEN 1 THEN 'right' ELSE 'wrong' END AS result,
       COUNT(*) AS answers,
       ROUND(AVG(g.response_ms) / 1000.0, 1) AS avg_seconds
FROM guesses g
WHERE g.response_ms IS NOT NULL
GROUP BY g.correct;


-- 14. Every trivia night: its teams, scores, winners and members.
SELECT gm.id AS night,
       date(gm.started_at) AS day,
       gm.status,
       t.name AS team,
       t.score,
       t.won,
       (SELECT group_concat(p.display_name, ', ')
          FROM game_players gp
          JOIN players p ON p.user_id = gp.user_id
         WHERE gp.team_id = t.id) AS members
FROM games gm
JOIN teams t ON t.game_id = gm.id
WHERE gm.format = 'night'
ORDER BY gm.id, t.position;


-- 15. Team win rates across completed nights: does the team that picks first have an edge?
SELECT t.name AS team,
       t.position AS pick_order,
       COUNT(*) AS nights,
       SUM(t.won) AS wins,
       ROUND(100.0 * SUM(t.won) / COUNT(*), 1) AS win_pct,
       ROUND(AVG(t.score), 1) AS avg_score
FROM teams t
JOIN games gm ON gm.id = t.game_id
WHERE gm.format = 'night' AND gm.status = 'completed'
GROUP BY t.name, t.position
ORDER BY t.position;


-- 16. Ask a teammate: do helpers do better or worse than the people who would have answered?
SELECT CASE g.assisted WHEN 1 THEN 'teammate asked to help' ELSE 'answered for themselves' END AS how,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM guesses g
JOIN games gm ON gm.id = g.game_id
WHERE gm.format = 'night'
GROUP BY g.assisted;


-- 17. Each use of Ask a teammate: who asked, who answered, and whether it worked.
SELECT gm.id AS night,
       t.name AS team,
       asker.display_name AS asked_for_help,
       helper.display_name AS answered,
       g.correct,
       q.grade,
       q.subject
FROM guesses g
JOIN games gm ON gm.id = g.game_id
JOIN teams t ON t.id = g.team_id
JOIN players helper ON helper.user_id = g.user_id
JOIN players asker ON asker.user_id = g.assigned_user_id
JOIN questions q ON q.id = g.question_id
WHERE g.assisted = 1
ORDER BY gm.id, g.id;


-- 18. Cheats: how often each is used, by difficulty.
SELECT gm.difficulty,
       cu.cheat,
       COUNT(*) AS uses
FROM cheat_uses cu
JOIN games gm ON gm.id = cu.game_id
GROUP BY gm.difficulty, cu.cheat
ORDER BY gm.difficulty, uses DESC;


-- 19. Do cheats help? Accuracy on the question a cheat was used on. (Swap isn't here: the
--     swapped-out question gets no guess.)
SELECT cu.cheat,
       COUNT(*) AS answers,
       SUM(g.correct) AS correct,
       ROUND(100.0 * SUM(g.correct) / COUNT(*), 1) AS pct_correct
FROM cheat_uses cu
JOIN guesses g ON g.game_question_id = cu.game_question_id
WHERE cu.cheat IN ('peek', 'fifty', 'extra_time')
GROUP BY cu.cheat;


-- 20. Questions that are never getting asked: active questions with no guesses yet.
--     (Sample questions have negative ids and are left out.)
SELECT q.id,
       q.grade,
       q.subject,
       substr(q.prompt, 1, 70) AS prompt
FROM questions q
WHERE q.active = 1
  AND q.id > 0
  AND NOT EXISTS (SELECT 1 FROM guesses g WHERE g.question_id = q.id)
ORDER BY q.grade, q.subject, q.id;


-- 21. Activity by day: games started and answers given.
SELECT date(gm.started_at) AS day,
       COUNT(DISTINCT gm.id) AS games,
       COUNT(g.id) AS answers
FROM games gm
LEFT JOIN guesses g ON g.game_id = gm.id
GROUP BY date(gm.started_at)
ORDER BY day DESC;
