---
name: webber-messaging-contract
description: Use when adding or changing any chrome.runtime.sendMessage/onMessage traffic between the content script, background service worker, and side panel — covers message-type constants, async response shape, and live-refresh events.
---

# Webber messaging contract

Content scripts, the background service worker, and the side panel are
separate execution contexts that only talk to each other through
`chrome.runtime.sendMessage` / `chrome.runtime.onMessage` (and, for the
active-tab keyboard shortcut, `chrome.tabs.sendMessage`). The background
worker is the only context with the Anthropic API key — it must stay the
sole place that calls the API.

## Adding a new message type

1. **Register the type as a constant** in `WebberSchema.msg` (`shared/schema.js`).
   Never pass a raw string literal as `message.type` — every existing type
   (`TRANSLATE`, `BOARD_ADD`, `BOARD_UPDATED`, `PAGE_VISIT`, `OPEN_PANEL`,
   `TOGGLE_COMMAND_BAR`, `RULES_CHANGED`) is a `Schema.msg.X` constant so a
   typo becomes a missing case, not a silently-ignored message.
2. **Handle it in `background/service-worker.js`'s `chrome.runtime.onMessage`
   switch** if the background needs to act on it. If the handler is async,
   `return true` from the listener (not just the case) so `sendResponse` stays
   valid after the listener function returns — see the `TRANSLATE` case.
   Respond with `{ ok: true, ...result }` or `{ ok: false, error: String(e.message || e) }`,
   matching every existing handler.
3. **Wrap sender-side calls in `.catch(() => {})`** when the receiving context
   might not have a listener attached (e.g. content script → background on
   page visit; background → content script when the tab isn't Webber-aware
   yet). Don't let a missing listener throw and break the caller's flow.
4. **Pair state changes with a "changed" broadcast.** If the message causes
   persisted state to change that the side panel displays, fire a follow-up
   broadcast message (`BOARD_UPDATED`, `RULES_CHANGED`) so
   `sidepanel/panel.js`'s `chrome.runtime.onMessage` listener can re-render
   without polling. For `chrome.storage.local`/`.session` writes, also check
   whether `chrome.storage.onChanged` already covers it before adding a
   redundant broadcast (see `sidepanel/panel.js`'s dual listeners on
   `board`/`rules:*`/`history`).

## Why it matters

There's no request/response framework here — just raw message passing — so
an unhandled message type, a missing `return true`, or a broadcast that never
fires shows up as a UI that silently doesn't update rather than a thrown
error. `webber-diagnosis` checks for message types used but not present in
`Schema.msg`, and for `onMessage` cases missing `return true` on an async path.
