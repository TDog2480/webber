/**
 * Webber — background service worker (Manifest V3).
 * Owns the Anthropic API key and every API call (keys never reach content
 * scripts). Also brokers board data to the side panel, records history, and
 * relays the keyboard command to the active tab.
 */

importScripts('../shared/schema.js', '../shared/storage.js');

const Schema = self.WebberSchema;
const Storage = self.WebberStorage;

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-opus-4-8';

// ---- setup ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // Let content scripts read/write chrome.storage.session (board data).
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => {});
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// Keyboard shortcut → toggle the command bar in the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-command-bar') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: Schema.msg.TOGGLE_COMMAND_BAR }).catch(() => {});
  }
});

// ---- AI rule translator --------------------------------------------------------

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
 */
const APPLY_TRANSFORMS_TOOL = {
  name: 'apply_transforms',
  description: 'Apply a list of deterministic DOM transforms to the current page.',
  input_schema: {
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
  },
};

/** Compact the schema before sending — cap items and field sizes. */
function compactSchema(schema) {
  return {
    pageType: schema.pageType,
    pageTitle: schema.pageTitle,
    domain: schema.domain,
    landmarks: (schema.landmarks || []).slice(0, 12),
    repeatingItems: (schema.repeatingItems || []).slice(0, 12).map((item) => {
      const out = {};
      for (const [k, v] of Object.entries(item)) {
        out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
      }
      return out;
    }),
    repeatingItemCount: (schema.repeatingItems || []).length,
  };
}

/**
 * Single POST to the Anthropic Messages API with a forced tool call, so the
 * response is always structured JSON — never freeform text.
 */
async function translateCommand({ command, schema, mode }) {
  const apiKey = await Storage.getApiKey();
  if (!apiKey) throw new Error('No API key set — add one in the Webber side panel.');

  const userPayload = {
    command,
    activeMode: mode,
    pageSchema: compactSchema(schema),
  };

  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [APPLY_TRANSFORMS_TOOL],
      tool_choice: { type: 'tool', name: 'apply_transforms' },
      messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
    }),
  });

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const err = await res.json();
      detail = err?.error?.message || detail;
    } catch (e) { /* keep status */ }
    if (res.status === 401) throw new Error('API key rejected (401) — check it in the side panel.');
    if (res.status === 429) throw new Error('Rate limited — try again in a moment.');
    throw new Error(`Anthropic API error: ${detail}`);
  }

  const data = await res.json();
  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'apply_transforms');
  if (!toolUse) throw new Error('Model returned no transform spec.');
  const spec = toolUse.input;
  if (!Array.isArray(spec.transforms)) throw new Error('Malformed transform spec.');
  return spec;
}

// ---- message router --------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case Schema.msg.TRANSLATE:
      translateCommand(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // async

    case Schema.msg.BOARD_ADD:
      Storage.addBoardItems(message.items || [])
        .then((board) => {
          // Live-update any open side panel.
          chrome.runtime.sendMessage({ type: Schema.msg.BOARD_UPDATED, count: board.items.length })
            .catch(() => {});
          // Best-effort: open the panel so the board is visible.
          if (sender.tab?.id) {
            chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
          }
          sendResponse({ ok: true, count: board.items.length });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case Schema.msg.PAGE_VISIT:
      Storage.recordVisit({
        domain: message.domain,
        pageTitle: message.pageTitle,
        pageType: message.pageType,
        rulesApplied: message.rulesApplied || [],
      }).then(() => sendResponse({ ok: true }));
      return true;

    case Schema.msg.OPEN_PANEL:
      if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});
