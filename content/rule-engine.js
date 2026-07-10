/**
 * Webber — local rule engine.
 * Applies deterministic DOM transforms produced by the AI rule translator
 * (or replayed from storage). Every operation records an undo function so a
 * rule can be reverted from the command bar.
 *
 * Target matching priority: ARIA role → landmark region → repeating item
 * structure → tag pattern → literal CSS selector. Never generated class names.
 */

const WebberRuleEngine = (() => {
  const HIGHLIGHT_BORDER = '3px solid #6366f1';
  const MARK = 'webberMark'; // dataset marker prefix

  /** ruleName → { transforms, undos: Array<fn> } */
  const activeRules = new Map();

  let applying = false;       // re-entrancy guard for the MutationObserver
  let observer = null;
  let debounceTimer = null;

  // ---- target resolution ---------------------------------------------------

  const NAVISH = /\b(nav|navigation|menu|header|banner)\b/i;
  const ADISH = /\b(ads?|advert|advertisement|sponsor|sponsored|promo|banner)\b/i;
  const ASIDEISH = /\b(aside|sidebar|complementary|related)\b/i;
  const FOOTERISH = /\b(footer|contentinfo)\b/i;
  const ITEMISH = /\b(items?|cards?|products?|results?|rows?|listings?|entries|emails?|messages?|posts?|repeating)\b/i;
  const ARTICLEISH = /\b(article( body)?|main content|body text|story)\b/i;

  function adElements() {
    const out = [];
    for (const el of document.querySelectorAll('[class], [id], iframe')) {
      if (el.closest('[data-webber-ui]')) continue;
      const idcls = `${el.id} ${typeof el.className === 'string' ? el.className : ''}`;
      if (/(^|[\s_-])(ad|ads|advert|sponsor|promo)([\s_-]|$)/i.test(idcls)) out.push(el);
      if (out.length > 40) break;
    }
    return out;
  }

  function matchesCondition(fields, condition) {
    if (!condition || !condition.field) return true;
    const raw = fields ? fields[condition.field] : undefined;
    const op = condition.op || 'contains';
    const value = condition.value;
    switch (op) {
      case 'exists': return raw !== undefined;
      case 'missing': return raw === undefined;
      case 'equals':
        return String(raw).toLowerCase() === String(value).toLowerCase();
      case 'contains':
        return raw !== undefined && String(raw).toLowerCase().includes(String(value).toLowerCase());
      case 'lt': return typeof raw === 'number' && raw < Number(value);
      case 'gt': return typeof raw === 'number' && raw > Number(value);
      default: return true;
    }
  }

  /**
   * Resolve a semantic target string into elements.
   * Returns { elements, group } — group is set when the target resolved to a
   * repeating-item group (needed for sort/reorder/group ops).
   */
  function resolveTarget(target, params = {}) {
    const t = String(target || '').toLowerCase();
    const extraction = self.WebberExtractor.current();

    // 1) repeating items (with optional condition filter)
    if (ITEMISH.test(t) || t === '' ) {
      const group = extraction.groups[0];
      if (group) {
        let elements = group.elements.filter((el) => el.isConnected);
        if (params.condition) {
          elements = elements.filter((el) => matchesCondition(el.__webberFields, params.condition));
        }
        return { elements, group };
      }
    }

    // 2) landmark regions by role keywords
    const collected = [];
    if (NAVISH.test(t)) {
      collected.push(...document.querySelectorAll('nav, header, [role="navigation"], [role="banner"]'));
    }
    if (ASIDEISH.test(t)) {
      collected.push(...document.querySelectorAll('aside, [role="complementary"]'));
    }
    if (FOOTERISH.test(t)) {
      collected.push(...document.querySelectorAll('footer, [role="contentinfo"]'));
    }
    if (ADISH.test(t)) {
      collected.push(...adElements());
    }
    if (ARTICLEISH.test(t)) {
      const main = document.querySelector('article, [role="article"], main, [role="main"]');
      if (main) collected.push(main);
    }
    if (collected.length) {
      return { elements: [...new Set(collected)].filter((el) => !el.closest('[data-webber-ui]')), group: null };
    }

    // 3) ARIA role mentioned literally, e.g. "role=search"
    const roleMatch = t.match(/role[=:\s]+"?([a-z]+)"?/);
    if (roleMatch) {
      return { elements: [...document.querySelectorAll(`[role="${roleMatch[1]}"]`)], group: null };
    }

    // 4) bare tag pattern ("images", "tables", "forms")
    const tagMap = { image: 'img', images: 'img', table: 'table', tables: 'table', form: 'form', forms: 'form', video: 'video', videos: 'video', iframe: 'iframe', iframes: 'iframe' };
    for (const [word, sel] of Object.entries(tagMap)) {
      if (t.includes(word)) return { elements: [...document.querySelectorAll(sel)], group: null };
    }

    // 5) last resort: treat as a CSS selector (semantic ones like [aria-label=...])
    try {
      const els = [...document.querySelectorAll(target)];
      if (els.length) return { elements: els, group: null };
    } catch (e) { /* not a selector */ }

    return { elements: [], group: null };
  }

  // ---- field access for sort/group -----------------------------------------

  function fieldValue(el, field) {
    const fields = el.__webberFields || {};
    return fields[field];
  }

  function compareBy(field, direction) {
    const dir = direction === 'desc' ? -1 : 1;
    return (a, b) => {
      const va = fieldValue(a, field);
      const vb = fieldValue(b, field);
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;   // missing values sink to the bottom
      if (vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    };
  }

  /** Save current child order of a container so reorders can be undone. */
  function snapshotOrder(container) {
    const order = [...container.children];
    return () => {
      for (const el of order) container.appendChild(el);
    };
  }

  // ---- operations ------------------------------------------------------------

  const ops = {
    hide(target, params, undos) {
      const { elements } = resolveTarget(target, params);
      for (const el of elements) {
        if (el.dataset[MARK + 'Hidden']) continue;
        const prev = el.style.display;
        el.style.display = 'none';
        el.dataset[MARK + 'Hidden'] = '1';
        undos.push(() => {
          el.style.display = prev;
          delete el.dataset[MARK + 'Hidden'];
        });
      }
      return elements.length;
    },

    highlight(target, params, undos) {
      const { elements } = resolveTarget(target, params);
      for (const el of elements) {
        if (el.dataset[MARK + 'Hl']) continue;
        const prev = el.style.borderLeft;
        const prevPad = el.style.paddingLeft;
        el.style.borderLeft = HIGHLIGHT_BORDER;
        el.style.paddingLeft = 'calc(' + (getComputedStyle(el).paddingLeft || '0px') + ' + 6px)';
        el.dataset[MARK + 'Hl'] = '1';
        undos.push(() => {
          el.style.borderLeft = prev;
          el.style.paddingLeft = prevPad;
          delete el.dataset[MARK + 'Hl'];
        });
      }
      return elements.length;
    },

    sort(target, params, undos) {
      const { elements, group } = resolveTarget(target, params);
      if (!group || !elements.length) return 0;
      const container = group.container;
      undos.push(snapshotOrder(container));
      const sorted = [...elements].sort(compareBy(params.by || 'price', params.direction || 'asc'));
      for (const el of sorted) container.appendChild(el);
      return sorted.length;
    },

    // reorder is sort with an explicit field; kept separate so the model can
    // express intent ("reorder by rating") distinctly.
    reorder(target, params, undos) {
      return ops.sort(target, { by: params.by, direction: params.direction || 'asc' }, undos);
    },

    group(target, params, undos) {
      const { elements, group } = resolveTarget(target, params);
      if (!group || !elements.length) return 0;
      const container = group.container;
      const by = params.by || 'title';
      undos.push(snapshotOrder(container));

      const sorted = [...elements].sort(compareBy(by, 'asc'));
      let lastKey = null;
      const headers = [];
      for (const el of sorted) {
        container.appendChild(el);
        const key = String(fieldValue(el, by) ?? 'Other');
        if (key !== lastKey) {
          const header = document.createElement('div');
          header.dataset.webberUi = '1';
          header.dataset[MARK + 'Header'] = '1';
          header.textContent = key;
          header.style.cssText =
            'font: 600 12px/1.4 system-ui, sans-serif; color:#6366f1;' +
            'padding:8px 4px 4px; border-bottom:1px solid #6366f133; margin-top:8px;';
          container.insertBefore(header, el);
          headers.push(header);
          lastKey = key;
        }
      }
      undos.push(() => headers.forEach((h) => h.remove()));
      return sorted.length;
    },

    annotate(target, params, undos) {
      const { elements } = resolveTarget(target, params);
      const text = params.text || '●';
      const badges = [];
      for (const el of elements) {
        if (el.querySelector(':scope > [data-webber-badge]')) continue;
        const badge = document.createElement('span');
        badge.dataset.webberUi = '1';
        badge.dataset.webberBadge = '1';
        badge.textContent = text;
        badge.style.cssText =
          'display:inline-block; font: 600 10px/1.6 system-ui, sans-serif;' +
          'color:#fff; background:#6366f1; border-radius:6px; padding:0 6px;' +
          'margin:2px 6px 2px 0; vertical-align:middle;';
        el.insertBefore(badge, el.firstChild);
        badges.push(badge);
      }
      undos.push(() => badges.forEach((b) => b.remove()));
      return badges.length;
    },

    'extract-to-panel'(target, params, undos) {
      const { elements, group } = resolveTarget(target, params);
      const source = group ? elements : [];
      if (!source.length) return 0;
      const fields = params.fields && params.fields.length ? params.fields : null;
      const items = source.map((el) => {
        const all = el.__webberFields || {};
        if (!fields) return { domain: location.hostname, fields: all };
        const picked = {};
        for (const f of fields) if (all[f] !== undefined) picked[f] = all[f];
        // always carry a title & link if present so rows stay identifiable
        if (picked.title === undefined && all.title !== undefined) picked.title = all.title;
        if (all.link !== undefined) picked.link = all.link;
        return { domain: location.hostname, fields: picked };
      }).filter((it) => Object.keys(it.fields).length > 0);

      if (items.length) {
        chrome.runtime.sendMessage({ type: self.WebberSchema.msg.BOARD_ADD, items }).catch(() => {});
      }
      // nothing visual to undo
      return items.length;
    },
  };

  // ---- application / revert ---------------------------------------------------

  /**
   * Apply a list of transforms under a rule name.
   * Returns { applied: number, details: Array<{op, target, count}> }.
   */
  function apply(ruleName, transforms) {
    applying = true;
    try {
      // Re-applying the same rule: revert first so we don't stack undos.
      if (activeRules.has(ruleName)) revert(ruleName);

      const record = { transforms, undos: [] };
      const details = [];
      for (const t of transforms || []) {
        const fn = ops[t.op];
        if (!fn) { details.push({ op: t.op, target: t.target, count: 0, error: 'unknown op' }); continue; }
        try {
          const count = fn(t.target, t.params || {}, record.undos);
          details.push({ op: t.op, target: t.target, count });
        } catch (e) {
          details.push({ op: t.op, target: t.target, count: 0, error: String(e) });
        }
      }
      activeRules.set(ruleName, record);
      ensureObserver();
      return { applied: details.filter((d) => d.count > 0).length, details };
    } finally {
      applying = false;
    }
  }

  /** Revert a single rule (or everything if no name given). */
  function revert(ruleName) {
    applying = true;
    try {
      const names = ruleName ? [ruleName] : [...activeRules.keys()];
      for (const name of names) {
        const record = activeRules.get(name);
        if (!record) continue;
        // undo in reverse order
        for (let i = record.undos.length - 1; i >= 0; i--) {
          try { record.undos[i](); } catch (e) { /* element likely gone */ }
        }
        activeRules.delete(name);
      }
      if (activeRules.size === 0 && observer) { observer.disconnect(); observer = null; }
    } finally {
      applying = false;
    }
  }

  function getActiveRules() {
    return [...activeRules.keys()];
  }

  // ---- reverse target resolution -----------------------------------------------
  // The inverse of resolveTarget: given an element the user clicked, describe it
  // with the same semantic strings resolveTarget knows how to match, so a picked
  // element round-trips through the exact same targeting logic as a typed command.

  function describeTarget(el) {
    if (!(el instanceof Element)) return '';

    // 1) member of a detected repeating group  -> resolveTarget step 1 ("repeating items")
    const extraction = self.WebberExtractor.current();
    for (const g of extraction.groups || []) {
      if (g.elements.some((item) => item.contains(el))) return 'repeating items';
    }

    // 2) landmark regions, same selectors/keywords resolveTarget matches (steps 2).
    //    Intentionally selects the WHOLE region, not just the clicked descendant
    //    (e.g. clicking anything inside <header> targets "navigation", which
    //    resolveTarget then matches to every nav/header on the page) — this
    //    matches typed-command semantics exactly, by design.
    if (el.closest('nav, header, [role="navigation"], [role="banner"]')) return 'navigation';
    if (el.closest('aside, [role="complementary"]'))                     return 'sidebar';
    if (el.closest('footer, [role="contentinfo"]'))                      return 'footer';
    if (el.closest('article, [role="article"], main, [role="main"]'))    return 'article body';

    // 3) explicit ARIA role -> resolveTarget step 3 ("role=<x>"); regex there is [a-z]+
    const roleEl = el.closest('[role]');
    if (roleEl) {
      const role = (roleEl.getAttribute('role') || '').trim();
      if (/^[a-z]+$/.test(role)) return `role=${role}`;
    }

    // 4) LAST RESORT: scoped CSS selector (id, else short tag+nth-of-type path).
    //    Less durable than the semantic targets above — never a generated class name.
    return cssPath(el);
  }

  function cssPath(el) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      return `#${CSS.escape(el.id)}`;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body && parts.length < 4) {
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break; } // anchor on nearest id
      let seg = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sib = [...parent.children].filter((c) => c.tagName === node.tagName);
        if (sib.length > 1) seg += `:nth-of-type(${sib.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = parent;
    }
    return parts.join(' > ');
  }

  // ---- MutationObserver: re-apply on SPA updates / infinite scroll -------------

  function ensureObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      if (applying) return;
      const meaningful = mutations.some((m) =>
        [...m.addedNodes].some((n) => n.nodeType === 1 && !n.dataset?.webberUi && !n.closest?.('[data-webber-ui]')));
      if (!meaningful) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (!activeRules.size) return;
        self.WebberExtractor.extract(); // refresh item fields & groups
        const snapshot = [...activeRules.entries()];
        for (const [name, record] of snapshot) {
          apply(name, record.transforms);
        }
      }, 300);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  return { apply, revert, getActiveRules, resolveTarget, describeTarget };
})();

self.WebberRuleEngine = WebberRuleEngine;
