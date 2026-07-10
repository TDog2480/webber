---
name: webber-storage-key
description: Use when adding any new persisted state — a new chrome.storage.local or chrome.storage.session key — covers key naming in shared/schema.js, typed accessors in shared/storage.js, and local-vs-session choice.
---

# Webber storage key pattern

All `chrome.storage` access is centralized in `shared/storage.js`
(`WebberStorage`). No other file should call `chrome.storage.local` or
`chrome.storage.session` directly — content scripts, the background worker,
and the side panel all go through `WebberStorage`'s typed helpers.

## Adding a new persisted key

1. **Name the key in `WebberSchema.keys`** (`shared/schema.js`), not as an
   inline string anywhere else. Static keys are plain strings
   (`apiKey: 'webber:apiKey'`); parameterized keys are functions
   (`rulesForDomain: (domain) => \`rules:${domain}\``), following the existing
   `webber:` / `rules:` prefixing convention so keys stay greppable and
   collision-free.
2. **Add typed get/set functions in `WebberStorage`**, not a raw
   `chrome.storage.local.get(key)` call at the use site. Follow the existing
   shape: an async function per key (or key family) that defaults to a sane
   empty value (`null`, `[]`, `{ items: [] }`) when the key is unset, using
   the `localGet(key, fallback)` helper.
3. **Choose local vs. session deliberately.** `chrome.storage.local` is for
   state that should survive browser restarts (API key, saved rules, visit
   history — capped and pruned, e.g. history keeps only the last 20).
   `chrome.storage.session` is for state scoped to the current browser
   session that should reset on browser close (the workflow board). Match
   existing precedent rather than defaulting to local for everything.
4. **If content scripts need to read/write a session key**, remember
   `chrome.storage.session` is background-only by default — the access level
   is opened up once in `background/service-worker.js`'s `onInstalled`
   (`setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })`). You
   shouldn't need to touch this for a new key under the existing `board` key,
   but a *new top-level* session key needs no extra wiring beyond using
   `WebberStorage` — the access level is extension-wide, not per-key.
5. **Update the layout comment block** at the top of `shared/storage.js`
   (`Layout (chrome.storage.local): ...` / `Layout (chrome.storage.session): ...`)
   so the key inventory stays a reliable at-a-glance reference.

## Why it matters

`chrome.storage.local.get(null)` (used by `getAllRules`) returns every key in
the extension's storage — an inline string key that skips
`WebberSchema.keys` is invisible to anything that greps for `K.` usage and
easy to typo into a silent no-op read. Centralizing access also means a
future migration (e.g. renaming a key, changing a default) is a one-file
change instead of a repo-wide find-and-replace.
