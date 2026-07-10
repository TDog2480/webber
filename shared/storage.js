/**
 * Webber — chrome.storage wrapper.
 * Works in content scripts, the side panel, and the background worker.
 *
 * Layout (chrome.storage.local):
 *   webber:installId             → string (anonymous per-install id)
 *   webber:history               → Array<HistoryEntry> (max 20, newest first)
 *   rules:{domain}               → RuleSet[]
 *   rules:category:{pageType}    → RuleSet[]
 *
 * Layout (chrome.storage.session — survives navigation, clears on browser close):
 *   webber:board                 → { items: BoardItem[] }
 */

const WebberStorage = (() => {
  const K = self.WebberSchema.keys;

  // ---- generic helpers -------------------------------------------------

  async function localGet(key, fallback) {
    const out = await chrome.storage.local.get(key);
    return out[key] !== undefined ? out[key] : fallback;
  }

  async function localSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  // ---- install id ------------------------------------------------------

  async function getInstallId() {
    return localGet(K.installId, null);
  }

  /** Returns the stored installId, generating+persisting one on first call. */
  async function ensureInstallId() {
    let id = await localGet(K.installId, null);
    if (!id) {
      id = crypto.randomUUID();
      await localSet(K.installId, id);
    }
    return id;
  }

  // ---- rules -----------------------------------------------------------

  /** Returns { domainRules: RuleSet[], categoryRules: RuleSet[] } */
  async function getRulesFor(domain, pageType) {
    const domainKey = K.rulesForDomain(domain);
    const categoryKey = K.rulesForCategory(pageType);
    const out = await chrome.storage.local.get([domainKey, categoryKey]);
    return {
      domainRules: out[domainKey] || [],
      categoryRules: out[categoryKey] || [],
    };
  }

  /**
   * Save a rule set.
   * scope: 'domain' → rules:{domain}, 'category' → rules:category:{pageType}
   * Replaces an existing rule with the same ruleName under the same key.
   */
  async function saveRule(rule, scope) {
    const key = scope === 'category'
      ? K.rulesForCategory(rule.pageType)
      : K.rulesForDomain(rule.domain);
    const existing = await localGet(key, []);
    const filtered = existing.filter((r) => r.ruleName !== rule.ruleName);
    filtered.push({
      ruleName: rule.ruleName,
      domain: rule.domain,
      pageType: rule.pageType,
      transforms: rule.transforms,
      mode: rule.mode || 'generic',
      createdAt: rule.createdAt || new Date().toISOString(),
      applyCount: rule.applyCount || 0,
    });
    await localSet(key, filtered);
    return key;
  }

  /** Delete a rule by name from a specific storage key. */
  async function deleteRule(storageKey, ruleName) {
    const existing = await localGet(storageKey, []);
    const filtered = existing.filter((r) => r.ruleName !== ruleName);
    if (filtered.length === 0) {
      await chrome.storage.local.remove(storageKey);
    } else {
      await localSet(storageKey, filtered);
    }
  }

  async function incrementApplyCount(storageKey, ruleName) {
    const existing = await localGet(storageKey, []);
    const rule = existing.find((r) => r.ruleName === ruleName);
    if (rule) {
      rule.applyCount = (rule.applyCount || 0) + 1;
      await localSet(storageKey, existing);
    }
  }

  /** All saved rules, as { storageKey: RuleSet[] } for the Rules tab. */
  async function getAllRules() {
    const all = await chrome.storage.local.get(null);
    const result = {};
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith('rules:') && Array.isArray(value) && value.length) {
        result[key] = value;
      }
    }
    return result;
  }

  // ---- history -----------------------------------------------------------

  async function recordVisit(entry) {
    const history = await localGet(K.history, []);
    history.unshift({ ...entry, ts: Date.now() });
    await localSet(K.history, history.slice(0, 20));
  }

  async function getHistory() {
    return localGet(K.history, []);
  }

  // ---- board (session storage) -------------------------------------------
  // Note: the background worker calls setAccessLevel so content scripts can
  // use chrome.storage.session too.

  async function getBoard() {
    try {
      const out = await chrome.storage.session.get(K.board);
      return out[K.board] || { items: [] };
    } catch (e) {
      return { items: [] };
    }
  }

  async function setBoard(board) {
    await chrome.storage.session.set({ [K.board]: board });
  }

  async function addBoardItems(newItems) {
    const board = await getBoard();
    for (const item of newItems) {
      // De-dupe on a stable signature so re-extractions don't duplicate rows.
      const sig = JSON.stringify([item.domain, item.fields]);
      if (!board.items.some((it) => it.sig === sig)) {
        board.items.push({
          id: `bi_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          sig,
          domain: item.domain,
          fields: item.fields,
          ts: Date.now(),
        });
      }
    }
    await setBoard(board);
    return board;
  }

  async function removeBoardItem(id) {
    const board = await getBoard();
    board.items = board.items.filter((it) => it.id !== id);
    await setBoard(board);
    return board;
  }

  async function clearBoard() {
    await setBoard({ items: [] });
  }

  return {
    getInstallId, ensureInstallId,
    getRulesFor, saveRule, deleteRule, incrementApplyCount, getAllRules,
    recordVisit, getHistory,
    getBoard, addBoardItems, removeBoardItem, clearBoard,
  };
})();

self.WebberStorage = WebberStorage;
