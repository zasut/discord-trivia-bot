import 'dotenv/config';
import { InstallGlobalCommands } from './utils.js';

// Start a trivia session in the current channel.
// Opens the ephemeral game-mode picker (see AGENTS.md "Interaction flow").
const START_COMMAND = {
  name: 'start',
  description: 'Start a trivia session',
  type: 1,
  integration_types: [0, 1],
  contexts: [0, 1, 2],
};

const ALL_COMMANDS = [START_COMMAND];

InstallGlobalCommands(process.env.APP_ID, ALL_COMMANDS);
