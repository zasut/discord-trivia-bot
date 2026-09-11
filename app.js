import 'dotenv/config';
import express from 'express';
import { verifyKeyMiddleware } from 'discord-interactions';
import { handleInteraction } from './flow.js';

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

/**
 * Interactions endpoint URL where Discord will send HTTP requests.
 * Parses the request body and verifies incoming requests using discord-interactions.
 *
 * The flow logic lives in flow.js:handleInteraction(reqBody) so it can be unit-
 * tested / smoke-tested without Discord. It returns { status?, body, after? }:
 *   - `body`   the synchronous interaction response (sent within Discord's ~3s window)
 *   - `status` optional HTTP status (defaults to 200)
 *   - `after`  optional async work (DiscordRequest POST/PATCH) run AFTER the response
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  let result;
  try {
    result = await handleInteraction(req.body);
  } catch (err) {
    console.error('interaction handler error', err);
    if (!res.headersSent) res.status(500).send({ error: 'internal error' });
    return;
  }

  res.status(result.status || 200).send(result.body);

  if (typeof result.after === 'function') {
    result.after().catch((err) => console.error('post-response task failed', err));
  }
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
