// custom_id scheme + tunables for the trivia flow.
//
// A session id (`sid`) is threaded as a suffix on every component custom_id so the
// router in app.js can recover which session a click belongs to. `sid` is generated
// WITHOUT underscores (see state.js — crypto.randomUUID() with dashes stripped), which
// keeps `answer_<sid>_<qIndex>_<value>` unambiguous to split on "_".

// --- Tunables -------------------------------------------------------------------

export const QUESTION_TIMEOUT_MS = 10_000; // per-question answer window
export const LOBBY_COUNTDOWN_MS = 60_000; // public lobby countdown before questions auto-start

// Game modes shown in the ephemeral picker (CONTEXT.md §6 step 1). Data-driven so
// app.js / trivia.js can render buttons from this list. Only `enabled` modes do
// anything this sprint.
export const MODES = [
  { key: 'fifthgrader', label: 'Are You Smarter Than a Fifth Grader', enabled: true },
  { key: 'trivia2', label: 'Coming Soon', enabled: false },
];

// --- custom_id builders -------------------------------------------------------
// Every builder takes `sid`. Answer ids also take `qIndex` (0-based question index)
// and `value` ('yes' | 'no').

export const cid = {
  modeSelect: (key, sid) => `mode_select_${key}_${sid}`,
  modeConfirm: (sid) => `mode_confirm_${sid}`,
  modeBack: (sid) => `mode_back_${sid}`,
  soloSelect: (sid) => `party_solo_${sid}`,
  teamsSelect: (sid) => `party_teams_${sid}`,
  partyBack: (sid) => `party_back_${sid}`,
  lobbyStart: (sid) => `lobby_start_${sid}`,
  lobbyCancel: (sid) => `lobby_cancel_${sid}`,
  answer: (sid, qIndex, value) => `answer_${sid}_${qIndex}_${value}`, // value: 'yes' | 'no'
};

// --- matcher -----------------------------------------------------------------
// parseCustomId(componentId) -> { kind, sid, ...extra }
//
// kind is one of:
//   'modeSelect'  -> { key }                 (button in the game-mode picker)
//   'modeConfirm'                            (Confirm on the confirm screen)
//   'modeBack'                              (Back on the confirm screen)
//   'soloSelect'                            (Solo on the solo/teams screen)
//   'teamsSelect'                           (Teams on the solo/teams screen)
//   'partyBack'                            (Back on the solo/teams screen)
//   'lobbyStart'                            (Start Now in the public lobby)
//   'lobbyCancel'                          (Cancel in the public lobby)
//   'answer'      -> { qIndex: number, value: 'yes'|'no' }
//   'unknown'     -> { raw }               (no prefix matched)

const SIMPLE_PREFIXES = {
  mode_confirm_: 'modeConfirm',
  mode_back_: 'modeBack',
  party_solo_: 'soloSelect',
  party_teams_: 'teamsSelect',
  party_back_: 'partyBack',
  lobby_start_: 'lobbyStart',
  lobby_cancel_: 'lobbyCancel',
};

export function parseCustomId(componentId) {
  if (typeof componentId !== 'string' || componentId.length === 0) {
    return { kind: 'unknown', sid: null, raw: componentId };
  }

  // answer_<sid>_<qIndex>_<value> — sid/qIndex/value have no underscores, so a
  // plain 3-way split is safe.
  if (componentId.startsWith('answer_')) {
    const [sid, qIndexRaw, value] = componentId.slice('answer_'.length).split('_');
    return { kind: 'answer', sid, qIndex: Number(qIndexRaw), value };
  }

  // mode_select_<key>_<sid> — split off sid from the right so `key` may itself
  // contain underscores if a future mode key needs them.
  if (componentId.startsWith('mode_select_')) {
    const rest = componentId.slice('mode_select_'.length);
    const cut = rest.lastIndexOf('_');
    if (cut === -1) return { kind: 'unknown', sid: null, raw: componentId };
    return { kind: 'modeSelect', sid: rest.slice(cut + 1), key: rest.slice(0, cut) };
  }

  for (const [prefix, kind] of Object.entries(SIMPLE_PREFIXES)) {
    if (componentId.startsWith(prefix)) {
      return { kind, sid: componentId.slice(prefix.length) };
    }
  }

  return { kind: 'unknown', sid: null, raw: componentId };
}
