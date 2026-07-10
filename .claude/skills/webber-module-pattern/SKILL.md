---
name: webber-module-pattern
description: Use when creating a new file under shared/, content/, background/, command-bar/, or sidepanel/, or adding a new top-level module to an existing file — enforces Webber's IIFE + self-attach module pattern and manifest.json load-order wiring.
---

# Webber module pattern

Webber is a Manifest V3 Chrome extension. Content scripts, the background
service worker, and the side panel do **not** use ES modules — content
scripts execute in a shared global scope per the `js` array order in
`manifest.json`, and the service worker uses `importScripts`. Modules
communicate through the shared global object (`self`), not `import`/`export`.

## The pattern

Every module follows this shape, matching `shared/schema.js`, `shared/storage.js`,
`content/extractor.js`, `content/rule-engine.js`, and `command-bar/command-bar.js`:

```js
/**
 * Webber — <one-line purpose>.
 * <2-4 lines of context: what this owns, what it doesn't, key invariants.>
 */

const WebberX = (() => {
  // private state and helpers here

  return { publicMethod1, publicMethod2 };
})();

self.WebberX = WebberX;
```

Rules:
- Name the module `Webber<Noun>` (WebberSchema, WebberStorage, WebberExtractor,
  WebberRuleEngine, WebberContent, WebberCommandBar).
- Keep all private state inside the closure. Only expose what other modules
  actually call.
- Attach to `self` (works in both window and service-worker contexts) — never
  `window` directly, never a bare global `const` without the `self.` assignment.
- Reference other modules via `self.WebberX`, not a bare `WebberX` — this keeps
  every cross-module dependency visible at the call site and avoids relying on
  script-load order for lexical scoping.

## Wiring a new file into the extension

A new module file is inert until it's registered in `manifest.json`:

- **Content-script modules** go in the `content_scripts[0].js` array. Order
  matters — a module can only reference `self.WebberX` from a module that
  loaded earlier in the array. Current order: `shared/schema.js` →
  `shared/storage.js` → `content/extractor.js` → `content/rule-engine.js` →
  `command-bar/command-bar.js` → `content/content.js`. Insert new modules at
  the point that satisfies their dependencies.
- **Background-only modules** go in `background/service-worker.js`'s
  `importScripts(...)` call, same ordering rule.
- **Side panel modules** get a `<script>` tag in `sidepanel/panel.html`, in
  order, before `sidepanel/panel.js`.
- If a page injects DOM it owns (badges, headers, the command bar host), mark
  the root with `dataset.webberUi = '1'` so `WebberExtractor`'s repeating-group
  scan and `WebberRuleEngine`'s MutationObserver both skip it. See
  `content/extractor.js` (`findRepeatingGroups`, `el.closest('[data-webber-ui]')`)
  and `content/rule-engine.js` (`ensureObserver`).

## Why it matters

Because these aren't ES modules, a misordered `manifest.json` entry fails
silently at runtime (`self.WebberX is undefined`) rather than at build time —
there's no bundler to catch it. Keeping every module in this exact shape also
means `webber-diagnosis` can reliably flag anything that deviates (a stray
`window.` assignment, a module missing from the manifest, DOM injected without
the `data-webber-ui` marker).
