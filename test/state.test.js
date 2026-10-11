import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allSessions,
  armTimer,
  clearTimer,
  createSession,
  deleteSession,
  findPublicSession,
  getSession,
  resetSessions,
} from '../state.js';

const make = (overrides = {}) =>
  Object.assign(createSession({ guildId: 'g1', channelId: 'c1', hostId: 'u1' }), overrides);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => resetSessions());

describe('sessions', () => {
  test('start in setup with a 32-hex sid and no colons', () => {
    const session = make();
    assert.match(session.sid, /^[0-9a-f]{32}$/);
    assert.equal(session.status, 'setup');
    assert.equal(session.public, false);
    assert.equal(session.hostId, 'u1');
    assert.equal(session.channelId, 'c1');
    assert.equal(session.guildId, 'g1');
    assert.equal(session.timer, null);
  });

  test('sids are unique', () => {
    assert.equal(new Set(Array.from({ length: 200 }, () => make().sid)).size, 200);
  });

  test('get and delete', () => {
    const session = make();
    assert.equal(getSession(session.sid), session);
    assert.equal(deleteSession(session.sid), true);
    assert.equal(getSession(session.sid), undefined);
    assert.equal(deleteSession(session.sid), false);
  });

  test('findPublicSession only finds public sessions in that channel', () => {
    const quiet = make();
    assert.equal(findPublicSession('c1'), undefined, 'a setup is not a public game');
    const game = make({ public: true });
    const elsewhere = createSession({ guildId: 'g1', channelId: 'c2', hostId: 'u2' });
    elsewhere.public = true;
    assert.equal(findPublicSession('c1'), game);
    assert.equal(findPublicSession('c2'), elsewhere);
    assert.equal(findPublicSession('c3'), undefined);
    deleteSession(game.sid);
    assert.equal(findPublicSession('c1'), undefined, 'the channel is free once the game is gone');
    assert.ok(quiet);
  });

  test('resetSessions empties the store', () => {
    make();
    make();
    resetSessions();
    assert.equal(allSessions().length, 0);
  });
});

describe('timers', () => {
  test('armTimer runs the function after the delay', async () => {
    const session = make();
    let fired = 0;
    armTimer(session.sid, () => fired++, 10);
    assert.equal(fired, 0);
    await wait(40);
    assert.equal(fired, 1);
  });

  test('arming again replaces the previous timer: a session has one slot', async () => {
    const session = make();
    const fired = [];
    armTimer(session.sid, () => fired.push('first'), 10);
    armTimer(session.sid, () => fired.push('second'), 20);
    await wait(60);
    assert.deepEqual(fired, ['second']);
  });

  test('clearTimer cancels it', async () => {
    const session = make();
    let fired = 0;
    armTimer(session.sid, () => fired++, 10);
    clearTimer(session.sid);
    assert.equal(session.timer, null);
    await wait(40);
    assert.equal(fired, 0);
  });

  test('deleteSession cancels it', async () => {
    const session = make();
    let fired = 0;
    armTimer(session.sid, () => fired++, 10);
    deleteSession(session.sid);
    await wait(40);
    assert.equal(fired, 0);
  });

  test('the handle is unref()ed so it never keeps the process alive', () => {
    const session = make();
    armTimer(session.sid, () => {}, 1000);
    assert.equal(session.timer.hasRef(), false);
  });

  test('arming or clearing an unknown session is a no-op', () => {
    assert.equal(armTimer('nope', () => {}, 10), undefined);
    assert.equal(clearTimer('nope'), undefined);
  });
});
