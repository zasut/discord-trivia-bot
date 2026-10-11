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

const ALL_COMMANDS = [START_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
