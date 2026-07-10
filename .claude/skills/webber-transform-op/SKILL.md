---
name: webber-transform-op
description: Use when adding, modifying, or reviewing a DOM transform operation in content/rule-engine.js's ops object, or extending what the AI rule translator can express — covers target resolution, undo tracking, and wiring a new op into the schema/prompt/tool definition.
---

# Webber transform op pattern

`content/rule-engine.js` (`WebberRuleEngine`) is the deterministic executor
for page reshaping. The AI (in `background/service-worker.js`) never touches
the DOM directly — it only emits a JSON transform spec that this engine
applies. Every op must be safe to replay (saved rules re-run automatically on
revisit and after SPA mutations) and safe to revert (the command bar's "×"
button calls `revert`).

## Adding a new op

An op is a function `(target, params, undos) => count` added to the `ops`
object in `content/rule-engine.js`:

1. **Resolve the target semantically, don't guess DOM structure yourself.**
   Call `resolveTarget(target, params)` to get `{ elements, group }`. Never
   invent a fresh selector strategy inside the op — target resolution
   (ARIA role → landmark region → repeating-item group → tag pattern → literal
   CSS selector) lives in one place so every op targets consistently.
2. **Push an undo closure for every mutation**, even non-visual ones where
   feasible. Style changes: snapshot the previous value and restore it.
   Reordering: use `snapshotOrder(container)` before touching child order.
   New DOM nodes (badges, headers): keep a reference and `.remove()` them in
   the undo. `extract-to-panel` is the one exception — it sends data
   off-page and has nothing to visually undo.
3. **Mark anything you inject** with `dataset.webberUi = '1'` (and
   `dataset[MARK + 'Xxx']` for idempotency markers) so re-running the op is a
   no-op instead of double-applying, and so `WebberExtractor` /
   `MutationObserver` skip your own UI. Follow `highlight` and `annotate` as
   the reference implementations.
4. **Return the count of elements actually affected.** The caller
   (`WebberContent.runCommand` / `applyModeDefaults`) uses this to decide
   whether the rule "took" and whether to show the save prompt.
5. **Guard against missing groups.** Ops that need `group` (sort, reorder,
   group) must bail with `return 0` if `resolveTarget` didn't find one —
   don't throw.

## Wiring the op end-to-end

Adding an op to `ops` alone is not enough — it also has to be reachable by
the pieces that produce and validate transform specs:

- Add the op name to `WebberSchema.TRANSFORM_OPS` in `shared/schema.js`.
- Add it to the `op` enum in `APPLY_TRANSFORMS_TOOL.input_schema` in
  `background/service-worker.js`, and add a line to `SYSTEM_PROMPT` describing
  when the model should choose it (see the existing "If the user wants to see
  less: use hide" style bullets).
- If it's a mode-default candidate, consider adding it to the relevant
  `MODE_CONFIGS[mode].defaultTransforms` in `shared/schema.js`.

## Why it matters

The rule engine, the schema, and the system prompt have to agree on the exact
same op vocabulary or the model will emit an op the engine silently reports
as `{count: 0, error: 'unknown op'}` — a failure mode that looks like "nothing
matched" to the user instead of a clear bug. `webber-diagnosis` checks for
this three-way drift specifically.
