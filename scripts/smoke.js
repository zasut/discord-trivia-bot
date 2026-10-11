// End-to-end smoke test WITHOUT Discord.
//
//  - a fake client records every message the bot sends / edits / deletes (scripts/fakes.js)
//  - fake interactions are fed to flow.js:handleInteraction, each recording which reply
//    method (reply / update / deferUpdate / showModal) the flow used
//  - buttons are pressed by looking them up in the messages the bot actually rendered, so
//    the real custom_ids are exercised
//  - an in-memory database is checked after each game
//
// Run: node scripts/smoke.js   (npm test runs it after the unit tests)

import assert from 'node:assert/strict';
import { dropSetup, handleInteraction } from '../flow.js';
import { onBoardIdle, onQuestionTimeout } from '../solo.js';
import { TIMERS, cid, parseCustomId, timing } from '../constants.js';
import { closeDb, getDb, initDb } from '../db.js';
import { seedSampleQuestions } from '../importer.js';
import { setRng } from '../rng.js';
import { getSession, resetSessions } from '../state.js';
import { componentsOf, createFakeDiscord, makeUser, seededRng } from './fakes.js';
import { playSolo } from './testdata.js';

const CHANNEL = 'chan1';
const OTHER_CHANNEL = 'chan2';
const ann = makeUser('1001', 'Ann');
const ben = makeUser('1002', 'Ben');

timing.resultReadMs = 0; // don't wait between questions

let discord;
let stepNo = 0;

// --- harness ---------------------------------------------------------------------------

function freshWorld(seed = 7) {
  resetSessions();
  closeDb();
  initDb(':memory:');
  seedSampleQuestions();
  setRng(seededRng(seed));
  discord = createFakeDiscord();
  stepNo = 0;
}

// Handle one interaction and check which reply methods the flow used, in order.
async function send(label, interaction, ...expected) {
  stepNo += 1;
  await handleInteraction(interaction);
  const got = interaction.calls.map((c) => c.method);
  console.log(`  #${stepNo} ${label} -> ${got.join(', ') || '(no reply)'}`);
  assert.deepEqual(got, expected, `${label}: reply methods`);
  return interaction;
}

const press = (label, customId, user, ...expected) =>
  send(label, discord.button(customId, user, { channelId: CHANNEL }), ...expected);

const row = (sql, ...params) => ({ ...getDb().prepare(sql).get(...params) });
const rows = (sql, ...params) => getDb().prepare(sql).all(...params).map((r) => ({ ...r }));

const live = (channelId = CHANNEL) => discord.live(channelId);
const latest = (channelId = CHANNEL) => discord.latest(channelId);
const buttons = (message) => componentsOf(message);
const texts = (channelId = CHANNEL) => live(channelId).map((m) => m.content);

// /start -> pack -> confirm -> solo -> difficulty. Returns the session id.
async function startSolo(difficulty, user = ann, channelId = CHANNEL) {
  const start = await send('/start', discord.command('start', user, { channelId }), 'reply');
  const picker = start.calls[0].payload.components[0].components;
  const sid = parseCustomId(picker[0].custom_id).sid;
  const go = (label, customId, ...expected) =>
    send(label, discord.button(customId, user, { channelId }), ...(expected.length ? expected : ['update']));
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('confirm pack', cid.packOk(sid));
  await go('pick solo', cid.fmtSolo(sid));
  await go(`pick ${difficulty}`, cid.diff(sid, difficulty));
  return sid;
}

// Press the first playable tile on the current board. Returns the question now on screen.
async function pickTile(sid, user = ann, matcher = () => true) {
  const board = latest();
  const tile = buttons(board).find(
    (b) => parseCustomId(b.custom_id).kind === 'tile' && !b.disabled && matcher(b),
  );
  assert.ok(tile, 'a playable tile is on the board');
  await press(`tile "${tile.label}"`, tile.custom_id, user, 'deferUpdate');
  return getSession(sid).run.q;
}

// Answer the question on screen, rightly or wrongly. Choice questions press a button found
// in the rendered message; typed ones go through the modal.
async function answer(sid, { correct, user = ann }) {
  const q = getSession(sid).run.q;
  const message = latest();
  if (q.question.type === 'typed') {
    const open = buttons(message).find((b) => b.custom_id === cid.typed(sid, q.seq));
    assert.ok(open, 'the Answer button is on the question');
    await press('Answer (opens modal)', open.custom_id, user, 'showModal');
    const text = correct ? q.question.answer : 'definitely not it';
    await send(
      `modal "${text}"`,
      discord.modal(cid.typedSubmit(sid, q.seq), user, { text, channelId: CHANNEL, messageId: message.id }),
      'update',
    );
  } else {
    const correctPosition = q.order.indexOf('ABCD'.indexOf(q.question.answer));
    const position = correct ? correctPosition : (correctPosition + 1) % q.order.length;
    const target = buttons(message).find((b) => {
      const parsed = parseCustomId(b.custom_id);
      return parsed.kind === 'ans' && Number(parsed.args[1]) === position;
    });
    assert.ok(target, 'an answer button for that position exists');
    await press(`answer ${target.label} (${correct ? 'right' : 'wrong'})`, target.custom_id, user, 'update');
  }
}

// --- scenarios -------------------------------------------------------------------------

async function standardRun() {
  console.log('\n--- Standard run: typed modal, a miss, a timeout, a full board ---');
  freshWorld();
  // Leave only the typed question in grade 1 Math so a modal answer is guaranteed.
  getDb().prepare('UPDATE questions SET active = 0 WHERE id = -1').run();

  const sid = await startSolo('standard');
  const board = latest();
  assert.match(board.content, /Standard/);
  assert.match(board.content, /❤️❤️❤️/);
  const tiles = buttons(board).filter((b) => parseCustomId(b.custom_id).kind === 'tile');
  assert.equal(tiles.length, 10, '5 grades x 2 tiles');
  assert.deepEqual(
    tiles.map((b) => !b.disabled),
    [true, true, false, false, false, false, false, false, false, false],
    'only grade 1 is playable (climb rule)',
  );
  assert.ok(buttons(board).some((b) => b.custom_id === cid.quit(sid)), 'Quit is on the board');
  assert.equal(board.allowedMentions.parse.length, 0, 'the board pings nobody');
  assert.equal(getSession(sid).public, true);

  // Someone else can't touch Ann's game.
  const intruder = await send(
    "Ben presses Ann's tile",
    discord.button(tiles[0].custom_id, ben, { channelId: CHANNEL }),
    'reply',
  );
  assert.match(intruder.calls[0].payload.content, /This is <@1001>'s game/);

  // A locked (higher-grade) tile does nothing.
  const before = live().length;
  await press('locked grade-2 tile', tiles[2].custom_id, ann, 'deferUpdate');
  assert.equal(live().length, before, 'nothing was posted');

  // Question 1: grade 1 Math is the typed question. "  TWO. " must match via normalisation.
  const q1 = await pickTile(sid, ann, (b) => /Math/.test(b.label));
  assert.equal(q1.question.type, 'typed');
  assert.equal(discord.messages.get(board.id).deleted, true, 'the board was replaced by the question');
  const typedOpen = buttons(latest()).find((b) => b.custom_id === cid.typed(sid, q1.seq));
  assert.ok(typedOpen);
  const modalCall = await press('Answer', typedOpen.custom_id, ann, 'showModal');
  assert.equal(modalCall.calls[0].payload.custom_id, cid.typedSubmit(sid, q1.seq));
  const q1Message = latest();
  await send(
    'modal "  TWO. "',
    discord.modal(cid.typedSubmit(sid, q1.seq), ann, { text: '  TWO. ', channelId: CHANNEL, messageId: q1Message.id }),
    'update',
  );
  assert.match(q1Message.content, /✅ \*\*Correct!\*\*/);
  assert.equal(buttons(q1Message).length, 0, 'the result has no buttons');
  assert.match(latest().content, /Score 1\/1/, 'a fresh board follows with the score');

  // A stale click on the first question's old button does nothing.
  await send('stale click on Q1', discord.button(cid.typed(sid, q1.seq), ann, { channelId: CHANNEL }), 'deferUpdate');

  // Question 2: wrong answer = miss 1.
  await pickTile(sid);
  await answer(sid, { correct: false });
  assert.match(latest().content, /❤️❤️🖤/, 'one life lost');

  // Double-click: both clicks race, only one is processed.
  const q3 = await pickTile(sid);
  if (q3.question.type === 'choice') {
    const id = cid.ans(sid, q3.seq, q3.order.indexOf('ABCD'.indexOf(q3.question.answer)));
    const first = discord.button(id, ann, { channelId: CHANNEL });
    const second = discord.button(id, ann, { channelId: CHANNEL });
    await Promise.all([handleInteraction(first), handleInteraction(second)]);
    assert.deepEqual(first.calls.map((c) => c.method), ['update']);
    assert.deepEqual(second.calls.map((c) => c.method), ['deferUpdate'], 'the second click is ignored');
    console.log('  #- double-click: one update, one deferUpdate');
  } else {
    await answer(sid, { correct: true });
  }

  // Question 4: timeout = miss 2. A late click afterwards is ignored.
  const q4 = await pickTile(sid);
  await onQuestionTimeout(discord.client, sid, q4.seq);
  console.log('  #- question times out');
  assert.ok(texts().some((t) => /Time's up!/.test(t)), 'timeout result shown');
  assert.match(latest().content, /❤️🖤🖤/, 'two lives lost');
  await onQuestionTimeout(discord.client, sid, q4.seq); // timer firing twice changes nothing
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses WHERE game_question_id = ?', q4.gameQuestionId).n, 1);

  // Answer everything else correctly until the board is cleared.
  while (getSession(sid)) {
    await pickTile(sid);
    await answer(sid, { correct: true });
  }

  const summary = latest().content;
  assert.match(summary, /Run complete!/);
  assert.match(summary, /\*\*8\/10\*\* correct · 2 misses/);
  assert.equal(getSession(sid), undefined, 'the session is gone');

  // The game and every guess were recorded.
  const game = row('SELECT * FROM games');
  assert.equal(game.status, 'completed');
  assert.equal(game.format, 'solo');
  assert.equal(game.difficulty, 'standard');
  assert.equal(game.guild_id, 'guild1');
  assert.equal(game.host_id, '1001');
  assert.ok(game.ended_at);
  const guesses = rows('SELECT * FROM guesses ORDER BY id');
  assert.equal(guesses.length, 10);
  assert.equal(guesses.filter((g) => g.correct).length, 8);
  const timedOut = guesses.filter((g) => g.timed_out);
  assert.equal(timedOut.length, 1);
  assert.equal(timedOut[0].answer, null);
  assert.equal(timedOut[0].response_ms, null);
  assert.ok(guesses.filter((g) => !g.timed_out).every((g) => g.response_ms >= 0 && g.answer !== null));
  assert.equal(guesses[0].answer, '  TWO.'.trim(), 'the typed text is stored as typed');
  assert.equal(row('SELECT COUNT(*) AS n FROM game_questions').n, 10);
  assert.equal(rows('SELECT DISTINCT seq FROM game_questions').length, 10);
  assert.equal(row("SELECT display_name FROM players WHERE user_id = '1001'").display_name, 'Ann');
  assert.equal(row('SELECT COUNT(*) AS n FROM game_players').n, 1);

  // A button from the finished game gets the "expired" reply.
  const stale = await send('click after the game ended', discord.button(cid.quit(sid), ann, { channelId: CHANNEL }), 'reply');
  assert.match(stale.calls[0].payload.content, /expired/);

  // The channel is free again.
  await startSolo('casual');
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 2, 'a new game can start');
}

async function hardRun() {
  console.log('\n--- Hard run: the first miss ends it ---');
  freshWorld(11);
  const sid = await startSolo('hard');
  assert.match(latest().content, /❤️/);
  assert.ok(!/🖤/.test(latest().content));
  await pickTile(sid);
  await answer(sid, { correct: false });
  assert.equal(getSession(sid), undefined, 'the run is over');
  const summary = latest().content;
  assert.match(summary, /Run over!/);
  assert.match(summary, /Best Hard run: \*\*0\*\* correct/);
  assert.equal(row('SELECT status, difficulty FROM games').status, 'failed');
  assert.equal(row('SELECT difficulty FROM games').difficulty, 'hard');

  // A second Hard run that gets one right first reports the better best.
  const sid2 = await startSolo('hard');
  await pickTile(sid2);
  await answer(sid2, { correct: true });
  await pickTile(sid2);
  await answer(sid2, { correct: false });
  assert.match(latest().content, /Best Hard run: \*\*1\*\* correct/);
}

async function standardThirdMissEndsRun() {
  console.log('\n--- Standard: the third miss ends the run ---');
  freshWorld(3);
  const sid = await startSolo('standard');
  for (let i = 0; i < 3; i++) {
    await pickTile(sid);
    await answer(sid, { correct: false });
  }
  assert.equal(getSession(sid), undefined);
  assert.match(latest().content, /Run over!/);
  assert.match(latest().content, /\*\*0\/3\*\* correct · 3 misses/);
  assert.equal(row('SELECT status FROM games').status, 'failed');
}

async function casualRunAndQuit() {
  console.log('\n--- Casual: no life limit, Quit ---');
  freshWorld(5);
  const sid = await startSolo('casual');
  assert.match(latest().content, /❤️ ∞/);
  for (let i = 0; i < 4; i++) {
    await pickTile(sid);
    await answer(sid, { correct: false });
  }
  assert.ok(getSession(sid), 'still going after four misses');
  const board = latest();
  await press('Quit', cid.quit(sid), ann, 'deferUpdate');
  assert.equal(board.deleted, true, 'the board is removed on quit');
  assert.match(latest().content, /Run ended\./);
  assert.match(latest().content, /\*\*0\/4\*\* correct · 4 misses/);
  assert.equal(getSession(sid), undefined);
  const game = row('SELECT * FROM games');
  assert.equal(game.status, 'quit');
  assert.equal(game.difficulty, 'casual');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 4, 'casual guesses are still saved');
}

async function boardIdle() {
  console.log('\n--- Board idle: an untouched board is abandoned ---');
  freshWorld(2);
  const sid = await startSolo('standard');
  const board = latest();
  await onBoardIdle(discord.client, sid);
  console.log('  #- board idle timer fires');
  assert.equal(board.deleted, true);
  assert.match(latest().content, /Run abandoned\./);
  assert.equal(getSession(sid), undefined);
  assert.equal(row('SELECT status FROM games').status, 'abandoned');
  await onBoardIdle(discord.client, sid); // firing again is harmless
}

async function oneGamePerChannel() {
  console.log('\n--- One public game per channel ---');
  freshWorld(4);
  await startSolo('standard');
  // Ben tries to start a game in the same channel.
  const start = await send('Ben: /start', discord.command('start', ben, { channelId: CHANNEL }), 'reply');
  const sid = parseCustomId(start.calls[0].payload.components[0].components[0].custom_id).sid;
  const go = (label, customId) => send(label, discord.button(customId, ben, { channelId: CHANNEL }), 'update');
  await go('Ben: pick pack', cid.pack(sid, 'fifthgrader'));
  await go('Ben: confirm', cid.packOk(sid));
  await go('Ben: solo', cid.fmtSolo(sid));
  const blocked = await send('Ben: pick difficulty', discord.button(cid.diff(sid, 'hard'), ben, { channelId: CHANNEL }), 'reply');
  assert.match(blocked.calls[0].payload.content, /already running in this channel/);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 1, 'no second game was created');
  // ...but another channel is fine.
  await startSolo('hard', ben, OTHER_CHANNEL);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 2);
}

async function setupScreens() {
  console.log('\n--- Setup screens: Back buttons, unavailable pack, expiry ---');
  freshWorld(6);
  const start = await send('/start', discord.command('start', ann, { channelId: CHANNEL }), 'reply');
  const picker = start.calls[0].payload.components[0].components;
  const sid = parseCustomId(picker[0].custom_id).sid;
  assert.equal(start.calls[0].payload.flags, 64, 'the picker is ephemeral');
  assert.deepEqual(picker.map((b) => b.disabled), [false, true], 'Coming Soon is disabled');
  const go = (label, customId) => send(label, discord.button(customId, ann, { channelId: CHANNEL }), 'update');

  const unavailable = await go('pick the disabled pack', cid.pack(sid, 'trivia2'));
  assert.match(unavailable.calls[0].payload.content, /isn't available/);
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('back to the picker', cid.packBack(sid));
  await go('pick pack again', cid.pack(sid, 'fifthgrader'));
  const format = await go('confirm', cid.packOk(sid));
  const formatButtons = format.calls[0].payload.components[0].components;
  assert.equal(formatButtons.find((b) => b.custom_id === cid.fmtNight(sid)).disabled, true, 'trivia night is not available yet');
  await go('trivia night (disabled)', cid.fmtNight(sid));
  await go('solo', cid.fmtSolo(sid));
  const backToFormat = await go('back from difficulty', cid.diffBack(sid));
  assert.match(backToFormat.calls[0].payload.content, /Solo or trivia night/);
  await go('solo again', cid.fmtSolo(sid));
  await go('back to format', cid.diffBack(sid));
  await go('back to the pack screen', cid.fmtBack(sid));

  // An abandoned setup is forgotten when its timer fires, and its buttons then say so.
  dropSetup(sid);
  console.log('  #- setup timer fires');
  assert.equal(getSession(sid), undefined);
  const expired = await send('button on an expired setup', discord.button(cid.packOk(sid), ann, { channelId: CHANNEL }), 'reply');
  assert.match(expired.calls[0].payload.content, /expired/);
  const gone = await send('unknown button', discord.button('garbage', ann, { channelId: CHANNEL }), 'reply');
  assert.match(gone.calls[0].payload.content, /expired/);
  const ghost = await send('button with no session', discord.button(cid.packOk('0'.repeat(32)), ann, { channelId: CHANNEL }), 'reply');
  assert.match(ghost.calls[0].payload.content, /expired/);
  const late = await send('late modal', discord.modal(cid.typedSubmit('0'.repeat(32), 1), ann, { text: 'x', channelId: CHANNEL }), 'reply');
  assert.match(late.calls[0].payload.content, /Too late/);

  // /start in a DM has no server to play in.
  const dm = await send('/start with no guild', discord.command('start', ann, { channelId: 'dm', guildId: null }), 'reply');
  assert.match(dm.calls[0].payload.content, /server/);
}

async function notEnoughQuestions() {
  console.log('\n--- Not enough questions to build a board ---');
  freshWorld(8);
  getDb().prepare('UPDATE questions SET active = 0 WHERE grade = 3').run();
  const start = await send('/start', discord.command('start', ann, { channelId: CHANNEL }), 'reply');
  const sid = parseCustomId(start.calls[0].payload.components[0].components[0].custom_id).sid;
  const go = (label, customId, method = 'update') => send(label, discord.button(customId, ann, { channelId: CHANNEL }), method);
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('confirm', cid.packOk(sid));
  await go('solo', cid.fmtSolo(sid));
  const result = await go('standard', cid.diff(sid, 'standard'));
  assert.match(result.calls[0].payload.content, /nothing for 3rd grade/);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 0, 'no game was created');
  assert.equal(getSession(sid), undefined);
  assert.equal(live().length, 0, 'nothing was posted');
}

async function postingFails() {
  console.log("\n--- The bot can't post in the channel ---");
  freshWorld(9);
  discord.failures.send = true;
  const start = await send('/start', discord.command('start', ann, { channelId: CHANNEL }), 'reply');
  const sid = parseCustomId(start.calls[0].payload.components[0].components[0].custom_id).sid;
  const go = (label, customId, ...methods) =>
    send(label, discord.button(customId, ann, { channelId: CHANNEL }), ...(methods.length ? methods : ['update']));
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('confirm', cid.packOk(sid));
  await go('solo', cid.fmtSolo(sid));
  const result = await go('standard', cid.diff(sid, 'standard'), 'update', 'followUp');
  assert.match(result.calls[1].payload.content, /couldn't post/);
  assert.equal(getSession(sid), undefined, 'the session was dropped');
  assert.equal(row('SELECT status FROM games').status, 'abandoned');
  discord.failures.send = false;
  await startSolo('standard'); // the channel is free again
}

async function lateAnswers() {
  console.log('\n--- Late answers ---');
  freshWorld(10);
  getDb().prepare('UPDATE questions SET active = 0 WHERE id = -1').run();
  const sid = await startSolo('standard');
  const q = await pickTile(sid, ann, (b) => /Math/.test(b.label));
  assert.equal(q.question.type, 'typed');
  const questionMessage = latest();
  await onQuestionTimeout(discord.client, sid, q.seq);
  console.log('  #- question times out');
  // The player submits the modal after the time ran out.
  await send(
    'modal after timeout',
    discord.modal(cid.typedSubmit(sid, q.seq), ann, { text: '2', channelId: CHANNEL, messageId: questionMessage.id }),
    'reply',
  );
  // And presses Answer on the dead question.
  await send('Answer after timeout', discord.button(cid.typed(sid, q.seq), ann, { channelId: CHANNEL }), 'deferUpdate');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 1, 'only the timeout was recorded');
}

async function bankChangesMidGame() {
  console.log('\n--- An import changes the question bank while a game is running ---');
  freshWorld(12);
  const sid = await startSolo('standard');
  const playableTile = () =>
    buttons(latest()).find((b) => parseCustomId(b.custom_id).kind === 'tile' && !b.disabled);

  // Everything the first Animals tile could ask is switched off underneath the game.
  getDb().prepare("UPDATE questions SET active = 0 WHERE grade = 1 AND subject = 'Animals'").run();
  const animals = buttons(latest()).find((b) => b.label === '1st · Animals');
  const skipped = await press('tile with no questions left', animals.custom_id, ann, 'update');
  assert.match(skipped.calls[0].payload.components[0].components[0].label, /^➖ 1st · Animals/);
  assert.equal(getSession(sid).run.tiles[0].state, 'skipped');
  assert.equal(getSession(sid).status, 'board', 'the run carries on');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 0, 'a skipped tile costs nothing');
  assert.equal(row('SELECT COUNT(*) AS n FROM game_questions').n, 0);

  // Switch off the rest: every remaining tile is skipped, and the last one ends the run.
  getDb().prepare('UPDATE questions SET active = 0').run();
  for (let i = 2; i <= 9; i++) await press(`skip tile ${i}`, playableTile().custom_id, ann, 'update');
  await press('skip the last tile', playableTile().custom_id, ann, 'deferUpdate');
  assert.equal(getSession(sid), undefined);
  assert.match(latest().content, /Run complete!/);
  assert.match(latest().content, /\*\*0\/0\*\* correct/);
  assert.equal(row('SELECT status FROM games').status, 'completed');
}

async function failedAcknowledgements() {
  console.log('\n--- A failed acknowledgement must not strand a game ---');
  freshWorld(13);
  getDb().prepare('UPDATE questions SET active = 0 WHERE id = -1').run(); // grade 1 Math is typed
  const start = await send('/start', discord.command('start', ann, { channelId: CHANNEL }), 'reply');
  const sid = parseCustomId(start.calls[0].payload.components[0].components[0].custom_id).sid;
  const go = (label, customId) => send(label, discord.button(customId, ann, { channelId: CHANNEL }), 'update');
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('confirm', cid.packOk(sid));
  await go('solo', cid.fmtSolo(sid));

  // The ephemeral update fails, but the board is still posted.
  await send('standard (update fails)', discord.button(cid.diff(sid, 'standard'), ann, { channelId: CHANNEL, failOn: 'update' }));
  assert.equal(getSession(sid).status, 'board');
  assert.ok(buttons(latest()).some((b) => b.custom_id === cid.quit(sid)), 'the board was posted');

  // deferUpdate fails on a tile press, but the question is still posted.
  const math = buttons(latest()).find((b) => b.label === '1st · Math');
  await send('tile (deferUpdate fails)', discord.button(math.custom_id, ann, { channelId: CHANNEL, failOn: 'deferUpdate' }));
  const q = getSession(sid).run.q;
  assert.equal(getSession(sid).status, 'question');
  const questionMessage = latest();
  assert.ok(buttons(questionMessage).some((b) => b.custom_id === cid.typed(sid, q.seq)), 'the question was posted');

  // The modal's update fails: the result is edited in by message id and the next board arrives.
  await press('Answer', cid.typed(sid, q.seq), ann, 'showModal');
  await send(
    'modal (update fails)',
    discord.modal(cid.typedSubmit(sid, q.seq), ann, {
      text: q.question.answer,
      channelId: CHANNEL,
      messageId: questionMessage.id,
      failOn: 'update',
    }),
  );
  assert.match(questionMessage.content, /✅ \*\*Correct!\*\*/, 'the result was still shown');
  assert.equal(getSession(sid).status, 'board', 'and the game went on');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 1);

  // Quit's deferUpdate fails: the run still ends.
  await send('Quit (deferUpdate fails)', discord.button(cid.quit(sid), ann, { channelId: CHANNEL, failOn: 'deferUpdate' }));
  assert.equal(getSession(sid), undefined);
  assert.match(latest().content, /Run ended\./);
  assert.equal(row('SELECT status FROM games').status, 'quit');
}

// --- cheats ----------------------------------------------------------------------------

// Give every active question `count` earlier counted answers from other players, so Peek
// has something to show.
function seedHistory(count = 6) {
  for (const { id, type } of rows('SELECT id, type FROM questions WHERE active = 1')) {
    for (let i = 0; i < count; i++) {
      playSolo({
        userId: `hist${i}`,
        guesses: [{ questionId: id, answer: type === 'choice' ? 'ABC'[i % 3] : `guess${i % 2}`, correct: false }],
      });
    }
  }
}

const cheatButtons = () => buttons(latest()).filter((b) => parseCustomId(b.custom_id).kind === 'cheat');
const CHEAT_LABELS = ['👀 Peek', '✂️ 50/50', '🔄 Swap', '⏱️ Extra time'];

async function casualCheats() {
  console.log('\n--- Casual: every cheat ---');
  freshWorld(21);
  seedHistory();
  const sid = await startSolo('casual');
  assert.match(latest().content, /🃏 ∞/);

  const first = await pickTile(sid); // 1st · Animals: both questions are multiple choice
  assert.equal(first.question.type, 'choice');
  const message = latest();
  assert.deepEqual(cheatButtons().map((b) => b.label), CHEAT_LABELS);
  assert.ok(cheatButtons().every((b) => !b.disabled), 'everything is available at first');

  // 50/50 strikes wrong answers, never the right one, and can't be reused on the question.
  const fiftyId = cheatButtons()[1].custom_id;
  await press('50/50', fiftyId, ann, 'update');
  const q = getSession(sid).run.q;
  const correctPosition = q.order.indexOf('ABCD'.indexOf(q.question.answer));
  assert.equal(q.struck.length, q.question.choices.length - 2, 'two choices remain');
  assert.ok(!q.struck.includes(correctPosition), 'never strikes the right answer');
  assert.equal((message.content.match(/~~/g) ?? []).length, q.struck.length * 2, 'struck options are crossed out');
  const answerButtons = buttons(latest()).filter((b) => parseCustomId(b.custom_id).kind === 'ans');
  assert.deepEqual(answerButtons.map((b) => b.disabled), q.order.map((_, p) => q.struck.includes(p)));
  assert.equal(cheatButtons()[1].disabled, true, '50/50 is used up on this question');
  await press('50/50 again', fiftyId, ann, 'deferUpdate');
  assert.equal(row('SELECT COUNT(*) AS n FROM cheat_uses').n, 1);

  // Peek answers privately and refreshes the question message.
  const peek = await press('Peek', cheatButtons()[0].custom_id, ann, 'reply');
  assert.equal(peek.calls[0].payload.flags, 64, 'Peek is ephemeral');
  assert.match(peek.calls[0].payload.content, /^👀 \*\*Peek\*\*\nA \d+% · B \d+% · C \d+%( · D \d+%)? \(6 answers\)$/);
  assert.equal(cheatButtons()[0].disabled, true, 'the question message was refreshed');

  // Extra time adds one full base timer and shows the new deadline.
  const before = q.deadlineMs;
  await press('Extra time', cheatButtons()[3].custom_id, ann, 'update');
  assert.equal(q.deadlineMs, before + TIMERS.solo.choice);
  assert.ok(latest().content.includes(`<t:${Math.ceil(q.deadlineMs / 1000)}:R>`));
  assert.ok(getSession(sid).timer, 'the question timer was re-armed');

  // Swap replaces the question in the same message, with a fresh state.
  await press('Swap', cheatButtons()[2].custom_id, ann, 'update');
  const swapped = getSession(sid).run.q;
  assert.notEqual(swapped.question.id, q.question.id);
  assert.equal(swapped.seq, q.seq + 1);
  assert.equal(latest().id, message.id, 'the same message was edited');
  assert.ok(latest().content.includes(swapped.question.prompt));
  assert.deepEqual(swapped.struck, []);
  assert.equal(
    swapped.deadlineMs - swapped.shownAtMs,
    TIMERS.solo[swapped.question.type],
    'a fresh timer, without the extra time',
  );
  await send(
    'stale answer from the swapped-out question',
    discord.button(cid.ans(sid, q.seq, 0), ann, { channelId: CHANNEL }),
    'deferUpdate',
  );
  // Both Animals questions have now been used, so another Swap is impossible; the rest refresh.
  assert.deepEqual(
    cheatButtons().map((b) => b.disabled),
    [false, false, true, false],
    'cheats reset for the new question, but there is nothing left to swap to',
  );

  // Answer the new question; only it gets a guess.
  await answer(sid, { correct: true });
  assert.match(latest().content, /🃏 ∞/);
  assert.equal(row("SELECT COUNT(*) AS n FROM guesses WHERE user_id = '1001'").n, 1);
  const gameId = row("SELECT id FROM games WHERE host_id = '1001'").id;
  const asked = rows('SELECT id, seq, swapped FROM game_questions WHERE game_id = ? ORDER BY seq', gameId);
  assert.deepEqual(asked.map((g) => [g.seq, g.swapped]), [[0, 1], [1, 0]]);
  const uses = rows('SELECT cheat, game_question_id FROM cheat_uses ORDER BY id');
  assert.deepEqual(uses.map((u) => u.cheat), ['fifty', 'peek', 'extra_time', 'swap']);
  assert.ok(uses.every((u) => u.game_question_id === asked[0].id), 'recorded against the question they were used on');
  assert.equal(row("SELECT game_question_id FROM guesses WHERE user_id = '1001'").game_question_id, asked[1].id);

  await press('Quit', cid.quit(sid), ann, 'deferUpdate');
  assert.match(latest().content, /\*\*1\/1\*\* correct · 4 cheats used/);
}

async function standardCheat() {
  console.log('\n--- Standard: one cheat per run ---');
  freshWorld(22);
  seedHistory();
  const sid = await startSolo('standard');
  assert.match(latest().content, /🃏 1/);

  const q1 = await pickTile(sid);
  assert.equal(cheatButtons().length, 4);
  await press('Extra time', cheatButtons()[3].custom_id, ann, 'update');
  assert.equal(cheatButtons().length, 0, 'the cheat row is gone once the cheat is spent');
  assert.equal(
    buttons(latest()).filter((b) => parseCustomId(b.custom_id).kind === 'ans').length,
    q1.order.length,
    'the answer buttons stay',
  );
  await send('forged Peek', discord.button(cid.cheat(sid, q1.seq, 'peek'), ann, { channelId: CHANNEL }), 'deferUpdate');
  assert.equal(row('SELECT COUNT(*) AS n FROM cheat_uses').n, 1, 'no second cheat');

  await answer(sid, { correct: true });
  assert.match(latest().content, /🃏 0/);
  const q2 = await pickTile(sid);
  assert.equal(cheatButtons().length, 0, 'no cheat row on later questions either');
  await send('forged Swap', discord.button(cid.cheat(sid, q2.seq, 'swap'), ann, { channelId: CHANNEL }), 'deferUpdate');
  assert.equal(getSession(sid).run.q, q2, 'the question is unchanged');
  await answer(sid, { correct: true });

  await press('Quit', cid.quit(sid), ann, 'deferUpdate');
  assert.match(latest().content, /\*\*2\/2\*\* correct · 1 cheat used/);
}

async function hardHasNoCheats() {
  console.log('\n--- Hard: no cheats ---');
  freshWorld(23);
  seedHistory();
  const sid = await startSolo('hard');
  assert.ok(!/🃏/.test(latest().content), 'Hard does not show a cheat count');
  const q = await pickTile(sid);
  assert.equal(cheatButtons().length, 0);
  await send('forged 50/50', discord.button(cid.cheat(sid, q.seq, 'fifty'), ann, { channelId: CHANNEL }), 'deferUpdate');
  assert.deepEqual(getSession(sid).run.q.struck, []);
  assert.equal(row('SELECT COUNT(*) AS n FROM cheat_uses').n, 0);
}

async function cheatRules() {
  console.log('\n--- Cheat availability rules ---');
  freshWorld(24);
  // Grade 1 now has one typed Math question (-2) and one 3-choice Animals question (-3).
  getDb().prepare('UPDATE questions SET active = 0 WHERE id IN (-1, -4)').run();
  // Earlier answers to -3: 4 counted ones, plus 3 Casual and 2 timeouts that must not count.
  for (let i = 0; i < 4; i++) playSolo({ userId: `hist${i}`, guesses: [{ questionId: -3, answer: 'A' }] });
  for (let i = 4; i < 7; i++) playSolo({ userId: `hist${i}`, difficulty: 'casual', guesses: [{ questionId: -3, answer: 'A' }] });
  for (let i = 7; i < 9; i++) playSolo({ userId: `hist${i}`, guesses: [{ questionId: -3, timedOut: true }] });

  const sid = await startSolo('casual');
  const typed = await pickTile(sid, ann, (b) => /Math/.test(b.label));
  assert.equal(typed.question.id, -2);
  assert.deepEqual(
    cheatButtons().map((b) => b.disabled),
    [true, true, true, false],
    'typed question: no Peek data, no 50/50, nothing to swap to; Extra time always works',
  );
  await answer(sid, { correct: true });

  const animals = await pickTile(sid);
  assert.equal(animals.question.id, -3);
  assert.deepEqual(
    cheatButtons().map((b) => b.disabled),
    [true, false, true, false],
    'only 4 counted answers (Casual and timeouts are left out): no Peek yet. 50/50 works on 3 choices.',
  );
  await press('50/50', cheatButtons()[1].custom_id, ann, 'update');
  assert.equal(getSession(sid).run.q.struck.length, 1, 'one wrong choice struck from three');
  await answer(sid, { correct: true });
  await press('Quit', cid.quit(sid), ann, 'deferUpdate'); // Quit is on the board, not on a question

  // A fifth counted answer arrives, so a new game offers Peek.
  playSolo({ userId: 'hist9', guesses: [{ questionId: -3, answer: 'B' }] });
  const sid2 = await startSolo('casual');
  const again = await pickTile(sid2);
  assert.equal(again.question.id, -3);
  assert.equal(cheatButtons()[0].disabled, false, 'Peek is available at 5 counted answers');
  const peek = await press('Peek', cheatButtons()[0].custom_id, ann, 'reply');
  assert.match(peek.calls[0].payload.content, /\(5 answers\)/, 'Casual answers and timeouts are not in Peek');
}

// --- run -------------------------------------------------------------------------------

try {
  await standardRun();
  await hardRun();
  await standardThirdMissEndsRun();
  await casualRunAndQuit();
  await boardIdle();
  await oneGamePerChannel();
  await setupScreens();
  await notEnoughQuestions();
  await postingFails();
  await lateAnswers();
  await bankChangesMidGame();
  await failedAcknowledgements();
  await casualCheats();
  await standardCheat();
  await hardHasNoCheats();
  await cheatRules();
  console.log('\nsmoke: PASS');
  process.exit(0);
} catch (err) {
  console.error('\nsmoke: FAIL');
  console.error(err);
  process.exit(1);
}
