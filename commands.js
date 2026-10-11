import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';

// Games are posted by the bot into a server channel, so every command is guild-only:
// `contexts: [0]` is "guild" and `integration_types: [0]` is "installed to a server".

// Start a trivia session in the current channel.
// Opens the ephemeral pack picker (see AGENTS.md "Interaction flow").
const START_COMMAND = {
  name: 'start',
  description: 'Start a trivia session',
  type: 1,
  integration_types: [0],
  contexts: [0],
};

// Show a player's stats. Private unless `share` is set.
const STATS_COMMAND = {
  name: 'stats',
  description: 'Show trivia stats',
  type: 1,
  integration_types: [0],
  contexts: [0],
  options: [
    { name: 'user', description: 'Whose stats to show (default: you)', type: 6, required: false },
    { name: 'share', description: 'Post them in the channel instead of privately', type: 5, required: false },
  ],
};

const ALL_COMMANDS = [START_COMMAND, STATS_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
