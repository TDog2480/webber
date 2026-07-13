/**
 * Webber — content orchestrator.
 * Runs at document_idle on every page. Extracts the page schema, auto-applies
 * saved rules (zero LLM calls on repeat visits), records history, and wires
 * up messaging with the background worker and command bar.
 */

(() => {
  const Schema = self.WebberSchema;
  const Storage = self.WebberStorage;
  const Extractor = self.WebberExtractor;
  const Engine = self.WebberRuleEngine;

  /** rules currently active on this page: ruleName → {storageKey|null, rule|null} */
  const pageRules = new Map();
  let currentMode = 'generic';
  let pageSchema = null;

  // ---- init -----------------------------------------------------------------

  async function init() {
    if (window !== window.top) return; // top frame only

    pageSchema = Extractor.extract();
    console.log('[Webber] page schema', pageSchema);

    currentMode = guessModeFromPageType(pageSchema.pageType);

    const applied = await autoApplySavedRules();

    // record visit history (last 20 pages, kept by the background worker)
    chrome.runtime.sendMessage({
      type: Schema.msg.PAGE_VISIT,
      domain: pageSchema.domain,
      pageTitle: pageSchema.pageTitle,
      pageType: pageSchema.pageType,
      rulesApplied: applied,
    }).catch(() => {});
  }

  function guessModeFromPageType(pageType) {
    if (pageType === 'product-listing' || pageType === 'product-detail') return 'shopping';
    if (pageType === 'inbox') return 'triage';
    if (pageType === 'search-results' || pageType === 'article') return 'research';
    return 'generic';
  }

  // ---- saved rules: auto-apply on revisit -------------------------------------

  async function autoApplySavedRules() {
    const { domainRules, categoryRules } = await Storage.getRulesFor(
      pageSchema.domain, pageSchema.pageType);

    const appliedNames = [];
    const seen = new Set();

    const entries = [
      ...domainRules.map((r) => ({ rule: r, key: Schema.keys.rulesForDomain(pageSchema.domain) })),
      ...categoryRules.map((r) => ({ rule: r, key: Schema.keys.rulesForCategory(pageSchema.pageType) })),
    ];

    for (const { rule, key } of entries) {
      if (seen.has(rule.ruleName)) continue;
      seen.add(rule.ruleName);
      const result = Engine.apply(rule.ruleName, rule.transforms);
      if (result.applied > 0) {
        appliedNames.push(rule.ruleName);
        pageRules.set(rule.ruleName, { storageKey: key, rule });
        await Storage.incrementApplyCount(key, rule.ruleName);
        if (rule.mode) currentMode = rule.mode;
      }
    }
    if (appliedNames.length) {
      console.log('[Webber] auto-applied saved rules:', appliedNames);
    }
    return appliedNames;
  }

  // ---- command handling (called by the command bar) ----------------------------

  /**
   * Run a natural-language command: schema → background (LLM) → rule engine.
   * Returns { ruleName, mode, confidence, applied, details }.
   */
  async function runCommand(commandText) {
    pageSchema = Extractor.extract(); // fresh schema
    const response = await chrome.runtime.sendMessage({
      type: Schema.msg.TRANSLATE,
      command: commandText,
      schema: pageSchema,
      mode: currentMode,
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || 'No response from background worker');
    }
    const spec = response.result; // { transforms, mode, ruleName, confidence }
    if (spec.mode && Schema.MODES.includes(spec.mode)) currentMode = spec.mode;

    const result = Engine.apply(spec.ruleName, spec.transforms);
    pageRules.set(spec.ruleName, {
      storageKey: null, // unsaved (session-only) until user saves
      rule: {
        ruleName: spec.ruleName,
        domain: pageSchema.domain,
        pageType: pageSchema.pageType,
        transforms: spec.transforms,
        mode: currentMode,
        createdAt: new Date().toISOString(),
        applyCount: 1,
      },
    });
    return { ...spec, ...result };
  }

  /**
   * Apply a single rule built via the command bar's picker/palette (no LLM
   * call). Same shape and storage convention as an AI-authored rule from
   * runCommand — save/replay must not branch on authorship.
   * Returns { applied, details, ruleName, mode }.
   */
  function applyBuiltRule(ruleName, transforms) {
    const result = Engine.apply(ruleName, transforms);
    pageRules.set(ruleName, {
      storageKey: null, // unsaved (session-only) until the user saves — same convention
      rule: {
        ruleName,
        domain: pageSchema?.domain || location.hostname,
        pageType: pageSchema?.pageType || 'unknown',
        transforms,
        mode: currentMode,
        createdAt: new Date().toISOString(),
        applyCount: 1,
      },
    });
    return { ...result, ruleName, mode: currentMode }; // { applied, details, ruleName, mode }
  }

  /** Apply a mode's default transforms without an LLM call. */
  function applyModeDefaults(mode) {
    currentMode = mode;
    const config = Schema.MODE_CONFIGS[mode];
    if (!config || !config.defaultTransforms.length) return null;
    const ruleName = `${config.label} mode defaults`;
    Extractor.extract();
    const result = Engine.apply(ruleName, config.defaultTransforms);
    pageRules.set(ruleName, {
      storageKey: null,
      rule: {
        ruleName,
        domain: pageSchema.domain,
        pageType: pageSchema.pageType,
        transforms: config.defaultTransforms,
        mode,
        createdAt: new Date().toISOString(),
        applyCount: 1,
      },
    });
    return { ruleName, ...result };
  }

  /** Save a page rule to storage. scope: 'domain' | 'category'. */
  async function saveRule(ruleName, scope) {
    const entry = pageRules.get(ruleName);
    if (!entry) throw new Error(`Unknown rule: ${ruleName}`);
    const key = await Storage.saveRule(entry.rule, scope);
    entry.storageKey = key;
    chrome.runtime.sendMessage({ type: Schema.msg.RULES_CHANGED }).catch(() => {});
    return key;
  }

  /** Remove a rule: revert transforms and, if saved, delete from storage. */
  async function removeRule(ruleName) {
    Engine.revert(ruleName);
    const entry = pageRules.get(ruleName);
    if (entry && entry.storageKey) {
      await Storage.deleteRule(entry.storageKey, ruleName);
      chrome.runtime.sendMessage({ type: Schema.msg.RULES_CHANGED }).catch(() => {});
    }
    pageRules.delete(ruleName);
  }

  function getState() {
    return {
      mode: currentMode,
      pageType: pageSchema?.pageType,
      domain: pageSchema?.domain,
      activeRules: [...pageRules.entries()].map(([name, entry]) => ({
        ruleName: name,
        saved: !!entry.storageKey,
      })),
    };
  }

  // expose to the command bar script
  self.WebberContent = { runCommand, applyModeDefaults, applyBuiltRule, saveRule, removeRule, getState };

  // ---- messages from the background worker --------------------------------------

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === Schema.msg.TOGGLE_COMMAND_BAR) {
      self.WebberCommandBar?.toggle();
    }
  });

  // Keyboard fallback (chrome.commands can't always claim Ctrl+Shift+W since
  // Chrome reserves it for "close window" — Alt+W works everywhere).
  window.addEventListener('keydown', (e) => {
    const primary = (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyW';
    const fallback = e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyW';
    if (primary || fallback) {
      e.preventDefault();
      e.stopPropagation();
      self.WebberCommandBar?.toggle();
    }
  }, true);

  init();
})();
