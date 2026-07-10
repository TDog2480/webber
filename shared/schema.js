/**
 * Webber — shared type definitions and constants.
 * Loaded in content scripts, the side panel, and the background worker.
 *
 * @typedef {Object} PageSchema
 * @property {string} pageType   one of PAGE_TYPES
 * @property {string} pageTitle
 * @property {string} domain
 * @property {Array<Object>} repeatingItems  plain objects of extracted fields
 * @property {Array<{role: string, label: string}>} landmarks
 *
 * @typedef {Object} Transform
 * @property {string} op        one of TRANSFORM_OPS
 * @property {string} target    semantic description of what to target
 * @property {Object} params    op-specific parameters
 *
 * @typedef {Object} RuleSet
 * @property {string} ruleName
 * @property {string} domain
 * @property {string} pageType
 * @property {Transform[]} transforms
 * @property {string} mode
 * @property {string} createdAt   ISO string
 * @property {number} applyCount
 */

const WebberSchema = {
  PAGE_TYPES: [
    'product-listing', 'product-detail', 'inbox', 'search-results',
    'article', 'profile', 'form', 'dashboard', 'unknown',
  ],

  TRANSFORM_OPS: [
    'hide', 'reorder', 'highlight', 'group', 'extract-to-panel', 'annotate', 'sort',
  ],

  MODES: ['shopping', 'research', 'triage', 'generic'],

  /** Pre-configured mode behavior: default extract fields + default transforms. */
  MODE_CONFIGS: {
    shopping: {
      label: 'Shopping',
      extractFields: ['price', 'title', 'rating', 'availability'],
      defaultTransforms: [
        { op: 'sort', target: 'repeating items', params: { by: 'price', direction: 'asc' } },
        { op: 'hide', target: 'repeating items', params: { condition: { field: 'availability', op: 'contains', value: 'out of stock' } } },
        { op: 'extract-to-panel', target: 'repeating items', params: { fields: ['title', 'price', 'rating', 'availability'] } },
      ],
    },
    research: {
      label: 'Research',
      extractFields: ['title', 'source', 'date', 'summary'],
      defaultTransforms: [
        { op: 'hide', target: 'navigation and ads', params: {} },
        { op: 'highlight', target: 'article body', params: {} },
        { op: 'extract-to-panel', target: 'repeating items', params: { fields: ['title', 'source', 'date', 'summary'] } },
      ],
    },
    triage: {
      label: 'Triage',
      extractFields: ['sender', 'subject', 'date', 'snippet'],
      defaultTransforms: [
        { op: 'group', target: 'repeating items', params: { by: 'sender' } },
        { op: 'highlight', target: 'repeating items', params: { condition: { field: 'unread', op: 'equals', value: true } } },
        { op: 'extract-to-panel', target: 'repeating items', params: { fields: ['sender', 'subject', 'date', 'snippet'] } },
      ],
    },
    generic: {
      label: 'Generic',
      extractFields: ['title', 'text', 'link'],
      defaultTransforms: [],
    },
  },
};

// Storage key helpers (kept as functions so key format lives in one place)
WebberSchema.keys = {
  installId: 'webber:installId',
  history: 'webber:history',
  board: 'webber:board',
  rulesForDomain: (domain) => `rules:${domain}`,
  rulesForCategory: (pageType) => `rules:category:${pageType}`,
};

// Message types passed between content scripts, background, and side panel
WebberSchema.msg = {
  TOGGLE_COMMAND_BAR: 'webber:toggle-command-bar',
  TRANSLATE: 'webber:translate',
  BOARD_ADD: 'webber:board-add',
  BOARD_UPDATED: 'webber:board-updated',
  PAGE_VISIT: 'webber:page-visit',
  OPEN_PANEL: 'webber:open-panel',
  RULES_CHANGED: 'webber:rules-changed',
};

self.WebberSchema = WebberSchema;
