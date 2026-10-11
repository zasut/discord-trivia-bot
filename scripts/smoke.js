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
import { onNightIdle, onNightQuestionTimeout, onSignupIdle } from '../night.js';
import { onBoardIdle, onQuestionTimeout } from '../solo.js';
import { currentAnswerer } from '../teams.js';
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
const cat = makeUser('1003', 'Cat');
const dan = makeUser('1004', 'Dan');
const eve = makeUser('1005', 'Eve'); // never signs up
const hank = makeUser('2001', 'Hank'); // hosts the trivia nights
const usersById = new Map([ann, ben, cat, dan, eve, hank].map((user) => [user.id, user]));

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
  assert.deepEqual(formatButtons.map((b) => b.label), ['Solo', 'Trivia night', 'Back']);
  assert.ok(formatButtons.every((b) => !b.disabled));
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

// --- stats -----------------------------------------------------------------------------

async function statsCommand() {
  console.log('\n--- /stats ---');
  freshWorld(31);

  const none = await send('/stats with no games', discord.command('stats', ann, { channelId: CHANNEL }), 'reply');
  assert.equal(none.calls[0].payload.content, 'No games yet. Run `/start`!');
  assert.equal(none.calls[0].payload.flags, 64, 'private');

  // A short Standard run: one right, one wrong, then quit.
  const sid = await startSolo('standard');
  await pickTile(sid);
  await answer(sid, { correct: true });
  await pickTile(sid);
  await answer(sid, { correct: false });
  await press('Quit', cid.quit(sid), ann, 'deferUpdate');

  const mine = await send('/stats', discord.command('stats', ann, { channelId: CHANNEL }), 'reply');
  const text = mine.calls[0].payload.content;
  assert.equal(mine.calls[0].payload.flags, 64, 'private by default');
  assert.deepEqual(mine.calls[0].payload.allowedMentions, { parse: [] });
  assert.match(text, /^📊 \*\*Stats for <@1001>\*\*/);
  assert.match(text, /\*\*Overall:\*\* 2 answered · 1 correct \(50%\) · avg /);
  assert.match(text, /\*\*By grade:\*\* 1st 50% · 2nd – /);
  assert.match(text, /\*\*Standard:\*\* 1 run · 0 cleared · best 1 correct/);

  // A Casual run is saved but changes nothing.
  const casual = await startSolo('casual');
  await pickTile(casual);
  await answer(casual, { correct: true });
  await press('Quit', cid.quit(casual), ann, 'deferUpdate');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 3, 'the Casual guess was saved');
  const after = await send('/stats after a Casual run', discord.command('stats', ann, { channelId: CHANNEL }), 'reply');
  assert.match(after.calls[0].payload.content, /\*\*Overall:\*\* 2 answered · 1 correct \(50%\)/);

  // `share` makes it public.
  const shared = await send('/stats share:true', discord.command('stats', ann, { channelId: CHANNEL, options: { share: true } }), 'reply');
  assert.equal(shared.calls[0].payload.flags, undefined, 'a shared reply is public');

  // Looking at other people.
  const nobody = await send('/stats user:Ben (no games)', discord.command('stats', ann, { channelId: CHANNEL, options: { user: ben } }), 'reply');
  assert.equal(nobody.calls[0].payload.content, "<@1002> hasn't played yet.");
  const theirs = await send("Ben: /stats user:Ann", discord.command('stats', ben, { channelId: CHANNEL, options: { user: ann } }), 'reply');
  assert.match(theirs.calls[0].payload.content, /Stats for <@1001>/);
}

// --- trivia night ------------------------------------------------------------------------

const choose = (label, customId, user, values, ...expected) =>
  send(label, discord.select(customId, user, values, { channelId: CHANNEL }), ...expected);

const nightOf = (sid) => getSession(sid).night;

// /start -> pack -> confirm -> Trivia night. Returns the session id; the sign-up is posted.
async function openNightSignup(host = hank, channelId = CHANNEL) {
  const start = await send(`${host.displayName}: /start`, discord.command('start', host, { channelId }), 'reply');
  const sid = parseCustomId(start.calls[0].payload.components[0].components[0].custom_id).sid;
  const go = (label, customId) => send(label, discord.button(customId, host, { channelId }), 'update');
  await go('pick pack', cid.pack(sid, 'fifthgrader'));
  await go('confirm pack', cid.packOk(sid));
  await go('pick trivia night', cid.fmtNight(sid));
  return sid;
}

// With the team builder open, set the team count and move players until the teams are
// exactly `spec` (an array of arrays of users), using the real buttons and selects.
async function rearrange(sid, spec, host = hank) {
  if (nightOf(sid).builder.teamCount !== spec.length) {
    await press(`${spec.length} teams`, cid.teamCount(sid, spec.length), host, 'update');
  }
  for (let i = 0; i < spec.length; i++) {
    for (const user of spec[i]) {
      if (nightOf(sid).builder.teams[i].includes(user.id)) continue;
      await press('Move a player', cid.moveStart(sid), host, 'update');
      await choose(`move ${user.displayName}`, cid.movePlayer(sid), host, [user.id], 'update');
      await choose(`to team ${i + 1}`, cid.moveTo(sid, user.id), host, [String(i)], 'update');
    }
  }
  assert.deepEqual(
    nightOf(sid).builder.teams.map((ids) => [...ids].sort()),
    spec.map((users) => users.map((u) => u.id).sort()),
    'the teams are as arranged',
  );
}

// The host presses Make teams, then arranges them.
async function arrangeTeams(sid, spec, host = hank) {
  await press('Make teams', cid.makeTeams(sid), host, 'reply');
  await rearrange(sid, spec, host);
}

// Sign-up, teams, Start. Returns the session id with the first board posted.
async function startNight(spec, host = hank) {
  const sid = await openNightSignup(host);
  for (const user of spec.flat()) await press(`${user.displayName} joins`, cid.join(sid), user, 'update');
  await arrangeTeams(sid, spec, host);
  await press('Start', cid.startNight(sid), host, 'update');
  return sid;
}

// The tile-picking user presses the first playable tile (the picker, unless `user` is given).
async function pickNightTile(sid, user, matcher = () => true) {
  const night = nightOf(sid);
  const picker = user ?? usersById.get(currentAnswerer(night.teams[night.pickIndex]));
  const tile = buttons(latest()).find((b) => parseCustomId(b.custom_id).kind === 'tile' && !b.disabled && matcher(b));
  assert.ok(tile, 'a playable tile is on the board');
  await press(`${picker.displayName} picks "${tile.label}"`, tile.custom_id, picker, 'deferUpdate');
  return nightOf(sid).q;
}

// One player answers the question on screen, privately.
async function answerNight(sid, user, { correct }) {
  const q = nightOf(sid).q;
  const message = latest();
  if (q.question.type === 'typed') {
    await press(`${user.displayName}: Answer`, cid.typed(sid, q.seq), user, 'showModal');
    const text = correct ? q.question.answer : 'definitely not it';
    await send(
      `${user.displayName}: modal "${text}"`,
      discord.modal(cid.typedSubmit(sid, q.seq), user, { text, channelId: CHANNEL, messageId: message.id }),
      'reply',
    );
  } else {
    const rightPosition = q.order.indexOf('ABCD'.indexOf(q.question.answer));
    const position = correct ? rightPosition : (rightPosition + 1) % q.order.length;
    await press(`${user.displayName}: answer ${'ABCD'[position]}`, cid.ans(sid, q.seq, position), user, 'reply');
  }
}

// Every team's current answerer answers: `correct[teamIndex]` says rightly or wrongly.
async function everyoneAnswers(sid, correct) {
  const q = nightOf(sid).q;
  for (const team of nightOf(sid).teams) {
    await answerNight(sid, usersById.get(q.slots[team.index].answererId), { correct: correct[team.index] });
  }
}

// Play every tile left on the board: Red always right, Blue always wrong. The host presses
// Next between questions. Stops on the result of the last tile.
async function playBoardOut(sid) {
  const night = nightOf(sid);
  while (night.tiles.some((tile) => tile.state === 'open')) {
    await pickNightTile(sid);
    await everyoneAnswers(sid, [true, false]);
    if (night.tiles.some((tile) => tile.state === 'open')) await press('Next', cid.next(sid), hank, 'update');
  }
}

async function triviaNight() {
  console.log('\n--- Trivia night: sign-up, teams, two full boards ---');
  freshWorld(41);
  getDb().prepare('UPDATE questions SET active = 0 WHERE id = -1').run(); // grade 1 Math is typed

  // -- sign-up --
  const sid = await openNightSignup();
  assert.equal(getSession(sid).status, 'signup');
  assert.match(latest().content, /Trivia night/);
  assert.match(latest().content, /\*\*No players yet\.\*\*/);
  assert.deepEqual(buttons(latest()).map((b) => b.label), ['Join', 'Leave', 'Make teams', 'Cancel']);
  assert.equal(buttons(latest())[2].disabled, true, 'Make teams needs players');
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 0, 'nothing is recorded until Start');

  // The channel is taken, so nobody can start another game in it.
  const rival = await send('Ben: /start', discord.command('start', ben, { channelId: CHANNEL }), 'reply');
  const rivalSid = parseCustomId(rival.calls[0].payload.components[0].components[0].custom_id).sid;
  for (const [label, id] of [['pack', cid.pack(rivalSid, 'fifthgrader')], ['confirm', cid.packOk(rivalSid)], ['solo', cid.fmtSolo(rivalSid)]]) {
    await send(`Ben: ${label}`, discord.button(id, ben, { channelId: CHANNEL }), 'update');
  }
  const blocked = await send('Ben: pick Hard', discord.button(cid.diff(rivalSid, 'hard'), ben, { channelId: CHANNEL }), 'reply');
  assert.match(blocked.calls[0].payload.content, /already running in this channel/);

  await press('Ann joins', cid.join(sid), ann, 'update');
  assert.match(latest().content, /\*\*Players \(1\):\*\* <@1001>/);
  const again = await press('Ann joins again', cid.join(sid), ann, 'reply');
  assert.match(again.calls[0].payload.content, /already signed up/);
  await press('Ben joins', cid.join(sid), ben, 'update');
  await press('Cat joins', cid.join(sid), cat, 'update');
  await press('Dan joins', cid.join(sid), dan, 'update');
  await press('Dan leaves', cid.leave(sid), dan, 'update');
  assert.match(latest().content, /\*\*Players \(3\):\*\*/);
  const notIn = await press('Dan leaves again', cid.leave(sid), dan, 'reply');
  assert.match(notIn.calls[0].payload.content, /not signed up/);
  await press('Dan joins again', cid.join(sid), dan, 'update');
  assert.equal(buttons(latest())[2].disabled, false, 'Make teams is available with 2+ players');

  const notHost = await press('Eve presses Make teams', cid.makeTeams(sid), eve, 'reply');
  assert.equal(notHost.calls[0].payload.content, 'Only the host can do that.');
  assert.equal(getSession(sid).status, 'signup');

  // -- team builder --
  const builder = await press('Hank presses Make teams', cid.makeTeams(sid), hank, 'reply');
  assert.equal(builder.calls[0].payload.flags, 64, 'the builder is private');
  assert.match(builder.calls[0].payload.content, /\*\*Make teams\*\* · 4 players/);
  assert.match(latest().content, /Sign-up is closed/);
  assert.equal(buttons(latest()).length, 0, 'the public sign-up has no buttons while teams are made');
  await press('Ben presses Join on the closed sign-up', cid.join(sid), ben, 'deferUpdate');
  assert.equal(nightOf(sid).roster.size, 4);

  await press('4 teams', cid.teamCount(sid, 4), hank, 'update');
  assert.deepEqual(nightOf(sid).builder.teams.map((t) => t.length), [1, 1, 1, 1]);
  await press('3 teams', cid.teamCount(sid, 3), hank, 'update');
  assert.deepEqual(nightOf(sid).builder.teams.map((t) => t.length), [2, 1, 1]);
  const shuffled = await press('Shuffle', cid.shuffle(sid), hank, 'update');
  assert.equal(nightOf(sid).builder.teamCount, 3);
  assert.equal(shuffled.calls[0].payload.components[0].components.filter((b) => b.disabled).length, 0, 'all counts fit 4 players');

  // Back reopens sign-up, with its buttons.
  await press('Back', cid.builderBack(sid), hank, 'update');
  assert.equal(getSession(sid).status, 'signup');
  assert.deepEqual(buttons(latest()).map((b) => b.label), ['Join', 'Leave', 'Make teams', 'Cancel']);

  // Arrange Red = Ann + Cat, Blue = Ben + Dan, using Move a player.
  await arrangeTeams(sid, [[ann, cat], [ben, dan]]);
  const moving = await press('Move a player', cid.moveStart(sid), hank, 'update');
  assert.ok(moving.calls[0].payload.components.some((r) => r.components[0].type === 3), 'a player select is shown');
  await choose('pick Ann', cid.movePlayer(sid), hank, [ann.id], 'update');
  const target = await choose('move Ann to Blue', cid.moveTo(sid, ann.id), hank, ['1'], 'update');
  assert.deepEqual(nightOf(sid).builder.teams.map((t) => t.length), [1, 3]);
  // Moving the last person out of a team switches Start off.
  await press('Move a player', cid.moveStart(sid), hank, 'update');
  await choose('pick Cat', cid.movePlayer(sid), hank, [cat.id], 'update');
  const empty = await choose('move Cat to Blue', cid.moveTo(sid, cat.id), hank, ['1'], 'update');
  assert.deepEqual(nightOf(sid).builder.teams.map((t) => t.length), [0, 4]);
  const startButton = (payload) => payload.components[1].components.find((b) => b.custom_id === cid.startNight(sid));
  assert.equal(startButton(empty.calls[0].payload).disabled, true, 'Start needs every team to have a player');
  assert.equal(startButton(target.calls[0].payload).disabled, false);
  await press('Start with an empty team (forged)', cid.startNight(sid), hank, 'deferUpdate');
  assert.equal(getSession(sid).status, 'building');
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 0);
  await rearrange(sid, [[ann, cat], [ben, dan]]); // put everyone back

  // -- Start --
  const started = await press('Start', cid.startNight(sid), hank, 'update');
  assert.match(started.calls[0].payload.content, /Trivia night started/);
  const night = nightOf(sid);
  assert.equal(getSession(sid).status, 'board');
  assert.deepEqual(night.teams.map((t) => t.members), [[ann.id, cat.id], [ben.id, dan.id]], 'answer order is alphabetical');
  const game = row('SELECT * FROM games');
  assert.deepEqual([game.format, game.status, game.host_id, game.difficulty], ['night', 'in_progress', '2001', null]);
  assert.deepEqual(rows('SELECT name, position FROM teams ORDER BY position').map((t) => `${t.name}${t.position}`), ['Red0', 'Blue1']);
  assert.deepEqual(
    rows('SELECT user_id, turn_order FROM game_players gp JOIN teams t ON t.id = gp.team_id ORDER BY t.position, gp.turn_order').map((p) => `${p.user_id}:${p.turn_order}`),
    ['1001:0', '1003:1', '1002:0', '1004:1'],
  );
  const signup = [...discord.messages.values()].find((m) => /Within a team/.test(m.content ?? ''));
  assert.ok(signup && !signup.deleted && buttons(signup).length === 0, 'the sign-up message now lists the teams, with no buttons');
  assert.match(signup.content, /🟥 \*\*Red\*\*: <@1001>, <@1003>/);
  assert.match(signup.content, /🟦 \*\*Blue\*\*: <@1002>, <@1004>/);
  assert.match(latest().content, /Board 1/);
  assert.match(latest().content, /🟥 Red picks: <@1001>/);
  assert.deepEqual(buttons(latest()).filter((b) => b.custom_id === cid.endNight(sid)).length, 1, 'End night is on the board');

  // -- tile picking --
  const animals = buttons(latest()).find((b) => b.label === '1st · Animals');
  const wrongPicker = await press("Eve presses Ann's tile", animals.custom_id, eve, 'reply');
  assert.equal(wrongPicker.calls[0].payload.content, "It's <@1001>'s (🟥 Red) pick.");
  await press("Ben presses Ann's tile", animals.custom_id, ben, 'reply');
  await press('locked grade-2 tile', buttons(latest()).find((b) => /2nd/.test(b.label)).custom_id, ann, 'deferUpdate');

  // -- question 1: Ask a teammate, a private lock-in, a wrong answer --
  const boardBefore = latest();
  const q1 = await pickNightTile(sid, ann, (b) => /Animals/.test(b.label));
  assert.equal(boardBefore.deleted, true, 'the board was replaced by the question');
  assert.equal(q1.question.type, 'choice');
  assert.match(latest().content, /🟥 Red: <@1001> ⏳/);
  assert.match(latest().content, /🟦 Blue: <@1002> ⏳/);
  assert.deepEqual(buttons(latest()).map((b) => b.label).slice(-1), ['🙋 Ask a teammate']);
  const questionMessage = latest();

  const choiceButton = (position) => cid.ans(sid, q1.seq, position);
  const outsider = await press('Eve answers', choiceButton(0), eve, 'reply');
  assert.equal(outsider.calls[0].payload.content, "You're not playing in this game.");
  const notTurn = await press('Cat answers (Ann is up)', choiceButton(0), cat, 'reply');
  assert.equal(notTurn.calls[0].payload.content, "It's <@1001>'s turn for 🟥 Red.");

  // Ben, Blue's answerer, asks Dan to answer instead.
  const catAssist = await press('Cat presses Ask a teammate', cid.assist(sid, q1.seq), cat, 'reply');
  assert.match(catAssist.calls[0].payload.content, /turn for 🟥 Red/);
  const assist = await press('Ben presses Ask a teammate', cid.assist(sid, q1.seq), ben, 'reply');
  assert.equal(assist.calls[0].payload.flags, 64);
  const pick = assist.calls[0].payload.components[0].components[0];
  assert.equal(pick.custom_id, cid.assistPick(sid, q1.seq));
  assert.deepEqual(pick.options.map((o) => o.value), [dan.id], 'only teammates are offered');
  const picked = await choose('Ben picks Dan', pick.custom_id, ben, [dan.id], 'update');
  assert.match(picked.calls[0].payload.content, /Asked <@1004> to answer/);
  assert.match(questionMessage.content, /🟦 Blue: <@1004> \(for <@1002>\) ⏳/);
  const benNow = await press('Ben answers (Dan is up)', choiceButton(0), ben, 'reply');
  assert.equal(benNow.calls[0].payload.content, "It's <@1004>'s turn for 🟦 Blue.");
  const used = await press('Dan presses Ask a teammate', cid.assist(sid, q1.seq), dan, 'reply');
  assert.equal(used.calls[0].payload.content, 'Your team has already used Ask a teammate.');
  assert.equal(nightOf(sid).teams[1].assistUsed, true);

  // Ann answers rightly: she gets a private lock-in and the status line turns to a lock.
  const rightPosition = q1.order.indexOf('ABCD'.indexOf(q1.question.answer));
  const lock = await press('Ann answers', choiceButton(rightPosition), ann, 'reply');
  assert.equal(lock.calls[0].payload.flags, 64, 'the lock-in is private');
  assert.match(lock.calls[0].payload.content, /^🔒 Locked in: [A-D]\) /);
  assert.match(questionMessage.content, /🟥 Red: <@1001> 🔒/);
  assert.ok(!questionMessage.content.includes('answered'), 'nothing is revealed yet');
  const twice = await press('Ann answers again', choiceButton(rightPosition), ann, 'reply');
  assert.equal(twice.calls[0].payload.content, 'Your team has already answered.');
  // Dan answers wrongly, which ends the question.
  await press('Dan answers', choiceButton((rightPosition + 1) % q1.order.length), dan, 'reply');

  // -- result --
  assert.equal(getSession(sid).status, 'reveal');
  assert.match(questionMessage.content, /✅ The answer was \*\*[A-D]\) /);
  assert.match(questionMessage.content, /🟥 Red: <@1001> answered [A-D]\) .* ✅/);
  assert.match(questionMessage.content, /🟦 Blue: <@1004> \(for <@1002>\) answered [A-D]\) .* ❌/);
  assert.match(questionMessage.content, /\*\*Scores:\*\* 🟥 Red 1 · 🟦 Blue 0/);
  assert.deepEqual(buttons(questionMessage).map((b) => b.label), ['Next ▶', 'End night']);
  assert.deepEqual(nightOf(sid).teams.map((t) => t.turn), [1, 1], 'every team moves on to its next player');

  const guesses = rows('SELECT user_id, team_id, correct, assisted, assigned_user_id, timed_out FROM guesses ORDER BY id');
  assert.equal(guesses.length, 2);
  assert.deepEqual(
    guesses.map((g) => [g.user_id, g.correct, g.assisted, g.assigned_user_id]),
    [['1001', 1, 0, null], ['1004', 0, 1, '1002']],
    'the helper is recorded as the one who answered, with who asked for help',
  );
  assert.equal(row('SELECT picked_by, board FROM game_questions').picked_by, '1001');
  assert.equal(rows('SELECT score FROM teams ORDER BY position').map((t) => t.score).join(','), '1,0', 'scores are saved after every question');

  const notHostNext = await press('Ann presses Next', cid.next(sid), ann, 'reply');
  assert.equal(notHostNext.calls[0].payload.content, 'Only the host can do that.');
  await press('Hank presses Next', cid.next(sid), hank, 'update');
  assert.equal(buttons(questionMessage).length, 0, 'the result keeps its text but loses its buttons');

  // -- question 2: the host picks, a typed answer, a team that times out --
  assert.match(latest().content, /Board 1/);
  assert.match(latest().content, /🟦 Blue picks: <@1004>/, 'tile picking moves to the next team');
  const q2 = await pickNightTile(sid, hank, (b) => /Math/.test(b.label));
  assert.equal(q2.question.type, 'typed');
  const q2Message = latest();
  assert.match(q2Message.content, /🟥 Red: <@1003> ⏳/, 'Red moved on to Cat');
  assert.match(q2Message.content, /🟦 Blue: <@1004> ⏳/);
  assert.deepEqual(buttons(q2Message).map((b) => b.label), ['Answer', '🙋 Ask a teammate']);
  await press('Eve opens the answer box', cid.typed(sid, q2.seq), eve, 'reply');
  await press('Ann opens the answer box (Cat is up)', cid.typed(sid, q2.seq), ann, 'reply');
  await answerNight(sid, cat, { correct: true });
  assert.match(q2Message.content, /🟥 Red: <@1003> 🔒/);
  await onNightQuestionTimeout(discord.client, sid, q2.seq);
  console.log('  #- question times out');
  assert.match(q2Message.content, /🟦 Blue: <@1004> ⏰ no answer/);
  assert.match(q2Message.content, /\*\*Scores:\*\* 🟥 Red 2 · 🟦 Blue 0/);
  await press('Dan opens the answer box after the timeout', cid.typed(sid, q2.seq), dan, 'deferUpdate');
  await send(
    'Dan submits after the timeout',
    discord.modal(cid.typedSubmit(sid, q2.seq), dan, { text: 'x', channelId: CHANNEL, messageId: q2Message.id }),
    'reply',
  );
  await onNightQuestionTimeout(discord.client, sid, q2.seq); // the timer firing twice changes nothing
  assert.equal(row("SELECT COUNT(*) AS n FROM guesses WHERE game_question_id = ?", q2.gameQuestionId).n, 2);
  const timeout = row("SELECT * FROM guesses WHERE user_id = '1004' AND timed_out = 1");
  assert.deepEqual([timeout.answer, timeout.correct, timeout.response_ms], [null, 0, null]);
  assert.equal(nightOf(sid).asked, 2);

  // -- the rest of board 1, then board 2 --
  await press('Next', cid.next(sid), hank, 'update');
  await playBoardOut(sid);
  const lastResult = latest();
  assert.deepEqual(buttons(lastResult).map((b) => b.label), ['Play another board', 'End night']);
  assert.equal(buttons(lastResult)[0].disabled, false, 'there are enough unused questions for a second board');
  assert.equal(nightOf(sid).asked, 10);
  const early = await press('Next on a finished board (forged)', cid.next(sid), hank, 'deferUpdate');
  assert.equal(early.calls.length, 1);

  await press('Play another board', cid.anotherBoard(sid), hank, 'update');
  assert.match(latest().content, /Board 2/);
  assert.equal(nightOf(sid).boardNumber, 2);
  await playBoardOut(sid);
  assert.equal(nightOf(sid).asked, 19, "the bank has 19 usable questions: 10 on board 1, 9 on board 2");
  const finalResult = latest();
  assert.equal(buttons(finalResult)[0].label, 'Play another board');
  assert.equal(buttons(finalResult)[0].disabled, true, 'every question has been used');
  const none = await press('Play another board (forged)', cid.anotherBoard(sid), hank, 'reply');
  assert.match(none.calls[0].payload.content, /enough unused questions/);

  // -- end --
  await press('End night', cid.endNight(sid), hank, 'update');
  assert.equal(getSession(sid), undefined);
  assert.equal(buttons(finalResult).length, 0);
  const standings = latest().content;
  assert.match(standings, /🏁 \*\*Trivia night over!\*\*/);
  assert.match(standings, /🏆 🟥 Red wins with \*\*19\*\*!/);
  assert.match(standings, /🟥 Red: \*\*19\*\* · <@1001>, <@1003>/);
  assert.match(standings, /🟦 Blue: \*\*0\*\* · <@1002>, <@1004>/);

  const done = row('SELECT * FROM games');
  assert.deepEqual([done.status, done.format], ['completed', 'night']);
  assert.ok(done.ended_at);
  assert.deepEqual(
    rows('SELECT name, score, won FROM teams ORDER BY position').map((t) => `${t.name}:${t.score}:${t.won}`),
    ['Red:19:1', 'Blue:0:0'],
  );
  assert.deepEqual(rows('SELECT board, COUNT(*) AS n FROM game_questions GROUP BY board').map((b) => [b.board, b.n]), [[1, 10], [2, 9]]);
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 38, 'two teams answered all 19 questions');
  const byUser = Object.fromEntries(rows('SELECT user_id, COUNT(*) AS n FROM guesses GROUP BY user_id').map((g) => [g.user_id, g.n]));
  assert.deepEqual(byUser, { 1001: 10, 1003: 9, 1002: 9, 1004: 10 }, 'answers alternate within a team; Dan also took Ben\'s first turn');
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses WHERE assisted = 1').n, 1);
  assert.equal(row('SELECT COUNT(*) AS n FROM game_questions').n, 19);
  assert.equal(new Set(rows('SELECT question_id FROM game_questions').map((r) => r.question_id)).size, 19, 'no question was asked twice');

  // -- the night shows up in /stats --
  const annStats = await send('/stats (Ann)', discord.command('stats', ann, { channelId: CHANNEL }), 'reply');
  assert.match(annStats.calls[0].payload.content, /\*\*Trivia nights:\*\* 1 played · 1 team win · 10 answered \(100% correct\) · 0 assists given/);
  const danStats = await send('/stats (Dan)', discord.command('stats', dan, { channelId: CHANNEL }), 'reply');
  assert.match(danStats.calls[0].payload.content, /\*\*Trivia nights:\*\* 1 played · 0 team wins · 10 answered \(0% correct\) · 1 assist given/);
  const hankStats = await send('/stats (Hank, the host)', discord.command('stats', hank, { channelId: CHANNEL }), 'reply');
  assert.equal(hankStats.calls[0].payload.content, 'No games yet. Run `/start`!');

  // The channel is free again.
  await startSolo('casual', ann);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 2);
}

async function nightEndings() {
  console.log('\n--- Trivia night: cancel, expiry, quitting, ties, nobody scoring ---');

  // Cancel the sign-up.
  freshWorld(42);
  let sid = await openNightSignup();
  await press('Ann joins', cid.join(sid), ann, 'update');
  const cancelled = await press('Hank cancels', cid.cancelNight(sid), hank, 'update');
  assert.equal(cancelled.calls[0].payload.content, 'Trivia night cancelled.');
  assert.equal(getSession(sid), undefined);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 0);
  await press('a button on the cancelled sign-up', cid.join(sid), ben, 'reply');

  // Sign-up that nobody starts expires, from sign-up or from the team builder.
  sid = await openNightSignup();
  const signup = latest();
  await onSignupIdle(discord.client, sid);
  console.log('  #- sign-up timer fires');
  assert.match(signup.content, /sign-up expired/);
  assert.equal(buttons(signup).length, 0);
  assert.equal(getSession(sid), undefined);

  sid = await openNightSignup();
  await press('Ann joins', cid.join(sid), ann, 'update');
  await press('Ben joins', cid.join(sid), ben, 'update');
  await press('Make teams', cid.makeTeams(sid), hank, 'reply');
  await onSignupIdle(discord.client, sid);
  console.log('  #- sign-up timer fires while teams are being made');
  assert.equal(getSession(sid), undefined);
  assert.equal(row('SELECT COUNT(*) AS n FROM games').n, 0, 'an unstarted night leaves nothing behind');

  // Not enough questions for a night.
  getDb().prepare('UPDATE questions SET active = 0 WHERE grade = 4').run();
  const poor = await send('/start', discord.command('start', hank, { channelId: CHANNEL }), 'reply');
  const poorSid = parseCustomId(poor.calls[0].payload.components[0].components[0].custom_id).sid;
  await send('pack', discord.button(cid.pack(poorSid, 'fifthgrader'), hank, { channelId: CHANNEL }), 'update');
  await send('confirm', discord.button(cid.packOk(poorSid), hank, { channelId: CHANNEL }), 'update');
  const noBoard = await send('trivia night', discord.button(cid.fmtNight(poorSid), hank, { channelId: CHANNEL }), 'update');
  assert.match(noBoard.calls[0].payload.content, /aren't enough questions/);
  assert.equal(getSession(poorSid), undefined);

  // End the night before any question: nothing is won.
  freshWorld(43);
  sid = await startNight([[ann], [ben]]);
  const board = latest();
  await press('Hank: End night', cid.endNight(sid), hank, 'deferUpdate');
  assert.equal(board.deleted, true);
  assert.match(latest().content, /ended\*\* before any questions were asked/);
  assert.equal(row('SELECT status FROM games').status, 'quit');
  assert.deepEqual(rows('SELECT won FROM teams').map((t) => t.won), [0, 0]);

  // A night nobody touches is abandoned, on the board or on a result.
  freshWorld(44);
  sid = await startNight([[ann], [ben]]);
  const idleBoard = latest();
  await onNightIdle(discord.client, sid);
  console.log('  #- night idle timer fires');
  assert.equal(idleBoard.deleted, true);
  assert.match(latest().content, /Trivia night abandoned/);
  assert.equal(row('SELECT status FROM games').status, 'abandoned');
  assert.equal(getSession(sid), undefined);

  freshWorld(45);
  sid = await startNight([[ann], [ben]]);
  await pickNightTile(sid);
  await everyoneAnswers(sid, [true, false]);
  const result = latest();
  assert.equal(buttons(result).length, 2);
  await onNightIdle(discord.client, sid);
  assert.equal(buttons(result).length, 0, 'the result loses its buttons');
  assert.match(latest().content, /Trivia night abandoned/);
  assert.equal(row('SELECT status FROM games').status, 'abandoned');
  assert.deepEqual(rows('SELECT won FROM teams').map((t) => t.won), [0, 0], 'no wins on an abandoned night');
  assert.equal(row('SELECT score FROM teams WHERE position = 0').score, 1, 'but the scores are kept');

  // A tie shares the win. A team of one can't ask a teammate.
  freshWorld(46);
  sid = await startNight([[ann], [ben]]);
  const q = await pickNightTile(sid);
  const lonely = await press('Ann presses Ask a teammate', cid.assist(sid, q.seq), ann, 'reply');
  assert.equal(lonely.calls[0].payload.content, "You're the only one on your team.");
  await everyoneAnswers(sid, [true, true]);
  await press('End night', cid.endNight(sid), hank, 'update');
  assert.match(latest().content, /It's a tie! 🟥 Red and 🟦 Blue share the win with \*\*1\*\* each/);
  assert.deepEqual(rows('SELECT won FROM teams ORDER BY position').map((t) => t.won), [1, 1]);
  assert.equal(row('SELECT status FROM games').status, 'completed');

  // Nobody scored, and everybody timing out is fine too.
  freshWorld(47);
  sid = await startNight([[ann], [ben]]);
  await pickNightTile(sid);
  await everyoneAnswers(sid, [false, false]);
  await press('Next', cid.next(sid), hank, 'update');
  const timeoutQ = await pickNightTile(sid);
  await onNightQuestionTimeout(discord.client, sid, timeoutQ.seq);
  assert.match(latest().content, /🟥 Red: <@1001> ⏰ no answer/);
  assert.match(latest().content, /🟦 Blue: <@1002> ⏰ no answer/);
  await press('End night', cid.endNight(sid), hank, 'update');
  assert.match(latest().content, /No team scored, so nobody wins/);
  assert.deepEqual(rows('SELECT won FROM teams').map((t) => t.won), [0, 0]);
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses WHERE timed_out = 1').n, 2);

  // Three teams: pick rotation Red, Blue, Green, Red.
  freshWorld(48);
  sid = await startNight([[ann], [ben], [cat]]);
  const order = [];
  for (let i = 0; i < 4; i++) {
    order.push(nightOf(sid).pickIndex);
    await pickNightTile(sid);
    await everyoneAnswers(sid, [false, false, false]);
    await press('Next', cid.next(sid), hank, 'update');
  }
  assert.deepEqual(order, [0, 1, 2, 0], 'tile picking rotates through the teams in order');
  assert.deepEqual(nightOf(sid).teams.map((t) => t.name), ['Red', 'Blue', 'Green']);
}

async function nightFailedAcknowledgements() {
  console.log('\n--- Trivia night: a failed acknowledgement must not strand it ---');
  freshWorld(49);
  const sid = await openNightSignup();

  // The Join button's update fails, but the roster changed and the message is still refreshed.
  await send('Ann joins (update fails)', discord.button(cid.join(sid), ann, { channelId: CHANNEL, failOn: 'update' }));
  assert.ok(nightOf(sid).roster.has(ann.id));
  assert.match(latest().content, /<@1001>/, 'the sign-up message was refreshed by id');
  await press('Ben joins', cid.join(sid), ben, 'update');
  await arrangeTeams(sid, [[ann], [ben]]);
  await press('Start', cid.startNight(sid), hank, 'update');

  // Ann's private "Locked in" reply fails, but her answer still counts and the night moves on.
  const q = await pickNightTile(sid);
  const rightPosition = q.order.indexOf('ABCD'.indexOf(q.question.answer));
  await send(
    'Ann answers (reply fails)',
    discord.button(cid.ans(sid, q.seq, rightPosition), ann, { channelId: CHANNEL, failOn: 'reply' }),
  );
  assert.equal(q.slots[0].locked, true);
  assert.equal(q.slots[0].correct, true);
  assert.equal(row('SELECT COUNT(*) AS n FROM guesses').n, 1);
  assert.match(latest().content, /🟥 Red: <@1001> 🔒/);
  await answerNight(sid, ben, { correct: false });
  assert.equal(getSession(sid).status, 'reveal');
  assert.match(latest().content, /\*\*Scores:\*\* 🟥 Red 1 · 🟦 Blue 0/);
  assert.deepEqual(buttons(latest()).map((b) => b.label), ['Next ▶', 'End night']);
}

// --- leaderboard -------------------------------------------------------------------------

async function leaderboardCommand() {
  console.log('\n--- /leaderboard ---');
  freshWorld(51);
  const run = (by, user = ann, guildId = 'guild1') =>
    send(`/leaderboard ${by ?? ''}`.trim(), discord.command('leaderboard', user, { channelId: CHANNEL, guildId, options: by ? { by } : {} }), 'reply');
  const guesses = (total, rightCount) =>
    Array.from({ length: total }, (_, i) => ({ questionId: -1, answer: 'B', correct: i < rightCount }));

  const empty = await run();
  assert.equal(empty.calls[0].payload.flags, undefined, 'the leaderboard is public');
  assert.deepEqual(empty.calls[0].payload.allowedMentions, { parse: [] });
  assert.match(empty.calls[0].payload.content, /Nobody in this server has answered 20 questions yet\./);

  // Ann 20/25 and Ben 20/22 in this server, Cat 30/30 in another one.
  playSolo({ userId: ann.id, name: 'Ann', guesses: guesses(25, 20) });
  playSolo({ userId: ben.id, name: 'Ben', guesses: guesses(22, 20) });
  playSolo({ userId: cat.id, name: 'Cat', guildId: 'guild2', guesses: guesses(30, 30) });

  const accuracy = await run();
  assert.equal(
    accuracy.calls[0].payload.content,
    ['🏆 **Leaderboard · Accuracy** (at least 20 answers)', '🥇 Ben · 91% (20/22)', '🥈 Ann · 80% (20/25)'].join('\n'),
  );
  const same = await run('accuracy');
  assert.equal(same.calls[0].payload.content, accuracy.calls[0].payload.content);
  const correct = await run('correct');
  assert.equal(
    correct.calls[0].payload.content,
    ['🏆 **Leaderboard · Correct answers**', '🥇 Ben · 20 correct (91% of 22)', '🥈 Ann · 20 correct (80% of 25)'].join('\n'),
  );

  const none = await run('wins');
  assert.match(none.calls[0].payload.content, /No trivia night has been won in this server yet\./);
  // Play (and win) a real trivia night: Ann's team scores, then the host ends it.
  const sid = await startNight([[ann], [ben]]);
  await pickNightTile(sid);
  await everyoneAnswers(sid, [true, false]);
  await press('End night', cid.endNight(sid), hank, 'update');
  const wins = await run('wins');
  assert.equal(wins.calls[0].payload.content, ['🏆 **Leaderboard · Trivia night wins**', '🥇 Ann · 1 win'].join('\n'));

  // Another server has its own board, and an unknown `by` falls back to accuracy.
  const other = await run('correct', cat, 'guild2');
  assert.match(other.calls[0].payload.content, /🥇 Cat · 30 correct \(100% of 30\)/);
  assert.ok(!other.calls[0].payload.content.includes('Ann'));
  const odd = await run('banana');
  assert.match(odd.calls[0].payload.content, /Leaderboard · Accuracy/);

  // Not in a server.
  const dm = await send('/leaderboard in a DM', discord.command('leaderboard', ann, { channelId: 'dm', guildId: null }), 'reply');
  assert.equal(dm.calls[0].payload.flags, 64);
  assert.match(dm.calls[0].payload.content, /per server/);
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
  await statsCommand();
  await triviaNight();
  await nightEndings();
  await nightFailedAcknowledgements();
  await leaderboardCommand();
  console.log('\nsmoke: PASS');
  process.exit(0);
} catch (err) {
  console.error('\nsmoke: FAIL');
  console.error(err);
  process.exit(1);
}
