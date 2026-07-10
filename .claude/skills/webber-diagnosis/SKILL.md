---
name: webber-diagnosis
description: Use when asked to "run diagnosis", "scan for bugs", "audit the codebase", or similar — also runs automatically as a lightweight check after any other coding task in this repo, on just the files it touched. Requires the Notion MCP server connected.
---

# Webber diagnosis

Two modes: a full scan you trigger explicitly, and a lightweight scan that
runs quietly after every other task.

## Full scan

Triggered by: "run diagnosis", "scan for bugs", "audit the codebase", or
equivalent.

Read through `manifest.json`, `shared/`, `content/`, `background/`,
`command-bar/`, and `sidepanel/` looking for three categories of issue:

**1. Code-level issues**
- Missing error handling around `chrome.*` API calls that can reject (most
  should already be `.catch(() => {})`-guarded per
  [[webber-messaging-contract]] — flag ones that aren't and aren't
  intentionally left to surface).
- Logic bugs in target resolution, field extraction regexes, or the
  sort/compare helpers (e.g. `compareBy`, `matchesCondition`).
- Unbounded work over the live DOM — `content/extractor.js` intentionally
  caps everything (`MAX_ITEMS`, `MAX_FIELD_LEN`, the `kept.length >= 3` group
  cap, the `landmarks.length >= 20` cap); flag any new scan that walks
  `document.querySelectorAll('body *')` or similar without a cap.
- Race conditions around `WebberRuleEngine`'s `applying` re-entrancy flag and
  the `MutationObserver` debounce — a new op or storage write that mutates
  the DOM outside of `ops.*` without checking/setting `applying` can trigger
  an infinite re-apply loop.

**2. Convention violations against the other webber-\* skills**
- New module not following [[webber-module-pattern]] (no `self.WebberX`
  attach, missing from `manifest.json`'s load order, injected DOM missing
  `dataset.webberUi`).
- New transform op not fully wired per [[webber-transform-op]] (present in
  `ops` but missing from `TRANSFORM_OPS`, the tool schema enum, or the system
  prompt — or vice versa, an op the model can request that the engine doesn't
  implement).
- Message type used as a raw string instead of a `Schema.msg` constant, or an
  async `onMessage` handler missing `return true` — see
  [[webber-messaging-contract]].
- Storage key inlined instead of going through `WebberSchema.keys` +
  `WebberStorage` — see [[webber-storage-key]].
- Anthropic API calls or the API key touched outside
  `background/service-worker.js` (the key must never reach a content script
  or the side panel).

**3. Stale markers**
- TODOs, FIXMEs, `console.log` left over from debugging (`console.error` /
  intentional `[Webber]`-prefixed logs are fine — the codebase uses
  `console.log('[Webber] page schema', ...)` deliberately), commented-out
  code, stub/not-implemented functions.

### Logging findings

Every finding becomes a new entry in the **Bugs / Issues** Notion database:
Status `Open`, Area set to the module it's in (`Content Script`,
`Background/API`, `Side Panel`, `Command Bar`, `Storage/Schema`, `Other`),
Priority by severity, with a file:line reference and enough detail for
`webber-bug-sweep` to act on directly without re-deriving context. Check for
an existing open entry describing the same issue before creating a duplicate.

Also **sanity-check existing entries**: spot-check that bugs marked `Fixed`
actually got fixed, and flag old `Open` entries that look resolved by recent
changes. Only *comment* on these — don't change Status yourself; that's for
a human or `webber-bug-sweep`.

## Lightweight mode (automatic)

After any other coding task in this repo finishes, run a quick "did I leave
a mess" check limited to the files just touched — same three categories
above, scoped down. Trivial in-scope issues (an unused import, a stray
`console.log`, a missed `Schema.msg` constant) get fixed immediately as part
of the task. Anything out of scope, or anything that needs a design decision,
gets logged to Notion the same way as the full scan. If nothing's found,
stay silent — no noise.

## Requires

The Notion MCP server connected (`claude mcp list` should show `notion`).

## Why it matters

This is what *feeds* `webber-bug-sweep` — together they form a loop:
diagnosis finds and logs issues (including ones introduced moments ago by the
lightweight mode), bug-sweep works through the backlog and updates Notion as
it fixes things. Run diagnosis periodically (or let the lightweight mode run
continuously) and bug-sweep whenever you want to clear the list.
