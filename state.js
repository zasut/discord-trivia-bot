// In-memory only. Lost on restart. One process.
//
// Session store keyed by `sid`. A session tracks everything the flow needs between
// interactions: chosen mode, party type, players, question progress, and the
// interaction token + message id used to PATCH/POST via DiscordRequest when a timer
// fires (the bot is HTTP-interactions only, no gateway). See CONTEXT.md §0 / §6.

import { randomUUID } from 'node:crypto';

const sessions = new Map();

// sid must have NO underscores so `answer_<sid>_<qIndex>_<value>` stays splittable.
function generateSid() {
  return randomUUID().replace(/-/g, '');
}

export function createSession({ hostId, channelId }) {
  const sid = generateSid();
  const session = {
    sid,
    hostId,
    channelId,
    mode: null, // mode key from constants.MODES once picked
    party: null, // 'solo' | 'teams' once picked
    players: [hostId],
    status: 'picking', // 'picking' | 'lobby' | 'in_progress' | 'complete' | 'cancelled'
    questionIndex: 0,
    answers: [], // per-question answer records, shape decided by the game loop
    token: null, // interaction token for follow-ups (valid ~15 min)
    messageId: null, // id of the public lobby / question message
    timer: null, // active setTimeout handle, if any
    createdAt: Date.now(),
  };
  sessions.set(sid, session);
  return session;
}

export function getSession(sid) {
  return sessions.get(sid);
}

export function updateSession(sid, patch) {
  const session = sessions.get(sid);
  if (!session) return undefined;
  Object.assign(session, patch);
  return session;
}

export function deleteSession(sid) {
  const session = sessions.get(sid);
  if (session && session.timer) clearTimeout(session.timer);
  return sessions.delete(sid);
}

export function setTimer(sid, handle) {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (session.timer) clearTimeout(session.timer);
  session.timer = handle;
  return session;
}

export function clearTimer(sid) {
  const session = sessions.get(sid);
  if (!session) return undefined;
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  return session;
}
