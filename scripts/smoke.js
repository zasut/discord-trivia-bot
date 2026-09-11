// End-to-end smoke test for the interaction flow WITHOUT Discord.
//
//  - stubs globalThis.fetch so DiscordRequest resolves against canned data and
//    every REST call is logged (method + endpoint + body)
//  - imports handleInteraction from flow.js and feeds it fake interaction
//    payloads in sequence, asserting the response `type` at each step
//
// Run: node scripts/smoke.js
//
// Expected: completes cleanly, showing a question POST, an answer PATCH, and the
// final "Trivia complete" POST.

import assert from 'node:assert/strict';
import {
  InteractionType,
  InteractionResponseType as RT,
} from 'discord-interactions';
import { handleInteraction } from '../flow.js';
import { cid } from '../constants.js';

// --- fetch stub ----------------------------------------------------------

const restCalls = [];

globalThis.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  const endpoint = String(url).replace('https://discord.com/api/v10/', '');
  const body = options.body; // DiscordRequest already JSON.stringify'd it
  restCalls.push({ method, endpoint, body });
  console.log(`  REST ${method} ${endpoint}${body ? ` ${body}` : ''}`);
  return {
    ok: true,
    status: 200,
    json: async () => ({ id: 'msg_' + Math.random().toString(36).slice(2) }),
  };
};

// --- fake payload builders ---------------------------------------------

const USER = 'user_smoke';
const CHANNEL = 'chan_smoke';

function command(name) {
  return {
    type: InteractionType.APPLICATION_COMMAND,
    data: { name },
    context: 0,
    member: { user: { id: USER } },
    channel_id: CHANNEL,
    token: 'tok_start',
  };
}

function component(custom_id) {
  return {
    type: InteractionType.MESSAGE_COMPONENT,
    data: { custom_id },
    context: 0,
    member: { user: { id: USER } },
    channel_id: CHANNEL,
    token: 'tok_' + custom_id,
    message: { id: 'origin_msg' },
  };
}

// --- driver ----------------------------------------------------------

let stepNo = 0;
async function step(label, payload, expectedType) {
  stepNo += 1;
  const res = await handleInteraction(payload);
  const got = res.body?.type;
  console.log(`#${stepNo} ${label} -> response type ${got} (expected ${expectedType})`);
  assert.equal(got, expectedType, `${label}: response type`);
  if (typeof res.after === 'function') await res.after();
  return res;
}

(async () => {
  console.log('--- /start ---');
  const startRes = await handleInteraction(command('start'));
  assert.equal(
    startRes.body?.type,
    RT.CHANNEL_MESSAGE_WITH_SOURCE,
    '/start: response type',
  );
  // recover the session id from the first mode-picker button custom_id:
  //   mode_select_fifthgrader_<sid>
  const pickerRow = startRes.body.data.components[0];
  const firstCustomId = pickerRow.components[0].custom_id;
  const sid = firstCustomId.slice('mode_select_fifthgrader_'.length);
  assert.ok(sid && !sid.includes('_'), 'recovered a clean sid');
  console.log(`#0 /start -> response type ${startRes.body.type} (expected ${RT.CHANNEL_MESSAGE_WITH_SOURCE}); sid=${sid}`);

  await step('modeSelect(fifthgrader)', component(cid.modeSelect('fifthgrader', sid)), RT.UPDATE_MESSAGE);
  await step('modeConfirm', component(cid.modeConfirm(sid)), RT.UPDATE_MESSAGE);
  await step('soloSelect', component(cid.soloSelect(sid)), RT.UPDATE_MESSAGE);
  await step('lobbyStart', component(cid.lobbyStart(sid)), RT.DEFERRED_UPDATE_MESSAGE);
  await step("answer(q0,'yes')", component(cid.answer(sid, 0, 'yes')), RT.DEFERRED_UPDATE_MESSAGE);
  await step("answer(q1,'no')", component(cid.answer(sid, 1, 'no')), RT.DEFERRED_UPDATE_MESSAGE);

  // --- assertions on the stubbed REST traffic ---
  const sig = (c) => `${c.method} ${c.endpoint}`;
  console.log('\n--- REST calls captured ---');
  restCalls.forEach((c, i) => console.log(`  [${i}] ${sig(c)}`));

  const hasQuestionPost = restCalls.some(
    (c) =>
      c.method === 'POST' &&
      c.endpoint === `channels/${CHANNEL}/messages` &&
      /\*\*Q\d\/\d\*\*/.test(String(c.body)),
  );
  const hasAnswerPatch = restCalls.some(
    (c) =>
      c.method === 'PATCH' &&
      new RegExp(`^channels/${CHANNEL}/messages/`).test(c.endpoint) &&
      /You answered/.test(String(c.body)),
  );
  const hasCompletePost = restCalls.some(
    (c) =>
      c.method === 'POST' &&
      c.endpoint === `channels/${CHANNEL}/messages` &&
      /Trivia complete/.test(String(c.body)),
  );

  assert.ok(hasQuestionPost, 'expected a fresh question POST');
  assert.ok(hasAnswerPatch, 'expected an answer-result PATCH');
  assert.ok(hasCompletePost, 'expected the final "Trivia complete" POST');

  console.log('\nsmoke: PASS — question POST, answer PATCH, and completion POST all seen.');
  process.exit(0);
})().catch((err) => {
  console.error('\nsmoke: FAIL');
  console.error(err);
  process.exit(1);
});
