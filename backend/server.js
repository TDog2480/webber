/**
 * Webber backend — owns the Cerebras API key and every call to it.
 * The extension is a thin client: it POSTs { command, schema, mode, installId }
 * here and gets back { ok, result } or { ok:false, error }. No API key ever
 * ships inside the extension bundle.
 */

require('dotenv').config();
const express = require('express');

// ---- constants / env --------------------------------------------------------

const CEREBRAS_URL = process.env.CEREBRAS_URL || 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || 'gpt-oss-120b';
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 3600000);
const PORT = Number(process.env.PORT || 3000);

if (!process.env.CEREBRAS_API_KEY) {
  console.error('[Webber backend] CEREBRAS_API_KEY is not set — /translate will return 500 until it is configured.');
}

if (!process.env.WEBBER_SHARED_SECRET) {
  console.error('[Webber backend] WEBBER_SHARED_SECRET is not set — refusing to start (every /translate would be unauthenticated).');
  process.exit(1);
}

// ---- AI rule translator -----------------------------------------------------
// Moved verbatim from background/service-worker.js (now backend-owned).

const SYSTEM_PROMPT = `You are the rule translator for Webber, a browser extension that reshapes websites for the user.

You receive:
- A user command in natural language
- A page schema: the page type, domain, and extracted fields

You output a JSON transform spec using the apply_transforms tool. Your job is to turn the user's intent into a list of deterministic operations that a DOM rule engine can apply.

Rules:
- Use semantic targets (aria roles, landmark regions, repeating item structure) not brittle CSS classes
- Prefer structural operations (reorder, group, sort) over cosmetic ones (color, font)
- If the user wants to see less: use hide
- If the user wants to compare: use extract-to-panel on each repeating item's key fields
- If the user wants to prioritize: use sort or highlight with a condition
- extract-to-panel sends structured data to the workflow board side panel
- Never suggest operations that modify, submit, or destructively change anything
- Always output a ruleName the user would recognize`;

/**
 * Tool schema. `params` sub-fields are constrained to what the local rule
 * engine understands (by/direction/fields/condition/text) so output stays
 * deterministic and replayable.
 *
 * Note: could add "strict": true + additionalProperties:false later for
 * stricter tool-call decoding — out of scope for v1 (schema isn't closed).
 */
const APPLY_TRANSFORMS_PARAMETERS = {
  type: 'object',
  properties: {
    transforms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: {
            type: 'string',
            enum: ['hide', 'reorder', 'highlight', 'group', 'extract-to-panel', 'annotate', 'sort'],
          },
          target: {
            type: 'string',
            description: 'css-like description of what to target (semantic, not brittle class names). ' +
              'The engine understands: "repeating items" (product cards / result rows / email rows), ' +
              '"navigation", "ads", "sidebar", "footer", "article body", role=<aria role>, or a semantic CSS selector.',
          },
          params: {
            type: 'object',
            description: 'Op parameters. sort/reorder/group: {by: <field name>, direction: "asc"|"desc"}. ' +
              'extract-to-panel: {fields: [<field names>]}. annotate: {text: <badge text>}. ' +
              'hide/highlight on items may include {condition: {field, op: "equals"|"contains"|"lt"|"gt"|"exists"|"missing", value}}. ' +
              'Field names must come from the page schema repeatingItems keys (e.g. title, price, rating, availability, sender, date, text).',
            properties: {
              by: { type: 'string' },
              direction: { type: 'string', enum: ['asc', 'desc'] },
              fields: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
              condition: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  op: { type: 'string', enum: ['equals', 'contains', 'lt', 'gt', 'exists', 'missing'] },
                  value: {},
                },
                required: ['field'],
              },
            },
          },
        },
        required: ['op', 'target'],
      },
    },
    mode: { type: 'string', enum: ['shopping', 'research', 'triage', 'generic'] },
    ruleName: { type: 'string', description: 'short human-readable name for this rule set' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['transforms', 'mode', 'ruleName', 'confidence'],
};

const APPLY_TRANSFORMS_TOOL = {
  type: 'function',
  function: {
    name: 'apply_transforms',
    description: 'Apply a list of deterministic DOM transforms to the current page.',
    parameters: APPLY_TRANSFORMS_PARAMETERS, // the exact input_schema object, unchanged
  },
};

// ---- rate limiting -----------------------------------------------------------
// In-memory sliding-window limiter keyed by installId. Resets on server
// restart and does not span multiple instances — Redis is a later upgrade,
// not needed for v1.

const buckets = new Map(); // installId -> { count, windowStart }

function checkRateLimit(installId) {
  const now = Date.now();
  const b = buckets.get(installId);
  if (!b || now - b.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(installId, { count: 1, windowStart: now });
    return true;
  }
  if (b.count >= RATE_LIMIT_MAX) return false;
  b.count += 1;
  return true;
}

// ---- app ----------------------------------------------------------------------
// No CORS middleware: the extension's service worker calls this with
// host_permissions, which bypasses same-origin restrictions — same as
// today's direct-to-Anthropic call.

const app = express();
app.use(express.json({ limit: '256kb' }));

app.post('/translate', async (req, res) => {
  // Shared-secret gate. Runs before rate-limit bookkeeping or any upstream call so
  // rejected requests can't consume a real installId's rate budget.
  // NOTE: a shared secret is a weak private-v1 stopgap, not real access control — anyone
  // who unpacks the extension can read it. Durable fix later: per-user auth. See README.
  if (req.get('x-webber-secret') !== process.env.WEBBER_SHARED_SECRET) {
    return res.status(401).json({ ok: false, error: 'Unauthorized.' });
  }

  const { command, schema, mode, installId } = req.body || {};

  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ ok: false, error: 'Missing command.' });
  }
  if (typeof installId !== 'string' || !installId) {
    return res.status(400).json({ ok: false, error: 'Missing installId.' });
  }
  const pageSchema = schema && typeof schema === 'object' ? schema : {};
  const activeMode = mode || 'generic';

  if (!checkRateLimit(installId)) {
    return res.status(429).json({ ok: false, error: 'Rate limit exceeded — try again later.' });
  }

  // Read the key at call time — never captured into a top-level/logged var.
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) {
    return res.status(500).json({ ok: false, error: 'Server is not configured (missing CEREBRAS_API_KEY).' });
  }

  const upstreamBody = {
    model: CEREBRAS_MODEL,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ command, activeMode, pageSchema }) },
    ],
    tools: [APPLY_TRANSFORMS_TOOL],
    tool_choice: { type: 'function', function: { name: 'apply_transforms' } },
  };

  let upstream;
  try {
    upstream = await fetch(CEREBRAS_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, error: 'Could not reach the model provider.' });
  }

  if (!upstream.ok) {
    let upstreamMsg = '';
    try {
      const errBody = await upstream.json();
      upstreamMsg = errBody?.error?.message || (typeof errBody?.error === 'string' ? errBody.error : '') || '';
    } catch (e) { /* non-JSON or empty error body — fall back below */ }
    return res.status(502).json({ ok: false, error: upstreamMsg || `Model provider error (${upstream.status}).` });
  }

  const data = await upstream.json();
  const args = data?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (!args) return res.status(502).json({ ok: false, error: 'Model did not produce transforms.' });
  let parsed;
  try { parsed = JSON.parse(args); }
  catch (e) { return res.status(502).json({ ok: false, error: 'Model returned invalid JSON.' }); }
  if (!Array.isArray(parsed.transforms)) return res.status(502).json({ ok: false, error: 'Malformed transform spec.' });
  return res.json({ ok: true, result: parsed }); // {transforms, mode, ruleName, confidence}
});

// Handy for deploy platforms' health checks.
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log('Webber backend on :' + PORT));
