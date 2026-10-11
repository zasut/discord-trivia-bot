// Helpers for tests that need finished games in the database (stats, Peek history).
// Everything goes through records.js, exactly like a real game.

import { getQuestion } from '../questions.js';
import {
  addGamePlayer,
  createGame,
  createTeam,
  endGame,
  recordGuess,
  recordQuestionShown,
  setTeamResult,
  upsertPlayer,
} from '../records.js';

// Record that a question was asked in a game. Returns the game_questions id.
export function askQuestion(gameId, seq, { questionId, board = 0, pickedBy = null }) {
  const question = getQuestion(questionId);
  return recordQuestionShown({
    gameId,
    questionId,
    seq,
    board,
    grade: question.grade,
    subject: question.subject,
    pickedBy,
  });
}

// Record one guess on an asked question. `answer` is the original letter for choice
// questions, or the typed text; it is ignored on a timeout.
export function guessOn(
  gameQuestionId,
  { gameId, questionId, userId, teamId = null, answer = null, correct = false, timedOut = false, responseMs = 1000, assisted = false, assignedUserId = null },
) {
  upsertPlayer(userId, `User ${userId}`);
  return recordGuess({
    gameQuestionId,
    gameId,
    questionId,
    userId,
    teamId,
    answer: timedOut ? null : answer,
    correct,
    timedOut,
    assisted,
    assignedUserId,
    responseMs: timedOut ? null : responseMs,
  });
}

// Record a finished solo game for one player.
//   guesses: [{ questionId, answer, correct, timedOut, responseMs }]  asked in order
// Returns the game id.
export function playSolo({
  userId,
  name = `User ${userId}`,
  difficulty = 'standard',
  guildId = 'guild1',
  status = 'completed',
  guesses = [],
}) {
  upsertPlayer(userId, name);
  const gameId = createGame({
    guildId,
    channelId: 'chan1',
    pack: 'fifthgrader',
    format: 'solo',
    difficulty,
    hostId: userId,
  });
  addGamePlayer(gameId, userId);
  guesses.forEach((guess, seq) => {
    const gameQuestionId = askQuestion(gameId, seq, { questionId: guess.questionId, pickedBy: userId });
    guessOn(gameQuestionId, { gameId, userId, ...guess });
  });
  endGame(gameId, status);
  return gameId;
}

// Record a finished trivia night.
//   teams: [{ name, score, won, players: [userId, ...] }]  in team (tile-pick) order
//   questions: [{ questionId, board, pickedBy, guesses: [{ team, userId, answer, correct,
//                 timedOut, assisted, assignedUserId }] }]  in the order asked; `team` is an
//                 index into `teams`
// Returns { gameId, teamIds }.
export function playNight({ hostId, guildId = 'guild1', status = 'completed', teams = [], questions = [] }) {
  upsertPlayer(hostId, `User ${hostId}`);
  const gameId = createGame({ guildId, channelId: 'chan1', pack: 'fifthgrader', format: 'night', hostId });
  const teamIds = teams.map((team, position) => createTeam(gameId, team.name, position));
  teams.forEach((team, index) => {
    team.players.forEach((userId, turnOrder) => {
      upsertPlayer(userId, `User ${userId}`);
      addGamePlayer(gameId, userId, { teamId: teamIds[index], turnOrder });
    });
    setTeamResult(teamIds[index], { score: team.score ?? 0, won: team.won ?? false });
  });
  questions.forEach((asked, seq) => {
    const gameQuestionId = askQuestion(gameId, seq, asked);
    for (const guess of asked.guesses ?? []) {
      guessOn(gameQuestionId, { gameId, questionId: asked.questionId, ...guess, teamId: teamIds[guess.team] });
    }
  });
  endGame(gameId, status);
  return { gameId, teamIds };
}
