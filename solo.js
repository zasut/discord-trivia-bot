// Solo runs (DESIGN.md "Solo"): the public board, one question at a time, lives, and the
// end-of-run summary. flow.js routes every solo button / modal here once /start setup is
// done.
//
// Rules this file follows (AGENTS.md "Sessions and timers"):
//  - Acknowledge each interaction exactly once; slow work happens after.
//  - Change session state BEFORE the first `await`, so a double-click or a click racing a
//    timeout can't be processed twice.
//  - Every public message is sent / edited by channel id (messages.js), because timers
//    have no interaction to reply with.
//
// Session shape while a run is live (`session.run`):
//   tiles       the board, see board.js
//   usedIds     question ids already asked this run
//   seq         next game_questions.seq; custom_ids carry it so stale clicks are ignored
//   correct / misses / asked   the score
//   livesLeft   Infinity on Casual
//   cheatsLeft  Infinity on Casual, 0 on Hard; cheatsUsed counts them for the summary
//   q           the question currently on screen (see showNewQuestion), or the last one
//               answered
// session.status: 'board' -> 'question' -> 'between' -> 'board' ... -> 'ending' -> 'ended'

import { ButtonStyle, MessageFlags } from 'discord.js';
import { checkTyped, LETTERS } from './answers.js';
import { boardComponents, isCleared, isClickable, ordinal, tileLabel, buildBoard } from './board.js';
import { BOARD_IDLE_MS, DIFFICULTIES, PACKS, TIMERS, cid, timing } from './constants.js';
import { deleteMessage, editMessage, sendMessage } from './messages.js';
import { CHEATS, CHEAT_KINDS, cheatAvailability, peekText, pickStruck } from './cheats.js';
import { hasUnusedQuestion, pickQuestionForTile } from './questions.js';
import {
  addGamePlayer,
  createGame,
  endGame,
  markSwapped,
  recordCheatUse,
  recordGuess,
  recordQuestionShown,
  upsertPlayer,
} from './records.js';
import { shuffle } from './rng.js';
import { armTimer, clearTimer, deleteSession, findPublicSession, getSession } from './state.js';
import { bestHardRun, peekAnswers, peekCount } from './stats.js';
import {
  answerModal,
  answerRow,
  button,
  cheatRow,
  displayName,
  mention,
  publicPayload,
  questionContent,
  resultContent,
  resultLine,
} from './ui.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const TOO_LATE = '⏰ Too late.';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const logError = (label) => (err) => console.error(label, err);

// Once session state has changed, a failed acknowledgement (an expired interaction, a
// Discord hiccup) must not strand the game, so those calls are logged, not thrown.
const safely = (promise, label) => promise.catch(logError(label));

const packLabel = (key) => PACKS.find((pack) => pack.key === key)?.label ?? key;

// --- rendering -------------------------------------------------------------------------

function livesText(session) {
  const difficulty = DIFFICULTIES[session.difficulty];
  if (!Number.isFinite(difficulty.lives)) return '❤️ ∞';
  const left = Math.max(0, session.run.livesLeft);
  return '❤️'.repeat(left) + '🖤'.repeat(difficulty.lives - left);
}

function cheatsText(session) {
  const { cheatsLeft } = session.run;
  if (DIFFICULTIES[session.difficulty].cheats === 0) return null; // Hard has none to show
  return `🃏 ${Number.isFinite(cheatsLeft) ? cheatsLeft : '∞'}`;
}

function runHeader(session) {
  const difficulty = DIFFICULTIES[session.difficulty];
  const { run } = session;
  const status = [livesText(session), cheatsText(session), `Score ${run.correct}/${run.asked}`].filter(Boolean);
  return [
    `**${packLabel(session.pack)}** · ${mention(session.hostId)} · ${difficulty.label}`,
    status.join(' · '),
  ].join('\n');
}

function boardPayload(session) {
  const quit = button(cid.quit(session.sid), 'Quit', ButtonStyle.Secondary);
  return publicPayload(
    `${runHeader(session)}\nPick a tile ⬇️`,
    boardComponents(session.sid, session.run.tiles, quit),
  );
}

// Which cheats the player can use on the question on screen.
function availableCheats(session) {
  const q = session.run.q;
  return cheatAvailability({
    question: q.question,
    struck: q.struck,
    used: q.cheatsUsed,
    peekTotal: q.peekTotal,
    swapAvailable: q.swapAvailable,
  });
}

function questionPayload(session) {
  const { run } = session;
  const q = run.q;
  const components = [answerRow(session.sid, { seq: q.seq, question: q.question, order: q.order, struck: q.struck })];
  // The cheat row disappears once the run has no cheats left (always, on Hard).
  if (run.cheatsLeft > 0) components.push(cheatRow(session.sid, q.seq, availableCheats(session)));
  return publicPayload(
    questionContent({
      label: tileLabel(run.tiles[q.tileIndex]),
      number: run.asked + 1,
      question: q.question,
      order: q.order,
      struck: q.struck,
      deadlineMs: q.deadlineMs,
    }),
    components,
  );
}

function summaryText(session, status) {
  const { run } = session;
  const difficulty = DIFFICULTIES[session.difficulty];
  const title = {
    completed: '🏁 **Run complete!**',
    failed: '💀 **Run over!** You ran out of lives.',
    quit: '🏳️ **Run ended.**',
    abandoned: `⌛ **Run abandoned.** Nobody picked a tile for ${BOARD_IDLE_MS / 60_000} minutes.`,
  }[status];
  const parts = [`${mention(session.hostId)} · ${difficulty.label}`, `**${run.correct}/${run.asked}** correct`];
  if (run.misses > 0) parts.push(`${run.misses} ${run.misses === 1 ? 'miss' : 'misses'}`);
  if (run.cheatsUsed > 0) parts.push(`${run.cheatsUsed} ${run.cheatsUsed === 1 ? 'cheat' : 'cheats'} used`);
  const lines = [title, parts.join(' · ')];
  if (session.difficulty === 'hard') lines.push(`Best Hard run: **${bestHardRun(session.hostId)}** correct`);
  return lines.join('\n');
}

// --- starting a run --------------------------------------------------------------------

// Called from the difficulty screen. Builds the board, records the game, then posts the
// board in the channel.
export async function startSolo(interaction, session, difficultyKey) {
  const difficulty = DIFFICULTIES[difficultyKey];
  if (!difficulty) {
    await interaction.deferUpdate();
    return;
  }
  if (findPublicSession(session.channelId)) {
    await interaction.reply({ flags: EPHEMERAL, content: 'A game is already running in this channel.' });
    return;
  }
  const built = buildBoard(session.pack);
  if (!built.ok) {
    deleteSession(session.sid);
    await interaction.update({
      content:
        `There aren't enough questions to build a board: nothing for ${ordinal(built.missingGrade)} grade. ` +
        'Import more questions and try again.',
      components: [],
    });
    return;
  }

  // Claim the channel and create the game before the first await, so two people
  // finishing setup in the same channel at once can't both get a game.
  clearTimer(session.sid);
  session.format = 'solo';
  session.difficulty = difficulty.key;
  session.public = true;
  session.status = 'board';
  upsertPlayer(session.hostId, displayName(interaction));
  session.gameId = createGame({
    guildId: session.guildId,
    channelId: session.channelId,
    pack: session.pack,
    format: 'solo',
    difficulty: difficulty.key,
    hostId: session.hostId,
  });
  addGamePlayer(session.gameId, session.hostId);
  session.run = {
    tiles: built.tiles,
    usedIds: new Set(),
    seq: 0,
    correct: 0,
    misses: 0,
    asked: 0,
    livesLeft: difficulty.lives,
    cheatsLeft: difficulty.cheats, // Infinity on Casual, 0 on Hard
    cheatsUsed: 0,
    q: null,
  };

  await safely(interaction.update({ content: 'Game posted in the channel 👇', components: [] }), 'setup update failed');
  const posted = await postBoard(interaction.client, session);
  if (!posted) {
    await interaction
      .followUp({ flags: EPHEMERAL, content: "I couldn't post in this channel. Check that I can send messages here." })
      .catch(logError('followUp failed'));
  }
}

// The run can't continue (a message couldn't be posted): record it and free the channel.
function abortRun(session) {
  if (session.gameId) endGame(session.gameId, 'abandoned');
  deleteSession(session.sid);
}

async function postBoard(client, session) {
  const { sid } = session;
  let message;
  try {
    message = await sendMessage(client, session.channelId, boardPayload(session));
  } catch (err) {
    console.error('board send failed', err);
    abortRun(session);
    return false;
  }
  if (getSession(sid) !== session || session.status !== 'board') return true;
  session.messageId = message.id;
  armTimer(sid, () => onBoardIdle(client, sid).catch(logError('board idle failed')), BOARD_IDLE_MS);
  return true;
}

// --- questions -------------------------------------------------------------------------

// The question on screen, if `seq` is it and it is still unanswered.
function openQuestion(session, seq) {
  const q = session.run?.q;
  return session.status === 'question' && q && q.seq === seq && !q.answered ? q : null;
}

// The timer for the question on screen: it fires when the question's deadline passes.
function armQuestionTimer(client, session) {
  const { sid, run } = session;
  const { seq, deadlineMs } = run.q;
  armTimer(
    sid,
    () => onQuestionTimeout(client, sid, seq).catch(logError('question timeout failed')),
    Math.max(0, deadlineMs - Date.now()),
  );
}

async function postQuestion(client, session) {
  const { sid, run } = session;
  const q = run.q;
  let message;
  try {
    message = await sendMessage(client, session.channelId, questionPayload(session));
  } catch (err) {
    console.error('question send failed', err);
    abortRun(session);
    return false;
  }
  // The player may already have answered while the message was in flight. Then there is
  // nothing to track or time.
  if (getSession(sid) === session && openQuestion(session, q.seq)) {
    session.messageId = message.id;
    armQuestionTimer(client, session);
  }
  return true;
}

// Make `question` the question on screen for `tile`: record it and build `run.q`. Used for
// a picked tile and for Swap's replacement. Synchronous, and it only changes the run after
// the database write succeeded, so a failure leaves the run as it was.
function showNewQuestion(session, tile, question) {
  const { run } = session;
  const gameQuestionId = recordQuestionShown({
    gameId: session.gameId,
    questionId: question.id,
    seq: run.seq,
    grade: tile.grade,
    subject: tile.subject,
    pickedBy: session.hostId,
  });
  run.usedIds.add(question.id);
  const shownAtMs = Date.now();
  run.q = {
    seq: run.seq++,
    gameQuestionId,
    tileIndex: tile.index,
    question,
    order: question.type === 'choice' ? shuffle(question.choices.map((_, i) => i)) : null,
    struck: [], // positions 50/50 has eliminated
    shownAtMs,
    deadlineMs: shownAtMs + TIMERS.solo[question.type],
    answered: false,
    cheatsUsed: new Set(), // cheat kinds used on this question
    peekTotal: peekCount(question.id, session.gameId),
    swapAvailable: hasUnusedQuestion({
      pack: session.pack,
      grade: tile.grade,
      subject: tile.subject,
      excludeIds: [...run.usedIds],
    }),
  };
  return run.q;
}

async function onTile(interaction, session, parsed) {
  const { sid, run } = session;
  const { client } = interaction;
  const tile = run.tiles[Number(parsed.args[0])];
  if (session.status !== 'board' || !isClickable(run.tiles, tile)) {
    await interaction.deferUpdate(); // stale or locked tile
    return;
  }

  clearTimer(sid);
  const question = pickQuestionForTile({
    pack: session.pack,
    grade: tile.grade,
    subject: tile.subject,
    excludeIds: [...run.usedIds],
    userId: session.hostId,
  });

  if (!question) {
    // The bank changed under a running game (an import deactivated the tile's questions).
    tile.state = 'skipped';
    if (isCleared(run.tiles)) {
      session.status = 'ending';
      await interaction.deferUpdate();
      await finishRun(client, session, 'completed', { deleteMessageId: session.messageId });
      return;
    }
    armTimer(sid, () => onBoardIdle(client, sid).catch(logError('board idle failed')), BOARD_IDLE_MS);
    await interaction.update(boardPayload(session));
    return;
  }

  try {
    showNewQuestion(session, tile, question);
  } catch (err) {
    // Nothing has changed yet, so the board is still good: let them try again.
    console.error('recording the question failed', err);
    armTimer(sid, () => onBoardIdle(client, sid).catch(logError('board idle failed')), BOARD_IDLE_MS);
    await interaction.reply({ flags: EPHEMERAL, content: 'Something went wrong. Try that tile again.' });
    return;
  }
  session.status = 'question';
  const boardMessageId = session.messageId;

  await safely(interaction.deferUpdate(), 'deferUpdate failed');
  await postQuestion(client, session);
  // The board is replaced by the question, so it doesn't pile up in the channel.
  await deleteMessage(client, session.channelId, boardMessageId).catch(logError('board delete failed'));
}

// Record the outcome, update the score and tile, and return the payload that replaces the
// question message. Synchronous on purpose: call it before the first `await`.
function settle(session, { given = null, correct, timedOut = false }) {
  const { run } = session;
  const q = run.q;
  const tile = run.tiles[q.tileIndex];
  q.answered = true;
  try {
    recordGuess({
      gameQuestionId: q.gameQuestionId,
      gameId: session.gameId,
      questionId: q.question.id,
      userId: session.hostId,
      answer: timedOut ? null : String(given).slice(0, 200),
      correct,
      timedOut,
      responseMs: Date.now() - q.shownAtMs,
    });
  } catch (err) {
    // Losing one row is better than freezing the game.
    console.error('recording the guess failed', err);
  }
  run.asked++;
  if (correct) {
    run.correct++;
  } else {
    run.misses++;
    if (Number.isFinite(run.livesLeft)) run.livesLeft--;
  }
  tile.state = correct ? 'right' : 'wrong';
  session.status = 'between';
  return publicPayload(
    resultContent({
      label: tileLabel(tile),
      number: run.asked,
      question: q.question,
      line: resultLine({ question: q.question, order: q.order, given, correct, timedOut }),
    }),
  );
}

// Edit the question message the player pressed (a result, or a cheat's effect). If Discord
// rejects the interaction, fall back to editing the message by id.
async function updateMessage(interaction, session, payload) {
  try {
    await interaction.update(payload);
  } catch (err) {
    console.error('message update failed', err);
    await editMessage(interaction.client, session.channelId, session.messageId, payload).catch(
      logError('message edit failed'),
    );
  }
}

// After a result: end the run, or post the next board once the result has had a moment
// on screen.
async function afterQuestion(client, session) {
  const { sid, run } = session;
  let end = null;
  if (Number.isFinite(run.livesLeft) && run.livesLeft <= 0) end = 'failed';
  else if (isCleared(run.tiles)) end = 'completed';

  await sleep(timing.resultReadMs);
  if (getSession(sid) !== session) return;
  if (end) {
    await finishRun(client, session, end);
    return;
  }
  session.status = 'board';
  await postBoard(client, session);
}

async function onChoiceAnswer(interaction, session, parsed) {
  const seq = Number(parsed.args[0]);
  const position = Number(parsed.args[1]);
  const q = openQuestion(session, seq);
  if (!q || q.question.type !== 'choice' || !Number.isInteger(position) || !(position in q.order) || q.struck.includes(position)) {
    await interaction.deferUpdate(); // stale or duplicate click
    return;
  }
  clearTimer(session.sid);
  const given = LETTERS[q.order[position]];
  const payload = settle(session, { given, correct: given === q.question.answer });
  await updateMessage(interaction, session, payload);
  await afterQuestion(interaction.client, session);
}

async function onTypedSubmit(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q || q.question.type !== 'typed') {
    await interaction.reply({ flags: EPHEMERAL, content: TOO_LATE });
    return;
  }
  clearTimer(session.sid);
  const given = interaction.fields.getTextInputValue('answer').trim();
  const payload = settle(session, { given, correct: checkTyped(q.question, given) });
  await updateMessage(interaction, session, payload);
  await afterQuestion(interaction.client, session);
}

// --- cheats ----------------------------------------------------------------------------

async function onCheat(interaction, session, parsed) {
  const { run } = session;
  const { client } = interaction;
  const kind = parsed.args[1];
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q || !CHEAT_KINDS.includes(kind) || !(run.cheatsLeft > 0) || !availableCheats(session)[kind]) {
    await interaction.deferUpdate(); // stale, forged, or not available right now
    return;
  }

  // Swap is the only cheat that can fail, so it goes first: if no replacement can be
  // recorded nothing is spent.
  if (kind === 'swap') {
    const tile = run.tiles[q.tileIndex];
    const replacement = pickQuestionForTile({
      pack: session.pack,
      grade: tile.grade,
      subject: tile.subject,
      excludeIds: [...run.usedIds],
      userId: session.hostId,
    });
    if (!replacement) {
      await interaction.reply({ flags: EPHEMERAL, content: 'There is no other question for this tile.' });
      return;
    }
    try {
      showNewQuestion(session, tile, replacement);
    } catch (err) {
      console.error('recording the replacement question failed', err);
      await interaction.reply({ flags: EPHEMERAL, content: 'Something went wrong. Try the swap again.' });
      return;
    }
    try {
      markSwapped(q.gameQuestionId);
    } catch (err) {
      console.error('marking the swap failed', err);
    }
  } else {
    q.cheatsUsed.add(kind);
  }

  // The cheat is spent. It is recorded against the question it was used on, which for a
  // swap is the one that was swapped out.
  run.cheatsLeft--;
  run.cheatsUsed++;
  try {
    recordCheatUse({
      gameQuestionId: q.gameQuestionId,
      gameId: session.gameId,
      userId: session.hostId,
      cheat: CHEATS.find((cheat) => cheat.kind === kind).db,
    });
  } catch (err) {
    console.error('recording the cheat failed', err);
  }

  // `run.q` is the new question after a swap, and the same question otherwise.
  const current = run.q;
  if (kind === 'fifty') current.struck = pickStruck(current.question, current.order);
  if (kind === 'time') current.deadlineMs += TIMERS.solo[current.question.type];
  if (kind === 'swap' || kind === 'time') armQuestionTimer(client, session);

  if (kind === 'peek') {
    // Peek answers privately, so the question message is refreshed separately (its Peek
    // button is now used up).
    const answers = peekAnswers(q.question.id, session.gameId);
    const text = peekText({ question: q.question, order: q.order, answers });
    await safely(interaction.reply({ flags: EPHEMERAL, content: text }), 'peek reply failed');
    await editMessage(client, session.channelId, session.messageId, questionPayload(session)).catch(
      logError('peek refresh failed'),
    );
    return;
  }
  await updateMessage(interaction, session, questionPayload(session));
}

// Fired by the question timer. Exported so tests can call it instead of waiting.
export async function onQuestionTimeout(client, sid, seq) {
  const session = getSession(sid);
  if (!session || session.format !== 'solo' || !openQuestion(session, seq)) return;
  const payload = settle(session, { correct: false, timedOut: true });
  try {
    await editMessage(client, session.channelId, session.messageId, payload);
  } catch (err) {
    console.error('question timeout edit failed', err);
  }
  await afterQuestion(client, session);
}

// --- ending a run ----------------------------------------------------------------------

// status: 'completed' | 'failed' | 'quit' | 'abandoned'. Frees the channel straight away,
// then posts the summary as a fresh message.
async function finishRun(client, session, status, { deleteMessageId = null } = {}) {
  const { sid, channelId } = session;
  clearTimer(sid);
  session.status = 'ended';
  try {
    endGame(session.gameId, status);
  } catch (err) {
    console.error('ending the game failed', err);
  }
  const summary = summaryText(session, status);
  deleteSession(sid);
  if (deleteMessageId) {
    await deleteMessage(client, channelId, deleteMessageId).catch(logError('board delete failed'));
  }
  try {
    await sendMessage(client, channelId, publicPayload(summary));
  } catch (err) {
    console.error('summary send failed', err);
  }
}

async function onQuit(interaction, session) {
  if (session.status !== 'board') {
    await interaction.deferUpdate();
    return;
  }
  session.status = 'ending';
  clearTimer(session.sid);
  await safely(interaction.deferUpdate(), 'deferUpdate failed');
  await finishRun(interaction.client, session, 'quit', { deleteMessageId: session.messageId });
}

// Fired by the board idle timer.
export async function onBoardIdle(client, sid) {
  const session = getSession(sid);
  if (!session || session.format !== 'solo' || session.status !== 'board') return;
  session.status = 'ending';
  await finishRun(client, session, 'abandoned', { deleteMessageId: session.messageId });
}

// --- routing ---------------------------------------------------------------------------

// Only the player can press buttons in their game.
export async function handleSolo(interaction, parsed, session) {
  if (interaction.user.id !== session.hostId) {
    await interaction.reply({ flags: EPHEMERAL, content: `This is ${mention(session.hostId)}'s game.` });
    return;
  }

  switch (parsed.kind) {
    case 'tile':
      return onTile(interaction, session, parsed);
    case 'quit':
      return onQuit(interaction, session);
    case 'ans':
      return onChoiceAnswer(interaction, session, parsed);
    case 'typed': {
      // showModal must be the first response, so the checks above and here are synchronous.
      const q = openQuestion(session, Number(parsed.args[0]));
      if (!q || q.question.type !== 'typed') return interaction.deferUpdate();
      return interaction.showModal(answerModal(session.sid, q.seq));
    }
    case 'typedSubmit':
      return onTypedSubmit(interaction, session, parsed);
    case 'cheat':
      return onCheat(interaction, session, parsed);
    default:
      console.error(`unhandled solo component: ${interaction.customId}`);
      return interaction.deferUpdate();
  }
}
