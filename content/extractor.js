/**
 * Webber — page understanding layer.
 * Builds a compact PageSchema from the live DOM. No raw HTML ever leaves
 * this module — only extracted text/numeric fields and hrefs.
 *
 * Accessibility tree first (element.computedRole / aria-label), structural
 * heuristics second.
 */

const WebberExtractor = (() => {
  const MAX_ITEMS = 24;          // cap items sent to the API / panel
  const MAX_FIELD_LEN = 160;     // cap any single text field

  // Cache of the last extraction, with live element references for the
  // rule engine. Never serialized.
  let lastExtraction = null;

  // ---- accessibility helpers --------------------------------------------

  function roleOf(el) {
    // Accessibility Object Model first, explicit role attr second,
    // implicit-by-tag last.
    if ('computedRole' in el && el.computedRole) return el.computedRole;
    const attr = el.getAttribute && el.getAttribute('role');
    if (attr) return attr;
    const implicit = {
      NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
      HEADER: 'banner', FOOTER: 'contentinfo', ARTICLE: 'article',
      FORM: 'form', SECTION: 'region', UL: 'list', OL: 'list', LI: 'listitem',
      TABLE: 'table', A: 'link', BUTTON: 'button', IMG: 'img',
      H1: 'heading', H2: 'heading', H3: 'heading',
    };
    return implicit[el.tagName] || '';
  }

  function labelOf(el) {
    return (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby'))) || '';
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  // ---- landmarks ---------------------------------------------------------

  function findLandmarks() {
    const sel = 'nav, main, aside, article, header, footer, form, ' +
      '[role="navigation"], [role="main"], [role="complementary"], ' +
      '[role="banner"], [role="contentinfo"], [role="search"], [role="form"]';
    const seen = new Set();
    const landmarks = [];
    const elements = [];
    for (const el of document.querySelectorAll(sel)) {
      const role = roleOf(el) || el.tagName.toLowerCase();
      const key = role + '|' + (labelOf(el) || '');
      if (seen.has(key) && landmarks.length > 12) continue;
      seen.add(key);
      landmarks.push({ role, label: (labelOf(el) || '').slice(0, 80) });
      elements.push({ role, el });
      if (landmarks.length >= 20) break;
    }
    return { landmarks, elements };
  }

  // ---- repeating item detection ------------------------------------------

  /** Structural signature of an element: tag + sorted child tag histogram. */
  function signature(el) {
    const counts = {};
    for (const c of el.children) counts[c.tagName] = (counts[c.tagName] || 0) + 1;
    const inner = Object.entries(counts).sort().map(([t, n]) => `${t}:${Math.min(n, 5)}`).join(',');
    return `${el.tagName}[${inner}]`;
  }

  /**
   * Find groups of ≥3 visible sibling elements that share a structural
   * signature. Returns groups sorted by a relevance score (count × content).
   */
  function findRepeatingGroups() {
    const groups = [];
    const containers = document.querySelectorAll('body *');
    const visited = new Set();

    for (const parent of containers) {
      if (parent.children.length < 3 || visited.has(parent)) continue;
      if (parent.closest('[data-webber-ui]')) continue; // skip our own UI

      const bySig = {};
      for (const child of parent.children) {
        const sig = signature(child);
        (bySig[sig] = bySig[sig] || []).push(child);
      }
      for (const [sig, els] of Object.entries(bySig)) {
        if (els.length < 3) continue;
        const vis = els.filter(isVisible);
        if (vis.length < 3) continue;
        const avgText = vis.reduce((s, e) => s + Math.min(e.innerText?.length || 0, 400), 0) / vis.length;
        if (avgText < 15) continue; // skip decorative repeats (icons, dots)
        visited.add(parent);
        groups.push({
          container: parent,
          elements: vis,
          sig,
          score: vis.length * avgText,
        });
      }
    }

    groups.sort((a, b) => b.score - a.score);
    // Drop groups nested inside a higher-scoring group's items.
    const kept = [];
    for (const g of groups) {
      const nested = kept.some((k) => k.elements.some((el) => el.contains(g.container)));
      if (!nested) kept.push(g);
      if (kept.length >= 3) break;
    }
    return kept;
  }

  // ---- field extraction ----------------------------------------------------

  const PRICE_RE = /(?:[$€£₹¥]|USD|EUR|GBP|INR)\s?(\d[\d,]*(?:\.\d{1,2})?)/;
  const RATING_RE = /(\d(?:\.\d)?)\s*(?:out of|\/)\s*5|(\d\.\d)\s*(?:stars?|★)/i;

  function toNumber(str) {
    const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function extractItemFields(el) {
    const fields = {};
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();

    // title: heading → aria-label → first link text → first strong line
    const heading = el.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]');
    const link = el.querySelector('a[href]');
    fields.title = (
      heading?.innerText || labelOf(el) || link?.innerText || text.split('. ')[0] || ''
    ).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_LEN);

    if (link) {
      try { fields.link = new URL(link.getAttribute('href'), location.href).href.slice(0, 300); } catch (e) { /* ignore */ }
    }

    // price — raw numeric value, currency symbol stripped
    const priceMatch = text.match(PRICE_RE);
    if (priceMatch) fields.price = toNumber(priceMatch[1]);

    // rating
    const ratingLabel = el.querySelector('[aria-label*="star" i], [aria-label*="rating" i], [aria-label*="out of" i]');
    const ratingSrc = ratingLabel ? labelOf(ratingLabel) : text;
    const ratingMatch = ratingSrc.match(RATING_RE);
    if (ratingMatch) {
      const val = toNumber(ratingMatch[1] || ratingMatch[2]);
      if (val !== null && val <= 5) fields.rating = val;
    }

    // availability
    const availMatch = text.match(/\b(out of stock|sold out|unavailable|currently unavailable|in stock|available)\b/i);
    if (availMatch) fields.availability = availMatch[1].toLowerCase();

    // inbox-ish fields
    const timeEl = el.querySelector('time, [datetime]');
    const dateMatch = timeEl?.getAttribute('datetime') || timeEl?.innerText ||
      (text.match(/\b(\d{1,2}:\d{2}\s?(?:AM|PM)?|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s?\d{0,2}\b/i) || [])[0];
    if (dateMatch) fields.date = String(dateMatch).slice(0, 40);

    const emailEl = el.querySelector('[email], [data-sender], [name]');
    if (emailEl) {
      fields.sender = (emailEl.getAttribute('email') || emailEl.getAttribute('data-sender') ||
        emailEl.getAttribute('name') || emailEl.innerText || '').slice(0, 80);
    }
    // unread heuristic (bold rows in inboxes)
    const cs = getComputedStyle(el);
    if (parseInt(cs.fontWeight, 10) >= 600 || el.querySelector('.unread, [aria-label*="unread" i]')) {
      fields.unread = true;
    }

    // short text snippet
    fields.text = text.slice(0, MAX_FIELD_LEN);

    // prune empties
    for (const k of Object.keys(fields)) {
      if (fields[k] === '' || fields[k] === null || fields[k] === undefined) delete fields[k];
    }
    return fields;
  }

  // ---- page type classification --------------------------------------------

  function classifyPage(groups, landmarks) {
    const host = location.hostname;
    const url = location.href.toLowerCase();
    const topGroup = groups[0];
    const items = topGroup ? topGroup.elements.map((el) => el.__webberFields || {}) : [];
    const withPrice = items.filter((f) => f.price !== undefined).length;
    const withSenderish = items.filter((f) => f.sender || f.unread).length;

    if (/mail\.|inbox|outlook/.test(host) || withSenderish >= Math.max(3, items.length / 2)) return 'inbox';
    if (topGroup && withPrice >= 3) return 'product-listing';
    const bodyText = document.body.innerText || '';
    if (PRICE_RE.test((document.querySelector('main, #main, [role="main"]') || document.body).innerText?.slice(0, 3000) || '') &&
        /\b(add to cart|buy now|add to bag|add to basket)\b/i.test(bodyText) && withPrice < 3) {
      return 'product-detail';
    }
    if ((url.includes('search') || url.includes('?q=') || url.includes('&q=')) && topGroup) return 'search-results';
    const article = document.querySelector('article, [role="article"]');
    if (article && (article.innerText || '').length > 1500) return 'article';
    if (/profile|account|user\//.test(url)) return 'profile';
    const forms = document.querySelectorAll('form input, form select, form textarea');
    if (forms.length > 8 && !topGroup) return 'form';
    if (document.querySelectorAll('canvas, svg[class*="chart"], [class*="dashboard"]').length > 3) return 'dashboard';
    if (topGroup && items.length >= 5) return 'search-results';
    return 'unknown';
  }

  // ---- public API -----------------------------------------------------------

  /** Re-scan the page. Returns the serializable PageSchema. */
  function extract() {
    const { landmarks, elements: landmarkEls } = findLandmarks();
    const groups = findRepeatingGroups();

    // annotate elements with extracted fields (cached for the rule engine)
    for (const g of groups) {
      g.items = g.elements.map((el) => {
        const fields = extractItemFields(el);
        el.__webberFields = fields;
        return fields;
      });
    }

    const pageType = classifyPage(groups, landmarks);
    const schema = {
      pageType,
      pageTitle: document.title.slice(0, 200),
      domain: location.hostname,
      repeatingItems: groups[0] ? groups[0].items.slice(0, MAX_ITEMS) : [],
      landmarks,
    };

    lastExtraction = { schema, groups, landmarkEls, ts: Date.now() };
    return schema;
  }

  /** Latest extraction (with live element refs). Runs extract() if stale/missing. */
  function current(maxAgeMs = 4000) {
    if (!lastExtraction || Date.now() - lastExtraction.ts > maxAgeMs) extract();
    return lastExtraction;
  }

  return { extract, current, roleOf, labelOf, isVisible };
})();

self.WebberExtractor = WebberExtractor;
