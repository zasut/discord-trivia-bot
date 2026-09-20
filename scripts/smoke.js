// End-to-end smoke test for the interaction flow WITHOUT Discord.
//
//  - builds a fake discord.js client whose channels record every send / edit
//  - feeds flow.js:handleInteraction fake interaction objects in sequence, each
//    recording which reply method (reply / update / deferUpdate) the flow used
//
// Run: node scripts/smoke.js
//
// Expected: completes cleanly, showing a question send, an answer update, and the
// final "Trivia complete" send.

import assert from 'node:assert/strict';
import { handleInteraction } from '../flow.js';
import { cid } from '../constants.js';

// --- fake client ---------------------------------------------------------

const USER = 'user_smoke';
const CHANNEL = 'chan_smoke';
const channelCalls = [];

const client = {
  channels: {
    fetch: async (id) => ({
      send: async (payload) => {
        channelCalls.push({ method: 'send', channelId: id, payload });
        console.log(`  CHANNEL send ${id} ${JSON.stringify(payload.content)}`);
        return { id: 'msg_' + Math.random().toString(36).slice(2) };
      },
      messages: {
        edit: async (messageId, payload) => {
          channelCalls.push({ method: 'edit', channelId: id, messageId, payload });
          console.log(`  CHANNEL edit ${id}/${messageId} ${JSON.stringify(payload.content)}`);
          return { id: messageId };
        },
      },
    }),
  },
};

// --- fake interaction builders -------------------------------------------

function fakeInteraction(extra) {
  const calls = [];
  const record = (method) => async (payload) => {
    calls.push({ method, payload });
  };
  return {
    client,
    user: { id: USER },
    channelId: CHANNEL,
    isChatInputCommand: () => false,
    isButton: () => false,
    reply: record('reply'),
    update: record('update'),
    deferUpdate: record('deferUpdate'),
    calls,
    ...extra,
  };
}

const command = (name) =>
  fakeInteraction({ isChatInputCommand: () => true, commandName: name });

const component = (customId) =>
  fakeInteraction({ isButton: () => true, customId });

// --- driver ----------------------------------------------------------

let stepNo = 0;
async function step(label, interaction, expectedMethod) {
  stepNo += 1;
  await handleInteraction(interaction);
  const got = interaction.calls.map((c) => c.method);
  console.log(`#${stepNo} ${label} -> ${got.join(', ') || 'no reply'} (expected ${expectedMethod})`);
  assert.deepEqual(got, [expectedMethod], `${label}: reply method`);
  return interaction;
}

(async () => {
  console.log('--- /start ---');
  const start = await step('/start', command('start'), 'reply');
  // recover the session id from the first mode-picker button custom_id:
  //   mode_select_fifthgrader_<sid>
  const pickerRow = start.calls[0].payload.components[0];
  const firstCustomId = pickerRow.components[0].custom_id;
  const sid = firstCustomId.slice('mode_select_fifthgrader_'.length);
  assert.ok(sid && !sid.includes('_'), 'recovered a clean sid');
  console.log(`   sid=${sid}`);

  await step('modeSelect(fifthgrader)', component(cid.modeSelect('fifthgrader', sid)), 'update');
  await step('modeConfirm', component(cid.modeConfirm(sid)), 'update');
  await step('soloSelect', component(cid.soloSelect(sid)), 'update');
  await step('lobbyStart', component(cid.lobbyStart(sid)), 'deferUpdate');
  await step("answer(q0,'yes')", component(cid.answer(sid, 0, 'yes')), 'update');
  await step("answer(q1,'no')", component(cid.answer(sid, 1, 'no')), 'update');

  // A stale click after the game ended must get the "expired" reply, not throw.
  await step('stale answer', component(cid.answer(sid, 1, 'no')), 'reply');

  // --- assertions on the recorded channel traffic ---
  console.log('\n--- channel calls captured ---');
  channelCalls.forEach((c, i) => console.log(`  [${i}] ${c.method} ${c.channelId}`));

  const sent = (re) =>
    channelCalls.some(
      (c) => c.method === 'send' && c.channelId === CHANNEL && re.test(String(c.payload.content)),
    );
  assert.ok(sent(/starting <t:\d+:R>/), 'expected the public lobby send');
  assert.ok(sent(/\*\*Q2\/\d\*\*/), 'expected a fresh question send');
  assert.ok(sent(/Trivia complete/), 'expected the final "Trivia complete" send');

  console.log('\nsmoke: PASS — lobby send, question send, answer updates, and completion send all seen.');
  process.exit(0);
})().catch((err) => {
  console.error('\nsmoke: FAIL');
  console.error(err);
  process.exit(1);
});
