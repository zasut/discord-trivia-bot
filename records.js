// Database writes for games and guesses (DESIGN.md "Database"). Every function writes
// immediately, so a crash mid-game loses nothing already recorded. Reads for stats live
// in stats.js.
//
// Discord ids are always passed as strings (snowflakes don't fit in a JS number), and
// `undefined` is never bound to SQLite, so optional values are normalised to null here.

import { getDb, nowIso } from './db.js';

const orNull = (value) => (value === undefined ? null : value);
const flag = (value) => (value ? 1 : 0);

// Insert a player, or refresh the display name and last-seen time of an existing one.
export function upsertPlayer(userId, displayName) {
  const stamp = nowIso();
  getDb()
    .prepare(
      `INSERT INTO players (user_id, display_name, first_seen, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET display_name = excluded.display_name, last_seen = excluded.last_seen`,
    )
    .run(String(userId), displayName, stamp, stamp);
}

// Returns the new game's id.
export function createGame({ guildId, channelId, pack, format, difficulty, hostId }) {
  const result = getDb()
    .prepare(
      `INSERT INTO games (guild_id, channel_id, pack, format, difficulty, host_id, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', ?)`,
    )
    .run(orNull(guildId), channelId, pack, format, orNull(difficulty), hostId, nowIso());
  return Number(result.lastInsertRowid);
}

// status: 'completed' | 'failed' | 'quit' | 'abandoned'
export function endGame(gameId, status) {
  getDb().prepare('UPDATE games SET status = ?, ended_at = ? WHERE id = ?').run(status, nowIso(), gameId);
}

// Returns the new team's id.
export function createTeam(gameId, name, position) {
  const result = getDb()
    .prepare('INSERT INTO teams (game_id, name, position) VALUES (?, ?, ?)')
    .run(gameId, name, position);
  return Number(result.lastInsertRowid);
}

export function setTeamResult(teamId, { score, won }) {
  getDb().prepare('UPDATE teams SET score = ?, won = ? WHERE id = ?').run(score, flag(won), teamId);
}

// The player row must exist first (upsertPlayer). teamId / turnOrder are null for solo.
export function addGamePlayer(gameId, userId, { teamId = null, turnOrder = null } = {}) {
  getDb()
    .prepare('INSERT INTO game_players (game_id, user_id, team_id, turn_order) VALUES (?, ?, ?, ?)')
    .run(gameId, userId, teamId, turnOrder);
}

// Record that a question was shown. Returns the game_questions id that guesses and cheat
// uses attach to.
export function recordQuestionShown({ gameId, questionId, seq, board = 0, grade = null, subject = null, pickedBy = null }) {
  const result = getDb()
    .prepare(
      `INSERT INTO game_questions (game_id, question_id, seq, board, grade, subject, picked_by, shown_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(gameId, questionId, seq, board, orNull(grade), orNull(subject), orNull(pickedBy), nowIso());
  return Number(result.lastInsertRowid);
}

// A question replaced by the Swap cheat keeps its row but gets no guess.
export function markSwapped(gameQuestionId) {
  getDb().prepare('UPDATE game_questions SET swapped = 1 WHERE id = ?').run(gameQuestionId);
}

// One row per answer submitted. On a timeout pass `answer: null`, `timedOut: true` and
// no `responseMs`.
export function recordGuess({
  gameQuestionId,
  gameId,
  questionId,
  userId,
  teamId = null,
  answer = null,
  correct,
  timedOut = false,
  assisted = false,
  assignedUserId = null,
  responseMs = null,
}) {
  const result = getDb()
    .prepare(
      `INSERT INTO guesses
         (game_question_id, game_id, question_id, user_id, team_id, answer, correct, timed_out,
          assisted, assigned_user_id, response_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      gameQuestionId,
      gameId,
      questionId,
      userId,
      orNull(teamId),
      orNull(answer),
      flag(correct),
      flag(timedOut),
      flag(assisted),
      orNull(assignedUserId),
      timedOut ? null : orNull(responseMs),
      nowIso(),
    );
  return Number(result.lastInsertRowid);
}

// cheat: 'peek' | 'fifty' | 'swap' | 'extra_time'
export function recordCheatUse({ gameQuestionId, gameId, userId, cheat }) {
  getDb()
    .prepare('INSERT INTO cheat_uses (game_question_id, game_id, user_id, cheat, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(gameQuestionId, gameId, userId, cheat, nowIso());
}
