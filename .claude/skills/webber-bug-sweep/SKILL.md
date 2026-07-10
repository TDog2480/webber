---
name: webber-bug-sweep
description: Use when asked to "sweep the bug list", "fix open bugs", "go through Notion bugs", or similar — works through the Bugs / Issues Notion database and fixes what it safely can in this repo. Requires the Notion MCP server connected.
---

# Webber bug sweep

Connects directly to the Webber Notion workspace via MCP. Pulls all entries
from the **Bugs / Issues** database with Status `Open` or `In Progress`, and
works through them one by one:

- **If a bug has enough detail to act on, fix it** — applying whichever of
  [[webber-module-pattern]], [[webber-transform-op]],
  [[webber-messaging-contract]], or [[webber-storage-key]] is relevant to
  whatever's being touched, so the fix matches the rest of the codebase
  instead of introducing a one-off pattern.
- **If a bug is too vague to act on safely, don't guess.** Leave a comment on
  the Notion entry asking for the missing detail (repro steps, expected vs.
  actual, which page/domain it happened on) instead of making an assumption
  that might be wrong.
- **After each fix, update the Notion entry immediately**: Status → `Fixed`,
  plus a note on what changed and which files were touched. Don't batch
  updates to the end — keep Notion in sync entry by entry.
- **Log any new bugs noticed along the way** into the same database (same
  Area/Priority conventions as [[webber-diagnosis]]), rather than silently
  fixing scope creep or silently ignoring it.
- **At the end, summarize**: what got fixed, what got skipped and why (too
  vague, out of scope, needs a product decision), and any new bugs logged.

## Requires

The Notion MCP server connected to Claude Code (`claude mcp list` should show
`notion` as connected — set up via `/mcp` → Authorize). Won't push fixes to
GitHub without confirmation, per normal workflow — commits/pushes still go
through the usual approval flow.

## Why it matters

This is the closest thing to "point Claude Code at the bug list and let it
go" — it reads Notion, fixes what it safely can in this single-repo
extension, and keeps Notion in sync the whole time so the current state of
the backlog is always visible without cross-checking against the code.
