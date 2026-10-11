// In-memory only. Lost on restart. One process.
//
// Live sessions keyed by `sid`, plus their single timer handle. A session is the whole
// state of one /start: the ephemeral setup, then (once `public` is true) the game in the
// channel. Anything that must outlive a restart is written to the database through
// records.js as it happens. See AGENTS.md "Sessions and timers".

import { randomUUID } from 'node:crypto';

const sessions = new Map();

// sid must have NO colons (ids are `kind:sid:args`) and fit the 32-hex pattern that
// parseCustomId checks.
function generateSid() {
  return randomUUID().replace(/-/g, '');
}

// Session fields owned here. Game modules add their own (`run` for solo) when they start.
//   status: 'setup' -> 'board' / 'question' / 'between' / 'ending' (solo) -> 'ended'
//   public: true once the session owns the channel's one public game
export function createSession({ guildId, channelId, hostId }) {
  const sid = generateSid();
  const session = {
    sid,
    guildId,
    channelId,
    hostId,
    status: 'setup',
    pack: null, // PACKS key
    format: null, // 'solo' | 'night'
    difficulty: null, // DIFFICULTIES key (solo)
    public: false,
    gameId: null, // games.id once the game is created
    messageId: null, // id of the current live public message
    timer: null, // the one active setTimeout handle
    createdAt: Date.now(),
  };
  sessions.set(sid, session);
  return session;
}

export function getSession(sid) {
  return sessions.get(sid);
}

export function deleteSession(sid) {
  const session = sessions.get(sid);
  if (session?.timer) clearTimeout(session.timer);
  return sessions.delete(sid);
}

// The session that currently owns this channel's public game, if any.
export function findPublicSession(channelId) {
  for (const session of sessions.values()) {
    if (session.public && session.channelId === channelId) return session;
  }
  return undefined;
}

// Test helpers.
export function allSessions() {
  return [...sessions.values()];
}

export function resetSessions() {
  for (const session of sessions.values()) if (session.timer) clearTimeout(session.timer);
  sessions.clear();
}

// --- timers -----------------------------------------------------------------------------
// A session has ONE timer slot: whatever phase it is in arms exactly one timer, and arming
// replaces the previous one.

export function clearTimer(sid) {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  return session;
}

// setTimeout wrapper that stores the handle on the session and unref()s it, so a pending
// game timer never holds the process open on its own (the gateway connection does that).
// `fn` must catch its own errors: there is no interaction to report them to.
export function armTimer(sid, fn, ms) {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (session.timer) clearTimeout(session.timer);
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === 'function') handle.unref();
  session.timer = handle;
  return session;
}
