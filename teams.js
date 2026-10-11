// Trivia-night team rules (DESIGN.md "Trivia night"): dealing players into teams, each
// team's fixed answer order, who answers now, who picks the next tile, and who won. Pure
// apart from the rng, so it is easy to test. night.js applies them.

import { TEAM_STYLES } from './constants.js';
import { shuffle } from './rng.js';

// Shuffle the players and deal them round-robin into `teamCount` teams. Returns an array of
// teamCount arrays of user ids, sizes differing by at most one.
export function dealTeams(userIds, teamCount) {
  const teams = Array.from({ length: teamCount }, () => []);
  shuffle(userIds).forEach((userId, i) => teams[i % teamCount].push(userId));
  return teams;
}

// "Alphabetical" the way people expect: case doesn't matter and an accented letter sorts
// next to its plain letter ("Émile" between "Dan" and "Zed"), not after "z".
const NAME_ORDER = new Intl.Collator('en', { sensitivity: 'accent' });

// A team's fixed answer order: alphabetical by display name (case-insensitive), ties broken
// by user id. `names` maps user id -> display name. Does not change if someone renames
// later, because it is worked out once, when the night starts.
export function answerOrder(userIds, names) {
  const byId = (a, b) => {
    // Snowflakes compare numerically; anything else (tests) falls back to text.
    if (/^\d+$/.test(a) && /^\d+$/.test(b)) return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
    return a < b ? -1 : a > b ? 1 : 0;
  };
  return [...userIds].sort(
    (a, b) => NAME_ORDER.compare(names.get(a) ?? '', names.get(b) ?? '') || byId(a, b),
  );
}

// Who answers for this team right now. `turn` counts questions asked, so it wraps around
// the team's members.
export function currentAnswerer(team) {
  return team.members[team.turn % team.members.length];
}

// Tile-picking rotates through the teams in order, continuing across boards.
export function nextPickIndex(index, teamCount) {
  return (index + 1) % teamCount;
}

// The winning teams: the highest score, with ties sharing the win. If nobody scored there
// is no winner.
export function winningTeams(teams) {
  const top = Math.max(0, ...teams.map((team) => team.score));
  return top > 0 ? teams.filter((team) => team.score === top) : [];
}

// A team's label, e.g. "🟥 Red".
export function teamLabel(index) {
  const { emoji, name } = TEAM_STYLES[index];
  return `${emoji} ${name}`;
}
