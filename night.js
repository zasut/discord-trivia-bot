// Trivia night (DESIGN.md "Trivia night"): a host runs a game for teams in one channel.
// flow.js sends every night button, select and modal here once /start setup is done.
//
//   sign-up   public message, players Join / Leave, the host presses Make teams
//   building  the host's private team builder (deal, shuffle, move a player, Start)
//   board     the public board; the picking team's answerer (or the host) picks a tile
//   question  every team's current answerer answers privately, at the same time
//   reveal    the answer and each team's result; the host presses Next / Play another board
//
// Same rules as solo.js (AGENTS.md "Sessions and timers"): acknowledge each interaction
// exactly once, change session state BEFORE the first `await`, and send / edit public
// messages by channel id.
//
// session.status: 'signup' -> 'building' -> 'board' -> 'question' -> 'reveal' -> 'board' ...
//                 -> 'ending' -> 'ended'      (building can go back to signup)
//
// session.night:
//   roster      Map userId -> display name (sign-up)
//   builder     { teamCount, teams: [[userId]], moving } while building
//   teams       [{ index, id, name, members (answer order), turn, score, assistUsed }]
//   teamOf      Map userId -> team index; names  Map userId -> display name (fixed at Start)
//   pickIndex   which team picks the next tile; boardNumber; tiles; usedIds; seq; asked
//   q           the question on screen (see showNewQuestion), or the last one
//   reveal      { cleared, canAnother } after a question, for the host's buttons

import { ButtonStyle, MessageFlags, escapeMarkdown } from 'discord.js';
import { LETTERS, checkTyped } from './answers.js';
import { boardComponents, buildBoard, isCleared, isClickable, tileLabel } from './board.js';
import {
  MAX_NIGHT_PLAYERS,
  MAX_TEAMS,
  MIN_TEAMS,
  NIGHT_IDLE_MS,
  PACKS,
  SIGNUP_IDLE_MS,
  TEAM_STYLES,
  TIMERS,
  cid,
} from './constants.js';
import { transaction } from './db.js';
import { deleteMessage, editMessage, sendMessage } from './messages.js';
import { pickQuestionForTile } from './questions.js';
import {
  addGamePlayer,
  createGame,
  createTeam,
  endGame,
  recordGuess,
  recordQuestionShown,
  setTeamResult,
  upsertPlayer,
} from './records.js';
import { shuffle } from './rng.js';
import { armTimer, clearTimer, deleteSession, findPublicSession, getSession } from './state.js';
import { answerOrder, currentAnswerer, dealTeams, nextPickIndex, teamLabel, winningTeams } from './teams.js';
import {
  answerModal,
  answerRow,
  button,
  correctAnswerText,
  displayName,
  mention,
  optionText,
  publicPayload,
  questionContent,
  row,
  selectRow,
} from './ui.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const TOO_LATE = '⏰ Too late.';

const logError = (label) => (err) => console.error(label, err);
const safely = (promise, label) => promise.catch(logError(label));

const packLabel = (key) => PACKS.find((pack) => pack.key === key)?.label ?? key;
const reply = (interaction, content) => interaction.reply({ flags: EPHEMERAL, content });

// Buttons only the host may press.
const HOST_ONLY = new Set([
  'makeTeams',
  'cancelNight',
  'teamCount',
  'shuffle',
  'moveStart',
  'movePlayer',
  'moveTo',
  'builderBack',
  'startNight',
  'next',
  'anotherBoard',
  'endNight',
]);

function newNightState() {
  return {
    roster: new Map(),
    builder: null,
    teams: [],
    teamOf: new Map(),
    names: new Map(),
    pickIndex: 0,
    boardNumber: 0,
    tiles: [],
    usedIds: new Set(),
    seq: 0,
    asked: 0,
    q: null,
    reveal: null,
  };
}

// --- rendering -------------------------------------------------------------------------

const scoreLine = (night) => night.teams.map((team) => `${teamLabel(team.index)} ${team.score}`).join(' · ');

// "🟥 **Red:** <@a>, <@b>" for each team of user ids.
const teamLines = (teams) =>
  teams.map((ids, i) => `${teamLabel(i).replace(/ (.*)$/, ' **$1**')}: ${ids.length > 0 ? ids.map(mention).join(', ') : '(empty)'}`);

function signupHeader(session) {
  const players = [...session.night.roster.keys()];
  return [
    `🎉 **Trivia night** · ${packLabel(session.pack)}`,
    `Host: ${mention(session.hostId)}`,
    '',
    players.length > 0
      ? `**Players (${players.length}):** ${players.map(mention).join(', ')}`
      : '**No players yet.** Press **Join** to play.',
  ];
}

function signupPayload(session) {
  const { sid } = session;
  const players = session.night.roster.size;
  return publicPayload(
    [...signupHeader(session), '', 'The host presses **Make teams** once everyone has joined.'].join('\n'),
    [
      row(
        button(cid.join(sid), 'Join', ButtonStyle.Success),
        button(cid.leave(sid), 'Leave', ButtonStyle.Secondary),
        button(cid.makeTeams(sid), 'Make teams', ButtonStyle.Primary, { disabled: players < MIN_TEAMS }),
        button(cid.cancelNight(sid), 'Cancel', ButtonStyle.Danger),
      ),
    ],
  );
}

const closedSignupPayload = (session) =>
  publicPayload([...signupHeader(session), '', '⏳ Sign-up is closed. The host is making teams.'].join('\n'));

function builderPayload(session) {
  const { sid } = session;
  const { builder, roster } = session.night;
  const players = roster.size;
  const lines = [`**Make teams** · ${players} players`, ...teamLines(builder.teams)];
  const components = [
    row(
      ...[2, 3, 4].map((count) =>
        button(cid.teamCount(sid, count), `${count} teams`, count === builder.teamCount ? ButtonStyle.Primary : ButtonStyle.Secondary, {
          disabled: count > players,
        }),
      ),
    ),
    row(
      button(cid.shuffle(sid), '🔀 Shuffle', ButtonStyle.Secondary),
      button(cid.moveStart(sid), 'Move a player', ButtonStyle.Secondary, { disabled: Boolean(builder.moving) }),
      button(cid.builderBack(sid), 'Back', ButtonStyle.Secondary),
      button(cid.startNight(sid), 'Start', ButtonStyle.Success, { disabled: builder.teams.some((ids) => ids.length === 0) }),
    ),
  ];

  const teamIndexOf = (userId) => builder.teams.findIndex((ids) => ids.includes(userId));
  if (builder.moving?.stage === 'player') {
    lines.push('', 'Pick the player to move.');
    components.push(
      selectRow(
        cid.movePlayer(sid),
        'Who do you want to move?',
        [...roster].map(([userId, name]) => ({
          label: name.slice(0, 100),
          value: userId,
          description: teamLabel(teamIndexOf(userId)),
        })),
      ),
    );
  } else if (builder.moving?.stage === 'team') {
    const { userId } = builder.moving;
    lines.push('', `Move **${escapeMarkdown(roster.get(userId))}** to which team?`);
    components.push(
      selectRow(
        cid.moveTo(sid, userId),
        'Pick a team',
        builder.teams
          .map((_, i) => ({ label: teamLabel(i), value: String(i) }))
          .filter((option) => Number(option.value) !== teamIndexOf(userId)),
      ),
    );
  }
  return { ...publicPayload(lines.join('\n'), components) };
}

function boardPayload(session) {
  const { night, sid } = session;
  const control = button(cid.endNight(sid), 'End night', ButtonStyle.Danger);
  const picker = currentAnswerer(night.teams[night.pickIndex]);
  return publicPayload(
    [
      `🎉 **Trivia night** · Board ${night.boardNumber} · Host ${mention(session.hostId)}`,
      scoreLine(night),
      `${teamLabel(night.pickIndex)} picks: ${mention(picker)}. Choose a tile ⬇️`,
    ].join('\n'),
    boardComponents(sid, night.tiles, control),
  );
}

// Who is answering for a team, e.g. "<@carol> (for <@alice>)" once Ask a teammate is used.
const answeringText = (slot) => mention(slot.answererId) + (slot.forId ? ` (for ${mention(slot.forId)})` : '');

function questionPayload(session) {
  const { night, sid } = session;
  const q = night.q;
  const status = night.teams.map((team) => {
    const slot = q.slots[team.index];
    return `${teamLabel(team.index)}: ${answeringText(slot)} ${slot.locked ? '🔒' : '⏳'}`;
  });
  return publicPayload(
    questionContent({
      label: tileLabel(night.tiles[q.tileIndex]),
      number: night.asked + 1,
      question: q.question,
      order: q.order,
      deadlineMs: q.deadlineMs,
      extraLines: ['', ...status],
    }),
    [
      answerRow(sid, { seq: q.seq, question: q.question, order: q.order }),
      row(button(cid.assist(sid, q.seq), '🙋 Ask a teammate', ButtonStyle.Secondary)),
    ],
  );
}

// The host's buttons under a result: Next, or Play another board after the last tile.
function hostButtons(session) {
  const { sid } = session;
  const { reveal } = session.night;
  const forward = reveal.cleared
    ? button(cid.anotherBoard(sid), 'Play another board', ButtonStyle.Primary, { disabled: !reveal.canAnother })
    : button(cid.next(sid), 'Next ▶', ButtonStyle.Primary);
  return [row(forward, button(cid.endNight(sid), 'End night', ButtonStyle.Danger))];
}

function teamResultLine(night, q, index) {
  const slot = q.slots[index];
  const who = answeringText(slot);
  if (slot.timedOut) return `${teamLabel(index)}: ${who} ⏰ no answer`;
  const said =
    q.question.type === 'typed'
      ? `"${escapeMarkdown(slot.given)}"`
      : optionText(q.question, q.order, LETTERS.indexOf(slot.given));
  return `${teamLabel(index)}: ${who} answered ${said} ${slot.correct ? '✅' : '❌'}`;
}

function revealPayload(session) {
  const { night } = session;
  const q = night.q;
  return publicPayload(
    [
      `**${tileLabel(night.tiles[q.tileIndex])}** · Question ${night.asked}`,
      '',
      q.question.prompt,
      '',
      `✅ The answer was **${correctAnswerText(q.question, q.order)}**.`,
      '',
      ...night.teams.map((team) => teamResultLine(night, q, team.index)),
      '',
      `**Scores:** ${scoreLine(night)}`,
    ].join('\n'),
    hostButtons(session),
  );
}

// Standings, best first (ties keep team order).
function standingsLines(night) {
  return [...night.teams]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((team) => `${teamLabel(team.index)}: **${team.score}** · ${team.members.map(mention).join(', ')}`);
}

function finalText(night, status, winners) {
  const title = {
    completed: '🏁 **Trivia night over!**',
    quit: '🏳️ **Trivia night ended** before any questions were asked.',
    abandoned: `⌛ **Trivia night abandoned.** Nobody did anything for ${NIGHT_IDLE_MS / 60_000} minutes.`,
  }[status];
  const lines = [title];
  if (status === 'completed') {
    if (winners.length === 0) lines.push('No team scored, so nobody wins.');
    else if (winners.length === 1) lines.push(`🏆 ${teamLabel(winners[0].index)} wins with **${winners[0].score}**!`);
    else lines.push(`🏆 It's a tie! ${winners.map((team) => teamLabel(team.index)).join(' and ')} share the win with **${winners[0].score}** each.`);
  }
  if (status !== 'quit') lines.push('', ...standingsLines(night));
  return lines.join('\n');
}

// --- sign-up ---------------------------------------------------------------------------

// Called from the format screen when the host picks Trivia night.
export async function openSignup(interaction, session) {
  const { sid } = session;
  const { client } = interaction;
  if (findPublicSession(session.channelId)) {
    await reply(interaction, 'A game is already running in this channel.');
    return;
  }
  if (!buildBoard(session.pack).ok) {
    deleteSession(sid);
    await interaction.update({
      content: "There aren't enough questions to run a trivia night. Import more questions and try again.",
      components: [],
    });
    return;
  }

  // Claim the channel before the first await.
  clearTimer(sid);
  session.format = 'night';
  session.public = true;
  session.status = 'signup';
  session.night = newNightState();

  await safely(interaction.update({ content: 'Sign-up posted in the channel 👇', components: [] }), 'setup update failed');
  let message;
  try {
    message = await sendMessage(client, session.channelId, signupPayload(session));
  } catch (err) {
    console.error('sign-up send failed', err);
    deleteSession(sid);
    await safely(
      interaction.followUp({ flags: EPHEMERAL, content: "I couldn't post in this channel. Check that I can send messages here." }),
      'followUp failed',
    );
    return;
  }
  if (getSession(sid) !== session) return;
  session.messageId = message.id;
  armSignupIdle(client, session);
}

function armSignupIdle(client, session) {
  const { sid } = session;
  armTimer(sid, () => onSignupIdle(client, sid).catch(logError('sign-up idle failed')), SIGNUP_IDLE_MS);
}

// Fired by the sign-up timer: nobody started the night.
export async function onSignupIdle(client, sid) {
  const session = getSession(sid);
  if (!session || session.format !== 'night' || !['signup', 'building'].includes(session.status)) return;
  const { channelId, messageId } = session;
  session.status = 'ended';
  deleteSession(sid);
  await editMessage(client, channelId, messageId, publicPayload('⌛ **Trivia night sign-up expired.**')).catch(
    logError('sign-up expiry edit failed'),
  );
}

// Update the public sign-up message from the button that was pressed. If Discord rejects the
// interaction, fall back to editing the message by id, so the roster never goes stale.
async function updateSignup(interaction, session) {
  try {
    await interaction.update(signupPayload(session));
  } catch (err) {
    console.error('sign-up update failed', err);
    await editMessage(interaction.client, session.channelId, session.messageId, signupPayload(session)).catch(
      logError('sign-up edit failed'),
    );
  }
}

async function onJoin(interaction, session) {
  const { night } = session;
  const userId = interaction.user.id;
  if (session.status !== 'signup') {
    await interaction.deferUpdate();
    return;
  }
  if (night.roster.has(userId)) {
    await reply(interaction, "You're already signed up.");
    return;
  }
  if (night.roster.size >= MAX_NIGHT_PLAYERS) {
    await reply(interaction, `The night is full (${MAX_NIGHT_PLAYERS} players).`);
    return;
  }
  night.roster.set(userId, displayName(interaction));
  armSignupIdle(interaction.client, session);
  await updateSignup(interaction, session);
}

async function onLeave(interaction, session) {
  const { night } = session;
  if (session.status !== 'signup') {
    await interaction.deferUpdate();
    return;
  }
  if (!night.roster.delete(interaction.user.id)) {
    await reply(interaction, "You're not signed up.");
    return;
  }
  armSignupIdle(interaction.client, session);
  await updateSignup(interaction, session);
}

async function onCancel(interaction, session) {
  if (session.status !== 'signup') {
    await interaction.deferUpdate();
    return;
  }
  session.status = 'ended';
  deleteSession(session.sid);
  await interaction.update({ content: 'Trivia night cancelled.', components: [] });
}

// --- team builder ------------------------------------------------------------------------

async function onMakeTeams(interaction, session) {
  const { night } = session;
  if (session.status !== 'signup') {
    await interaction.deferUpdate();
    return;
  }
  if (night.roster.size < MIN_TEAMS) {
    await reply(interaction, `You need at least ${MIN_TEAMS} players to make teams.`);
    return;
  }
  night.builder = { teamCount: MIN_TEAMS, teams: dealTeams([...night.roster.keys()], MIN_TEAMS), moving: null };
  session.status = 'building';
  armSignupIdle(interaction.client, session);
  // The builder is private to the host; the public message just says sign-up is closed.
  await safely(interaction.reply({ flags: EPHEMERAL, ...builderPayload(session) }), 'builder reply failed');
  await editMessage(interaction.client, session.channelId, session.messageId, closedSignupPayload(session)).catch(
    logError('sign-up close edit failed'),
  );
}

async function onTeamCount(interaction, session, parsed) {
  const { night } = session;
  const count = Number(parsed.args[0]);
  if (session.status !== 'building' || !(count >= MIN_TEAMS && count <= MAX_TEAMS) || count > night.roster.size) {
    await interaction.deferUpdate();
    return;
  }
  night.builder = { teamCount: count, teams: dealTeams([...night.roster.keys()], count), moving: null };
  armSignupIdle(interaction.client, session);
  await interaction.update(builderPayload(session));
}

async function onShuffle(interaction, session) {
  const { night } = session;
  if (session.status !== 'building') {
    await interaction.deferUpdate();
    return;
  }
  const { teamCount } = night.builder;
  night.builder = { teamCount, teams: dealTeams([...night.roster.keys()], teamCount), moving: null };
  armSignupIdle(interaction.client, session);
  await interaction.update(builderPayload(session));
}

async function onMoveStart(interaction, session) {
  if (session.status !== 'building') {
    await interaction.deferUpdate();
    return;
  }
  session.night.builder.moving = { stage: 'player' };
  await interaction.update(builderPayload(session));
}

async function onMovePlayer(interaction, session) {
  const { night } = session;
  const userId = interaction.values?.[0];
  if (session.status !== 'building' || !night.roster.has(userId)) {
    await interaction.deferUpdate();
    return;
  }
  night.builder.moving = { stage: 'team', userId };
  await interaction.update(builderPayload(session));
}

async function onMoveTo(interaction, session, parsed) {
  const { night } = session;
  const userId = parsed.args[0];
  const to = Number(interaction.values?.[0]);
  const { builder } = night;
  if (session.status !== 'building' || !night.roster.has(userId) || !(to >= 0 && to < builder.teams.length)) {
    await interaction.deferUpdate();
    return;
  }
  builder.teams.forEach((ids) => {
    const at = ids.indexOf(userId);
    if (at !== -1) ids.splice(at, 1);
  });
  builder.teams[to].push(userId);
  builder.moving = null;
  await interaction.update(builderPayload(session));
}

// Back to sign-up so more people can join.
async function onBuilderBack(interaction, session) {
  if (session.status !== 'building') {
    await interaction.deferUpdate();
    return;
  }
  session.night.builder = null;
  session.status = 'signup';
  armSignupIdle(interaction.client, session);
  await safely(interaction.update({ content: 'Sign-up is open again in the channel.', components: [] }), 'builder back failed');
  await editMessage(interaction.client, session.channelId, session.messageId, signupPayload(session)).catch(
    logError('sign-up reopen edit failed'),
  );
}

async function onStartNight(interaction, session) {
  const { sid, night } = session;
  const { client } = interaction;
  if (session.status !== 'building' || night.builder.teams.some((ids) => ids.length === 0)) {
    await interaction.deferUpdate();
    return;
  }
  // Check the first board can be built, and set up everything, before changing the session.
  const built = buildBoard(session.pack);
  if (!built.ok) {
    await reply(interaction, "There aren't enough questions to build a board. Import more questions and try again.");
    return;
  }

  const names = new Map(night.roster);
  const teams = night.builder.teams.map((ids, index) => ({
    index,
    id: null,
    name: TEAM_STYLES[index].name,
    members: answerOrder(ids, names), // fixed for the whole night
    turn: 0,
    score: 0,
    assistUsed: false,
  }));
  try {
    transaction(() => {
      for (const [userId, name] of names) upsertPlayer(userId, name);
      upsertPlayer(session.hostId, displayName(interaction));
      session.gameId = createGame({
        guildId: session.guildId,
        channelId: session.channelId,
        pack: session.pack,
        format: 'night',
        hostId: session.hostId,
      });
      for (const team of teams) {
        team.id = createTeam(session.gameId, team.name, team.index);
        team.members.forEach((userId, turnOrder) => addGamePlayer(session.gameId, userId, { teamId: team.id, turnOrder }));
      }
    });
  } catch (err) {
    console.error('creating the night failed', err);
    session.gameId = null;
    await reply(interaction, 'Something went wrong starting the night. Try Start again.');
    return;
  }

  clearTimer(sid);
  night.names = names;
  night.teams = teams;
  night.teamOf = new Map(teams.flatMap((team) => team.members.map((userId) => [userId, team.index])));
  night.builder = null;
  night.tiles = built.tiles;
  night.boardNumber = 1;
  night.pickIndex = 0;
  session.status = 'board';

  await safely(interaction.update({ content: 'Trivia night started!', components: [] }), 'start update failed');
  await editMessage(
    client,
    session.channelId,
    session.messageId,
    publicPayload(
      [
        `🎉 **Trivia night** · ${packLabel(session.pack)}`,
        `Host: ${mention(session.hostId)}`,
        '',
        ...teamLines(teams.map((team) => team.members)),
        '',
        'Within a team, players answer in alphabetical order.',
      ].join('\n'),
    ),
  ).catch(logError('team list edit failed'));
  await postBoard(client, session);
}

// --- the board ---------------------------------------------------------------------------

// The run can't continue (a message couldn't be posted): record it and free the channel.
function abortNight(session) {
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
    abortNight(session);
    return false;
  }
  if (getSession(sid) !== session || session.status !== 'board') return true;
  session.messageId = message.id;
  armNightIdle(client, session);
  return true;
}

function armNightIdle(client, session) {
  const { sid } = session;
  armTimer(sid, () => onNightIdle(client, sid).catch(logError('night idle failed')), NIGHT_IDLE_MS);
}

// Make `question` the question on screen for `tile`: record it and build `night.q`.
// Synchronous, and it only changes the night after the database write succeeded.
function showNewQuestion(session, tile, question, pickedBy) {
  const { night } = session;
  const gameQuestionId = recordQuestionShown({
    gameId: session.gameId,
    questionId: question.id,
    seq: night.seq,
    board: night.boardNumber,
    grade: tile.grade,
    subject: tile.subject,
    pickedBy,
  });
  night.usedIds.add(question.id);
  const shownAtMs = Date.now();
  night.q = {
    seq: night.seq++,
    gameQuestionId,
    tileIndex: tile.index,
    question,
    order: question.type === 'choice' ? shuffle(question.choices.map((_, i) => i)) : null,
    shownAtMs,
    deadlineMs: shownAtMs + TIMERS.night[question.type],
    closed: false, // true once the question has ended
    // One slot per team, in team order. `answererId` changes if the team asks a teammate.
    slots: night.teams.map((team) => ({
      answererId: currentAnswerer(team),
      forId: null,
      locked: false,
      given: null, // the original letter, or the typed text
      correct: false,
      timedOut: false,
    })),
  };
}

async function onTile(interaction, session, parsed) {
  const { sid, night } = session;
  const { client } = interaction;
  const tile = night.tiles[Number(parsed.args[0])];
  if (session.status !== 'board' || !isClickable(night.tiles, tile)) {
    await interaction.deferUpdate(); // stale or locked tile
    return;
  }
  const picker = currentAnswerer(night.teams[night.pickIndex]);
  const userId = interaction.user.id;
  if (userId !== picker && userId !== session.hostId) {
    await reply(interaction, `It's ${mention(picker)}'s (${teamLabel(night.pickIndex)}) pick.`);
    return;
  }

  clearTimer(sid);
  const question = pickQuestionForTile({
    pack: session.pack,
    grade: tile.grade,
    subject: tile.subject,
    excludeIds: [...night.usedIds],
  });

  if (!question) {
    // The bank changed under a running night (an import deactivated the tile's questions).
    tile.state = 'skipped';
    if (isCleared(night.tiles)) {
      night.reveal = { cleared: true, canAnother: buildBoard(session.pack, { excludeIds: [...night.usedIds] }).ok };
      session.status = 'reveal';
      armNightIdle(client, session);
      await interaction.update({
        ...publicPayload(`${boardPayload(session).content}\n\nThat was the last tile on the board.`, hostButtons(session)),
      });
      return;
    }
    armNightIdle(client, session);
    await interaction.update(boardPayload(session));
    return;
  }

  try {
    showNewQuestion(session, tile, question, userId);
  } catch (err) {
    // Nothing has changed yet, so the board is still good: let them try again.
    console.error('recording the question failed', err);
    armNightIdle(client, session);
    await reply(interaction, 'Something went wrong. Try that tile again.');
    return;
  }
  tile.state = 'played';
  session.status = 'question';
  const boardMessageId = session.messageId;

  await safely(interaction.deferUpdate(), 'deferUpdate failed');
  await postQuestion(client, session);
  // The board is replaced by the question, so it doesn't pile up in the channel.
  await deleteMessage(client, session.channelId, boardMessageId).catch(logError('board delete failed'));
}

// --- questions -------------------------------------------------------------------------

// The question on screen, if `seq` is it and it hasn't ended.
function openQuestion(session, seq) {
  const q = session.night?.q;
  return session.status === 'question' && q && q.seq === seq && !q.closed ? q : null;
}

function armQuestionTimer(client, session) {
  const { sid, night } = session;
  const { seq, deadlineMs } = night.q;
  armTimer(
    sid,
    () => onNightQuestionTimeout(client, sid, seq).catch(logError('question timeout failed')),
    Math.max(0, deadlineMs - Date.now()),
  );
}

async function postQuestion(client, session) {
  const { sid, night } = session;
  const q = night.q;
  let message;
  try {
    message = await sendMessage(client, session.channelId, questionPayload(session));
  } catch (err) {
    console.error('question send failed', err);
    abortNight(session);
    return false;
  }
  // If every team somehow answered while the message was in flight there is nothing to time.
  if (getSession(sid) === session && openQuestion(session, q.seq)) {
    session.messageId = message.id;
    armQuestionTimer(client, session);
  }
  return true;
}

// Redraw the question message (status lines, locks). Skips if the question has ended, so a
// slow redraw can never overwrite the reveal.
async function refreshQuestion(client, session) {
  if (getSession(session.sid) !== session || !openQuestion(session, session.night.q.seq)) return;
  await editMessage(client, session.channelId, session.messageId, questionPayload(session)).catch(
    logError('question refresh failed'),
  );
}

// Who may answer, for this click: a player on a team, whose team hasn't answered, and who
// is that team's answerer right now. Otherwise `message` says why not.
function checkAnswerer(session, q, userId) {
  const { night } = session;
  const index = night.teamOf.get(userId);
  if (index === undefined) return { message: "You're not playing in this game." };
  const slot = q.slots[index];
  if (slot.locked) return { message: 'Your team has already answered.' };
  if (slot.answererId !== userId) return { message: `It's ${mention(slot.answererId)}'s turn for ${teamLabel(index)}.` };
  return { team: night.teams[index], slot };
}

// Lock a team's answer in and record it. Synchronous: call it before the first `await`.
function lockSlot(session, q, team, slot, { given, correct, timedOut = false }) {
  slot.locked = true;
  slot.given = timedOut ? null : given;
  slot.correct = correct;
  slot.timedOut = timedOut;
  if (correct) team.score++;
  try {
    recordGuess({
      gameQuestionId: q.gameQuestionId,
      gameId: session.gameId,
      questionId: q.question.id,
      userId: slot.answererId,
      teamId: team.id,
      answer: timedOut ? null : String(given).slice(0, 200),
      correct,
      timedOut,
      assisted: slot.forId !== null,
      assignedUserId: slot.forId,
      responseMs: Date.now() - q.shownAtMs,
    });
  } catch (err) {
    // Losing one row is better than freezing the night.
    console.error('recording the guess failed', err);
  }
}

// If every team has locked in, end the question and do all its bookkeeping. Synchronous, so
// by the time anything is awaited the session is consistently in 'reveal'.
function closeIfDone(session, q) {
  if (!q.slots.every((slot) => slot.locked)) return false;
  q.closed = true;
  session.status = 'reveal';
  clearTimer(session.sid);

  const { night } = session;
  night.asked++;
  night.teams.forEach((team) => team.turn++); // every team's answer order moves on
  night.pickIndex = nextPickIndex(night.pickIndex, night.teams.length);
  const cleared = isCleared(night.tiles);
  night.reveal = {
    cleared,
    canAnother: cleared && buildBoard(session.pack, { excludeIds: [...night.usedIds] }).ok,
  };
  saveScores(session);
  return true;
}

async function onChoiceAnswer(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  const position = Number(parsed.args[1]);
  if (!q || q.question.type !== 'choice' || !Number.isInteger(position) || !(position in q.order)) {
    await interaction.deferUpdate(); // stale or duplicate click
    return;
  }
  const check = checkAnswerer(session, q, interaction.user.id);
  if (!check.team) {
    await reply(interaction, check.message);
    return;
  }
  const given = LETTERS[q.order[position]];
  lockSlot(session, q, check.team, check.slot, { given, correct: given === q.question.answer });
  const done = closeIfDone(session, q);
  await safely(
    interaction.reply({ flags: EPHEMERAL, content: `🔒 Locked in: ${optionText(q.question, q.order, q.order[position])}` }),
    'locked reply failed',
  );
  if (done) await revealQuestion(interaction.client, session);
  else await refreshQuestion(interaction.client, session);
}

async function onTypedOpen(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q || q.question.type !== 'typed') {
    await interaction.deferUpdate();
    return;
  }
  const check = checkAnswerer(session, q, interaction.user.id);
  if (!check.team) {
    await reply(interaction, check.message);
    return;
  }
  // showModal must be the first response, so everything above is synchronous.
  await interaction.showModal(answerModal(session.sid, q.seq));
}

async function onTypedSubmit(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q || q.question.type !== 'typed') {
    await reply(interaction, TOO_LATE);
    return;
  }
  const check = checkAnswerer(session, q, interaction.user.id);
  if (!check.team) {
    await reply(interaction, check.message);
    return;
  }
  const given = interaction.fields.getTextInputValue('answer').trim();
  lockSlot(session, q, check.team, check.slot, { given, correct: checkTyped(q.question, given) });
  const done = closeIfDone(session, q);
  await safely(
    interaction.reply({ flags: EPHEMERAL, content: `🔒 Locked in: "${escapeMarkdown(given)}"` }),
    'locked reply failed',
  );
  if (done) await revealQuestion(interaction.client, session);
  else await refreshQuestion(interaction.client, session);
}

// "Ask a teammate": the team's current answerer picks who answers this question instead.
async function onAssist(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q) {
    await interaction.deferUpdate();
    return;
  }
  const check = checkAnswerer(session, q, interaction.user.id);
  if (!check.team) {
    await reply(interaction, check.message);
    return;
  }
  const { team } = check;
  if (team.assistUsed) {
    await reply(interaction, 'Your team has already used Ask a teammate.');
    return;
  }
  const mates = team.members.filter((userId) => userId !== interaction.user.id);
  if (mates.length === 0) {
    await reply(interaction, "You're the only one on your team.");
    return;
  }
  await interaction.reply({
    flags: EPHEMERAL,
    content: 'Who should answer this one?',
    components: [
      selectRow(
        cid.assistPick(session.sid, q.seq),
        'Pick a teammate',
        mates.map((userId) => ({ label: session.night.names.get(userId).slice(0, 100), value: userId })),
      ),
    ],
  });
}

async function onAssistPick(interaction, session, parsed) {
  const q = openQuestion(session, Number(parsed.args[0]));
  if (!q) {
    await interaction.update({ content: TOO_LATE, components: [] });
    return;
  }
  const check = checkAnswerer(session, q, interaction.user.id);
  const chosen = interaction.values?.[0];
  if (!check.team || check.team.assistUsed || !check.team.members.includes(chosen) || chosen === interaction.user.id) {
    const why = !check.team
      ? check.message
      : check.team.assistUsed
        ? 'Your team has already used Ask a teammate.'
        : "That can't be done now.";
    await interaction.update({ content: why, components: [] });
    return;
  }
  check.team.assistUsed = true;
  check.slot.forId = interaction.user.id;
  check.slot.answererId = chosen;
  await safely(
    interaction.update({ content: `Asked ${mention(chosen)} to answer.`, components: [] }),
    'assist update failed',
  );
  await refreshQuestion(interaction.client, session);
}

// Fired by the question timer. Exported so tests can call it instead of waiting.
export async function onNightQuestionTimeout(client, sid, seq) {
  const session = getSession(sid);
  if (!session || session.format !== 'night') return;
  const q = openQuestion(session, seq);
  if (!q) return;
  for (const team of session.night.teams) {
    const slot = q.slots[team.index];
    if (!slot.locked) lockSlot(session, q, team, slot, { correct: false, timedOut: true });
  }
  closeIfDone(session, q);
  await revealQuestion(client, session);
}

// --- results ---------------------------------------------------------------------------

// Persist every team's running score. (Declared before use by closeIfDone's callers.)
function saveScores(session) {
  try {
    transaction(() => session.night.teams.forEach((team) => setTeamResult(team.id, { score: team.score, won: false })));
  } catch (err) {
    console.error('saving scores failed', err);
  }
}

// The question has ended (closeIfDone already did the bookkeeping): show the result with the
// host's buttons.
async function revealQuestion(client, session) {
  const { sid } = session;
  armNightIdle(client, session);

  const payload = revealPayload(session);
  try {
    await editMessage(client, session.channelId, session.messageId, payload);
  } catch (err) {
    // The question message is gone: post the result fresh so the host still gets buttons.
    console.error('reveal edit failed', err);
    try {
      const message = await sendMessage(client, session.channelId, payload);
      if (getSession(sid) === session) session.messageId = message.id;
    } catch (err2) {
      console.error('reveal send failed', err2);
    }
  }
}

async function onNext(interaction, session) {
  if (session.status !== 'reveal' || session.night.reveal.cleared) {
    await interaction.deferUpdate();
    return;
  }
  clearTimer(session.sid);
  session.status = 'board';
  await safely(interaction.update({ components: [] }), 'next update failed');
  await postBoard(interaction.client, session);
}

async function onAnotherBoard(interaction, session) {
  const { night } = session;
  if (session.status !== 'reveal' || !night.reveal.cleared) {
    await interaction.deferUpdate();
    return;
  }
  const built = buildBoard(session.pack, { excludeIds: [...night.usedIds] });
  if (!built.ok) {
    await reply(interaction, "There aren't enough unused questions left for another board.");
    return;
  }
  clearTimer(session.sid);
  night.tiles = built.tiles;
  night.boardNumber++;
  session.status = 'board';
  await safely(interaction.update({ components: [] }), 'another board update failed');
  await postBoard(interaction.client, session);
}

async function onEndNight(interaction, session) {
  const wasBoard = session.status === 'board';
  if (!wasBoard && session.status !== 'reveal') {
    await interaction.deferUpdate();
    return;
  }
  session.status = 'ending';
  clearTimer(session.sid);
  if (wasBoard) {
    await safely(interaction.deferUpdate(), 'deferUpdate failed');
    await finishNight(interaction.client, session, { deleteMessageId: session.messageId });
  } else {
    await safely(interaction.update({ components: [] }), 'end update failed');
    await finishNight(interaction.client, session);
  }
}

// Fired by the idle timer between questions: nobody has done anything for NIGHT_IDLE_MS.
export async function onNightIdle(client, sid) {
  const session = getSession(sid);
  if (!session || session.format !== 'night' || !['board', 'reveal'].includes(session.status)) return;
  const onBoard = session.status === 'board';
  session.status = 'ending';
  if (!onBoard) {
    await editMessage(client, session.channelId, session.messageId, { components: [] }).catch(logError('strip buttons failed'));
  }
  await finishNight(client, session, { status: 'abandoned', deleteMessageId: onBoard ? session.messageId : null });
}

// status: 'completed' | 'quit' | 'abandoned'. Without one, the night is 'completed' if any
// question was asked and 'quit' if not. Records the result, frees the channel straight away,
// then posts the standings.
async function finishNight(client, session, { status, deleteMessageId = null } = {}) {
  const { sid, channelId, night } = session;
  const final = status ?? (night.asked > 0 ? 'completed' : 'quit');
  clearTimer(sid);
  session.status = 'ended';
  const winners = final === 'completed' ? winningTeams(night.teams) : [];
  try {
    transaction(() => {
      for (const team of night.teams) {
        setTeamResult(team.id, { score: team.score, won: winners.includes(team) });
      }
      endGame(session.gameId, final);
    });
  } catch (err) {
    console.error('ending the night failed', err);
  }
  const text = finalText(night, final, winners);
  deleteSession(sid);
  if (deleteMessageId) {
    await deleteMessage(client, channelId, deleteMessageId).catch(logError('board delete failed'));
  }
  try {
    await sendMessage(client, channelId, publicPayload(text));
  } catch (err) {
    console.error('final standings send failed', err);
  }
}

// --- routing ---------------------------------------------------------------------------

export async function handleNight(interaction, parsed, session) {
  if (HOST_ONLY.has(parsed.kind) && interaction.user.id !== session.hostId) {
    await reply(interaction, 'Only the host can do that.');
    return;
  }

  switch (parsed.kind) {
    case 'join':
      return onJoin(interaction, session);
    case 'leave':
      return onLeave(interaction, session);
    case 'makeTeams':
      return onMakeTeams(interaction, session);
    case 'cancelNight':
      return onCancel(interaction, session);
    case 'teamCount':
      return onTeamCount(interaction, session, parsed);
    case 'shuffle':
      return onShuffle(interaction, session);
    case 'moveStart':
      return onMoveStart(interaction, session);
    case 'movePlayer':
      return onMovePlayer(interaction, session);
    case 'moveTo':
      return onMoveTo(interaction, session, parsed);
    case 'builderBack':
      return onBuilderBack(interaction, session);
    case 'startNight':
      return onStartNight(interaction, session);
    case 'tile':
      return onTile(interaction, session, parsed);
    case 'ans':
      return onChoiceAnswer(interaction, session, parsed);
    case 'typed':
      return onTypedOpen(interaction, session, parsed);
    case 'typedSubmit':
      return onTypedSubmit(interaction, session, parsed);
    case 'assist':
      return onAssist(interaction, session, parsed);
    case 'assistPick':
      return onAssistPick(interaction, session, parsed);
    case 'next':
      return onNext(interaction, session);
    case 'anotherBoard':
      return onAnotherBoard(interaction, session);
    case 'endNight':
      return onEndNight(interaction, session);
    default:
      console.error(`unhandled night component: ${interaction.customId}`);
      return interaction.deferUpdate();
  }
}
