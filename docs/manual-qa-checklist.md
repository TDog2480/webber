# Webber — manual QA checklist (Phase 2)

Not run in CI — requires a real Chrome and a running/deployed backend.

- [ ] Load unpacked. Side panel opens straight to Board/Rules/History/Settings (no key prompt).
- [ ] Settings tab: set Backend URL + Shared secret, Save, see "Saved."
- [ ] Toggle Build mode (Ctrl/Cmd+Shift+W or Alt+W). Hover: dashed outline follows the cursor and never outlines Webber's own command-bar UI.
- [ ] Click an item in a repeating group → the resolved target reads "repeating items", not a raw selector.
- [ ] Build a Hide rule with a condition → only matching items disappear; a chip appears; the chip's × reverts.
- [ ] Click a non-repeating, non-landmark element that hits the new `selector:` fallback — ideally with an UNRELATED `<form>` elsewhere on the page → only the clicked element is affected (manual confirmation of the N1 fix).
- [ ] Save the rule (domain scope), reload the page, confirm it auto-reapplies.
- [ ] Repeat one pass each for Sort, Group, and Extract-to-panel so all six ops (Hide, Highlight, Sort, Group, Annotate, Extract-to-panel) get one manual pass.
- [ ] With the backend deployed, run a real command through the command bar and confirm a rule is applied (exercises the authed /translate round-trip).
