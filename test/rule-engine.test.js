'use strict';
/**
 * Regression test for the N1 CSS-fallback target over-match fix (item 2).
 *
 * Loads content/rule-engine.js with a hand-rolled DOM stub — no jsdom, no new
 * dependency (mirrors test/shared.test.js's freshRequire pattern). Verified
 * against source: rule-engine.js references no document/window/
 * MutationObserver/CSS at load time (top level only defines consts/maps/
 * regexes/functions and the final `self.WebberRuleEngine = …`), and the new
 * resolveTarget step-0 "selector:" fast-path — placed before the
 * self.WebberExtractor.current() call — uses only document.querySelectorAll,
 * so this minimal stub is sufficient.
 *
 * Run with:  node --test test/rule-engine.test.js   (from the repo root)
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const RULE_ENGINE_PATH = path.join(__dirname, '..', 'content', 'rule-engine.js');

// Minimal DOM: a real (small) tree walk + matcher for exactly the selectors used here.
function makeEl(tag, id) { return { tagName: tag.toUpperCase(), id: id || '', children: [], parentElement: null }; }
function append(parent, child) { child.parentElement = parent; parent.children.push(child); return child; }
function walkAll(node, acc = []) { for (const c of node.children) { acc.push(c); walkAll(c, acc); } return acc; }

function makeFixture() {
  // body > form#search-form > input(intended) ; body > div > form(unrelated) > input
  const body = makeEl('body');
  const searchForm = append(body, makeEl('form', 'search-form'));
  const intended = append(searchForm, makeEl('input'));
  const other = append(append(body, makeEl('div')), makeEl('form'));
  append(other, makeEl('input'));
  const document = {
    querySelectorAll(selector) {
      const sel = String(selector).trim();
      const all = walkAll(body);
      let m = sel.match(/^#([\w-]+)\s*>\s*([a-z]+)$/i);      // "#id > tag"
      if (m) { const p = all.find((n) => n.id === m[1]); return p ? p.children.filter((c) => c.tagName === m[2].toUpperCase()) : []; }
      m = sel.match(/^#([\w-]+)$/);                           // "#id"
      if (m) { const n = all.find((x) => x.id === m[1]); return n ? [n] : []; }
      if (/^[a-z]+$/i.test(sel)) return all.filter((n) => n.tagName === sel.toUpperCase()); // "tag"
      return [];
    },
  };
  return { document, intended, body };
}

function loadEngine(document) {
  const sandboxSelf = {};
  global.self = sandboxSelf;
  global.self.WebberExtractor = { current: () => ({ groups: [] }) }; // only needed by the contrast test
  global.document = document;
  delete require.cache[require.resolve(RULE_ENGINE_PATH)];
  require(RULE_ENGINE_PATH);
  return sandboxSelf.WebberRuleEngine;
}

describe('content/rule-engine.js resolveTarget(): "selector:" prefix (N1 regression)', () => {
  test('resolveTarget("selector:#search-form > input") resolves only the intended, scoped element', () => {
    const fixture = makeFixture();
    const engine = loadEngine(fixture.document);
    const { elements } = engine.resolveTarget('selector:#search-form > input');
    assert.equal(elements.length, 1);
    assert.equal(elements[0], fixture.intended);
  });

  test('contrast: resolveTarget("form") with no prefix over-matches every <form> on the page (the bug the prefix prevents)', () => {
    const fixture = makeFixture();
    const engine = loadEngine(fixture.document);
    const { elements } = engine.resolveTarget('form');
    assert.equal(elements.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Tester-added coverage below. Nothing above this line was modified.
// ---------------------------------------------------------------------------

describe('content/rule-engine.js resolveTarget(): additional "selector:" coverage (tester-added)', () => {
  test('original casing is preserved when slicing the selector from `raw`, not the lowercased `t` -- a mixed-case id must resolve', () => {
    // If resolveTarget ever sliced from the lowercased `t` instead of `raw`,
    // this selector would look up "#search-form-mixed" (all lowercase) and
    // fail to find the actual "Search-Form-Mixed" (mixed-case) element,
    // since id lookups here (and in real CSS) are case-sensitive.
    const body = makeEl('body');
    const searchForm = append(body, makeEl('form', 'Search-Form-Mixed'));
    const intended = append(searchForm, makeEl('input'));
    const document = {
      querySelectorAll(selector) {
        const sel = String(selector).trim();
        const all = walkAll(body);
        let m = sel.match(/^#([\w-]+)\s*>\s*([a-z]+)$/i);
        if (m) { const p = all.find((n) => n.id === m[1]); return p ? p.children.filter((c) => c.tagName === m[2].toUpperCase()) : []; }
        m = sel.match(/^#([\w-]+)$/);
        if (m) { const n = all.find((x) => x.id === m[1]); return n ? [n] : []; }
        if (/^[a-z]+$/i.test(sel)) return all.filter((n) => n.tagName === sel.toUpperCase());
        return [];
      },
    };
    const engine = loadEngine(document);
    const { elements } = engine.resolveTarget('selector:#Search-Form-Mixed > input');
    assert.equal(elements.length, 1);
    assert.equal(elements[0], intended);
  });

  test('contrast: the IDENTICAL scoped selector WITHOUT the "selector:" prefix falls through to the bare tag-map heuristic and over-matches (proves the required regression test above is sensitive, not vacuous)', () => {
    // This is the literal string cssPath() would have produced BEFORE the
    // fix (describeTarget used to `return cssPath(el);` with no prefix).
    // Feeding it to resolveTarget as-is reproduces the pre-fix bug directly:
    // it does NOT hit the new step-0 fast-path (no "selector:" prefix), so
    // it falls into step 4's bare tag-map, where `t.includes('form')`
    // matches because "search-form" contains the substring "form" --
    // returning every <form> on the page (2 of them, neither the scoped
    // <input>) instead of the one intended, scoped element.
    const fixture = makeFixture();
    const engine = loadEngine(fixture.document);
    const { elements } = engine.resolveTarget('#search-form > input'); // same text, no prefix
    assert.equal(elements.length, 2);
    assert.ok(elements.every((el) => el.tagName === 'FORM'), 'unprefixed selector over-matches to <form> elements, not the scoped <input>');
    assert.ok(!elements.includes(fixture.intended), 'the actually-intended element must NOT be in the over-matched set');
  });
});

// ---- describeTarget(): a slightly richer element stub (closest/contains/getAttribute) ----
// describeTarget (unlike resolveTarget's selector-only fast path) needs `el instanceof
// Element`, `.closest()`, `.contains()`, and `.getAttribute()` -- none of which the minimal
// makeEl()/append()/walkAll() stub above provides (it's deliberately minimal for the
// resolveTarget-only regression above, and is left untouched). This is additive,
// self-contained test-only infrastructure for describeTarget alone.

class FakeElement {
  constructor(tag, opts = {}) {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.id = opts.id || '';
    this._attrs = { ...(opts.attrs || {}) };
    this.children = [];
    this.parentElement = null;
  }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null; }
  contains(other) {
    let node = other;
    while (node) { if (node === this) return true; node = node.parentElement; }
    return false;
  }
  closest(selectorList) {
    const parts = selectorList.split(',').map((s) => s.trim());
    let node = this;
    while (node) {
      if (parts.some((p) => matchesSimpleSelector(node, p))) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function matchesSimpleSelector(node, sel) {
  const attrMatch = sel.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
  if (attrMatch) {
    const val = node.getAttribute(attrMatch[1]);
    if (val === null) return false;
    return attrMatch[2] === undefined ? true : val === attrMatch[2];
  }
  return node.tagName === sel.toUpperCase();
}

function loadEngineForDescribeTarget(document, groups = []) {
  const sandboxSelf = {};
  global.self = sandboxSelf;
  global.self.WebberExtractor = { current: () => ({ groups }) };
  global.document = document;
  global.Element = FakeElement;
  global.CSS = { escape: (s) => String(s) };
  delete require.cache[require.resolve(RULE_ENGINE_PATH)];
  require(RULE_ENGINE_PATH);
  return sandboxSelf.WebberRuleEngine;
}

function makeDescribeFixture() {
  const body = new FakeElement('body');
  const nav = body.appendChild(new FakeElement('nav'));
  const navChild = nav.appendChild(new FakeElement('span'));

  const searchDiv = body.appendChild(new FakeElement('div', { attrs: { role: 'search' } }));
  const searchChild = searchDiv.appendChild(new FakeElement('span'));

  const plainDiv = body.appendChild(new FakeElement('div')); // no id, no role, no landmark ancestor
  const plainChild = plainDiv.appendChild(new FakeElement('span'));

  const groupContainer = body.appendChild(new FakeElement('ul'));
  const item1 = groupContainer.appendChild(new FakeElement('li'));
  const item2 = groupContainer.appendChild(new FakeElement('li'));

  const document = { body, querySelectorAll: () => [] };
  return { document, body, navChild, searchChild, plainChild, item1, item2, groupContainer };
}

describe('content/rule-engine.js describeTarget(): non-fallback paths stay UNprefixed; only the last resort gets "selector:" (tester-added, dynamic)', () => {
  test('member of a repeating group -> "repeating items" (unprefixed)', () => {
    const fx = makeDescribeFixture();
    const groups = [{ elements: [fx.item1, fx.item2], container: fx.groupContainer }];
    const engine = loadEngineForDescribeTarget(fx.document, groups);
    const result = engine.describeTarget(fx.item1);
    assert.equal(result, 'repeating items');
    assert.ok(!result.startsWith('selector:'));
  });

  test('descendant of a <nav> landmark -> "navigation" (unprefixed)', () => {
    const fx = makeDescribeFixture();
    const engine = loadEngineForDescribeTarget(fx.document, []);
    const result = engine.describeTarget(fx.navChild);
    assert.equal(result, 'navigation');
    assert.ok(!result.startsWith('selector:'));
  });

  test('descendant of an explicit role="search" element (no landmark match) -> "role=search" (unprefixed)', () => {
    const fx = makeDescribeFixture();
    const engine = loadEngineForDescribeTarget(fx.document, []);
    const result = engine.describeTarget(fx.searchChild);
    assert.equal(result, 'role=search');
    assert.ok(!result.startsWith('selector:'));
  });

  test('element with no group/landmark/role match -> the last resort IS prefixed with "selector:"', () => {
    const fx = makeDescribeFixture();
    const engine = loadEngineForDescribeTarget(fx.document, []);
    const result = engine.describeTarget(fx.plainChild);
    assert.ok(result.startsWith('selector:'), `expected a "selector:" prefix, got: ${result}`);
    assert.notEqual(result, 'repeating items');
    assert.notEqual(result, 'navigation');
    assert.notEqual(result, 'sidebar');
    assert.notEqual(result, 'footer');
    assert.notEqual(result, 'article body');
  });
});
