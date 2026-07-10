/**
 * Webber — floating command bar.
 * Injected into the page as a Shadow DOM overlay (open mode) so host page
 * styles can't touch it. Toggled by Ctrl/Cmd+Shift+W (via chrome.commands),
 * Alt+W fallback, or a message from the background worker.
 */

const WebberCommandBar = (() => {
  const Schema = self.WebberSchema;

  let host = null;       // host element in the page
  let root = null;       // shadow root
  let els = {};          // cached element refs
  let visible = false;
  let lastRuleName = null; // most recently applied rule (for "Save this view")

  // ---- Build / picker mode state ------------------------------------------
  let pickerActive = false;
  let hoverEl = null;    // element currently under the pointer
  let pickedEl = null;   // element the user clicked to build a rule for
  let paramsWrap = null; // container for the current op's param controls
  let paramEls = {};     // refs to the current op's live param controls

  // ---- construction -----------------------------------------------------

  async function build() {
    if (host) return;

    host = document.createElement('div');
    host.dataset.webberUi = '1';
    host.id = 'webber-command-bar-host';
    root = host.attachShadow({ mode: 'open' });

    // Load stylesheet from the extension bundle
    let css = '';
    try {
      const resp = await fetch(chrome.runtime.getURL('command-bar/command-bar.css'));
      css = await resp.text();
    } catch (e) { /* styles degrade gracefully */ }

    root.innerHTML = `
      <style>${css}</style>
      <div class="wb-overlay" role="dialog" aria-label="Webber command bar">
        <div class="wb-bar">
          <div class="wb-row">
            <span class="wb-mode" title="Click to switch mode" tabindex="0"></span>
            <input class="wb-input" type="text"
              placeholder="Ask Webber to reshape this page..." spellcheck="false" />
            <button class="wb-build" type="button" title="Build a rule by clicking the page">Build</button>
          </div>
          <div class="wb-chips"></div>
          <div class="wb-status"></div>
          <div class="wb-actions"></div>
          <div class="wb-builder"></div>
        </div>
      </div>`;

    els = {
      overlay: root.querySelector('.wb-overlay'),
      mode: root.querySelector('.wb-mode'),
      input: root.querySelector('.wb-input'),
      build: root.querySelector('.wb-build'),
      chips: root.querySelector('.wb-chips'),
      status: root.querySelector('.wb-status'),
      actions: root.querySelector('.wb-actions'),
      builder: root.querySelector('.wb-builder'),
    };

    // Hover outline: a direct child of the shadow root (sibling of
    // .wb-overlay), so .wb-overlay's transform never becomes its containing
    // block for position:fixed.
    els.outline = document.createElement('div');
    els.outline.className = 'wb-pick-outline';
    els.outline.hidden = true;
    root.appendChild(els.outline);

    els.mode.addEventListener('click', cycleMode);
    els.build.addEventListener('click', togglePicker);
    els.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && els.input.value.trim()) submit(els.input.value.trim());
      if (e.key === 'Escape') hide();
      e.stopPropagation();
    });

    document.documentElement.appendChild(host);
  }

  // ---- mode pill ----------------------------------------------------------

  function renderMode() {
    const state = self.WebberContent?.getState();
    const mode = state?.mode || 'generic';
    els.mode.textContent = Schema.MODE_CONFIGS[mode]?.label || mode;
  }

  function cycleMode() {
    const state = self.WebberContent?.getState();
    const modes = Schema.MODES;
    const next = modes[(modes.indexOf(state?.mode || 'generic') + 1) % modes.length];
    const result = self.WebberContent?.applyModeDefaults(next);
    renderMode();
    renderChips();
    if (result && result.applied > 0) {
      lastRuleName = result.ruleName;
      setStatus(`Applied: ${result.ruleName}`, 'ok');
      renderSaveButton();
    } else {
      setStatus(`Mode: ${Schema.MODE_CONFIGS[next].label}`, '');
    }
  }

  // ---- chips (active rules) --------------------------------------------------

  function renderChips() {
    const state = self.WebberContent?.getState();
    els.chips.textContent = '';
    for (const { ruleName, saved } of state?.activeRules || []) {
      const chip = document.createElement('span');
      chip.className = 'wb-chip';
      const label = document.createElement('span');
      label.textContent = ruleName;
      chip.appendChild(label);
      if (saved) {
        const mark = document.createElement('span');
        mark.className = 'wb-saved';
        mark.title = 'Saved rule';
        mark.textContent = '● saved';
        chip.appendChild(mark);
      }
      const x = document.createElement('button');
      x.textContent = '×';
      x.title = `Remove "${ruleName}" and revert its changes`;
      x.addEventListener('click', async () => {
        await self.WebberContent.removeRule(ruleName);
        if (lastRuleName === ruleName) { lastRuleName = null; els.actions.textContent = ''; }
        renderChips();
        setStatus(`Removed: ${ruleName}`, '');
      });
      chip.appendChild(x);
      els.chips.appendChild(chip);
    }
  }

  // ---- status & save flow -------------------------------------------------------

  function setStatus(text, kind) {
    els.status.className = `wb-status${kind ? ` wb-${kind}` : ''}`;
    els.status.textContent = text || '';
  }

  function setBusy(text) {
    els.status.className = 'wb-status';
    els.status.innerHTML = `<span class="wb-spinner"></span>`;
    els.status.appendChild(document.createTextNode(text));
  }

  function renderSaveButton() {
    els.actions.textContent = '';
    if (!lastRuleName) return;
    const btn = document.createElement('button');
    btn.className = 'wb-btn';
    btn.textContent = 'Save this view';
    btn.addEventListener('click', renderSavePrompt);
    els.actions.appendChild(btn);
  }

  function renderSavePrompt() {
    const state = self.WebberContent?.getState();
    const mode = state?.mode || 'generic';
    const modeLabel = Schema.MODE_CONFIGS[mode]?.label?.toLowerCase() || mode;

    els.actions.textContent = '';
    const prompt = document.createElement('div');
    prompt.className = 'wb-save-prompt';

    const q = document.createElement('div');
    q.className = 'wb-q';
    q.textContent = `Apply to this site only, or all ${modeLabel} pages?`;
    prompt.appendChild(q);

    const row = document.createElement('div');
    row.className = 'wb-row';

    const siteBtn = document.createElement('button');
    siteBtn.className = 'wb-btn';
    siteBtn.textContent = `This site only (${state?.domain || 'site'})`;
    siteBtn.addEventListener('click', () => doSave('domain'));

    const catBtn = document.createElement('button');
    catBtn.className = 'wb-btn wb-secondary';
    catBtn.textContent = `All ${modeLabel} pages`;
    catBtn.addEventListener('click', () => doSave('category'));

    row.appendChild(siteBtn);
    row.appendChild(catBtn);
    prompt.appendChild(row);
    els.actions.appendChild(prompt);
  }

  async function doSave(scope) {
    try {
      await self.WebberContent.saveRule(lastRuleName, scope);
      els.actions.textContent = '';
      setStatus(scope === 'domain'
        ? 'Saved — will re-apply automatically on this site.'
        : 'Saved — will re-apply on all pages of this type.', 'ok');
      renderChips();
    } catch (e) {
      setStatus(`Could not save: ${e.message}`, 'err');
    }
  }

  // ---- Build / picker mode -----------------------------------------------------

  function togglePicker() {
    if (pickerActive) { exitPicker(); setStatus('Build mode off.', ''); }
    else enterPicker();
  }

  function enterPicker() {
    pickerActive = true;
    els.build.classList.add('wb-active');
    setStatus('Build mode — hover, then click an element. Esc to cancel.', '');
    // all capture-phase, on document, so we intercept before the page:
    document.addEventListener('mousemove', onPickMove, true);
    document.addEventListener('mousedown', onPickDown, true);
    document.addEventListener('click', onPickClick, true);
    document.addEventListener('keydown', onPickKey, true);
  }

  function exitPicker() {
    pickerActive = false;
    els.build.classList.remove('wb-active');
    els.outline.hidden = true;
    els.builder.textContent = '';
    hoverEl = null; pickedEl = null;
    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('mousedown', onPickDown, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('keydown', onPickKey, true);
  }

  function onPickMove(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host || el.closest?.('[data-webber-ui]')) {
      els.outline.hidden = true;
      hoverEl = null;
      return;
    }
    hoverEl = el;
    const r = el.getBoundingClientRect();
    els.outline.style.left = `${r.left}px`;
    els.outline.style.top = `${r.top}px`;
    els.outline.style.width = `${r.width}px`;
    els.outline.style.height = `${r.height}px`;
    els.outline.hidden = false;
  }

  function onPickDown(e) {
    if (e.composedPath().includes(host)) return; // let clicks on our own shadow UI work normally
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onPickClick(e) {
    if (e.composedPath().includes(host)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (hoverEl) {
      pickedEl = hoverEl;
      els.outline.hidden = true;
      openPalette(pickedEl);
    }
  }

  function onPickKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      exitPicker();
      setStatus('Build cancelled.', '');
    }
  }

  // ---- op palette + params ------------------------------------------------------

  const OP_LABELS = [
    ['hide', 'Hide'],
    ['highlight', 'Highlight'],
    ['sort', 'Sort'],
    ['group', 'Group'],
    ['annotate', 'Annotate'],
    ['extract-to-panel', 'Extract to panel'],
  ];
  const CONDITION_OPS = ['equals', 'contains', 'lt', 'gt', 'exists', 'missing'];

  function openPalette(el) {
    const target = self.WebberRuleEngine.describeTarget(el);
    const { group } = self.WebberRuleEngine.resolveTarget(target);
    const sample = el.__webberFields
      || (group && group.elements[0] && group.elements[0].__webberFields)
      || {};
    const fieldKeys = Object.keys(sample); // do NOT hardcode a field list

    els.builder.textContent = '';

    const targetLine = document.createElement('div');
    targetLine.className = 'wb-target-line';
    targetLine.textContent = `Target: ${target}`;
    els.builder.appendChild(targetLine);

    const opRow = document.createElement('div');
    opRow.className = 'wb-op-row';
    els.builder.appendChild(opRow);

    paramsWrap = document.createElement('div');
    paramsWrap.className = 'wb-params-wrap';
    els.builder.appendChild(paramsWrap);

    for (const [opId, label] of OP_LABELS) {
      const btn = document.createElement('button');
      btn.className = 'wb-op-btn';
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', () => {
        for (const b of opRow.children) b.classList.remove('wb-active');
        btn.classList.add('wb-active');
        selectOp(opId, label, target, fieldKeys);
      });
      opRow.appendChild(btn);
    }
  }

  /** Render op-appropriate param controls + a ruleName input + a Confirm button. */
  function selectOp(opId, label, target, fieldKeys) {
    paramsWrap.textContent = '';
    paramEls = {};

    if ((opId === 'hide' || opId === 'highlight') && fieldKeys.length) {
      const row = document.createElement('div');
      row.className = 'wb-params';

      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = 'if';
      const fieldSelect = document.createElement('select');
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(no condition)';
      fieldSelect.appendChild(noneOpt);
      for (const f of fieldKeys) {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        fieldSelect.appendChild(opt);
      }
      fieldLabel.appendChild(fieldSelect);
      row.appendChild(fieldLabel);

      const opLabel = document.createElement('label');
      opLabel.textContent = 'is';
      const opSelect = document.createElement('select');
      for (const o of CONDITION_OPS) {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = o;
        opSelect.appendChild(opt);
      }
      opLabel.appendChild(opSelect);
      row.appendChild(opLabel);

      const valueLabel = document.createElement('label');
      valueLabel.textContent = 'value';
      const valueInput = document.createElement('input');
      valueInput.type = 'text';
      valueLabel.appendChild(valueInput);
      row.appendChild(valueLabel);

      // exists/missing need no value input
      opSelect.addEventListener('change', () => {
        valueInput.hidden = opSelect.value === 'exists' || opSelect.value === 'missing';
      });

      paramsWrap.appendChild(row);
      paramEls.fieldSelect = fieldSelect;
      paramEls.opSelect = opSelect;
      paramEls.valueInput = valueInput;
    } else if (opId === 'sort' && fieldKeys.length) {
      const row = document.createElement('div');
      row.className = 'wb-params';

      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = 'by';
      const fieldSelect = document.createElement('select');
      for (const f of fieldKeys) {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        fieldSelect.appendChild(opt);
      }
      fieldLabel.appendChild(fieldSelect);
      row.appendChild(fieldLabel);

      const dirLabel = document.createElement('label');
      dirLabel.textContent = 'direction';
      const dirSelect = document.createElement('select');
      for (const d of ['asc', 'desc']) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        dirSelect.appendChild(opt);
      }
      dirLabel.appendChild(dirSelect);
      row.appendChild(dirLabel);

      paramsWrap.appendChild(row);
      paramEls.fieldSelect = fieldSelect;
      paramEls.directionSelect = dirSelect;
    } else if (opId === 'group' && fieldKeys.length) {
      const row = document.createElement('div');
      row.className = 'wb-params';

      const fieldLabel = document.createElement('label');
      fieldLabel.textContent = 'by';
      const fieldSelect = document.createElement('select');
      for (const f of fieldKeys) {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        fieldSelect.appendChild(opt);
      }
      fieldLabel.appendChild(fieldSelect);
      row.appendChild(fieldLabel);

      paramsWrap.appendChild(row);
      paramEls.fieldSelect = fieldSelect;
    } else if (opId === 'annotate') {
      const row = document.createElement('div');
      row.className = 'wb-params';

      const textLabel = document.createElement('label');
      textLabel.textContent = 'text';
      const textInput = document.createElement('input');
      textInput.type = 'text';
      textInput.placeholder = '●';
      textLabel.appendChild(textInput);
      row.appendChild(textLabel);

      paramsWrap.appendChild(row);
      paramEls.textInput = textInput;
    } else if (opId === 'extract-to-panel' && fieldKeys.length) {
      const row = document.createElement('div');
      row.className = 'wb-params';

      const checkboxes = [];
      for (const f of fieldKeys) {
        const cbLabel = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.field = f;
        cbLabel.appendChild(cb);
        cbLabel.appendChild(document.createTextNode(f));
        row.appendChild(cbLabel);
        checkboxes.push(cb);
      }
      paramsWrap.appendChild(row);
      paramEls.checkboxes = checkboxes;
    }
    // else: no fieldKeys for a field-dependent op (landmark/role/selector target) —
    // controls are simply omitted; the op will resolve to 0 elements on Confirm,
    // same as the equivalent typed command.

    const nameRow = document.createElement('div');
    nameRow.className = 'wb-name-row';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = `${label} ${target}`;
    nameRow.appendChild(nameInput);
    paramsWrap.appendChild(nameRow);
    paramEls.nameInput = nameInput;

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'wb-btn';
    confirmBtn.type = 'button';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => onConfirm(opId, label, target));
    paramsWrap.appendChild(confirmBtn);
  }

  /** Read the current op's params from its live controls (see selectOp). */
  function readParams(opId) {
    switch (opId) {
      case 'hide':
      case 'highlight': {
        if (!paramEls.fieldSelect) return {};
        const field = paramEls.fieldSelect.value;
        if (!field) return {};
        const op = paramEls.opSelect.value;
        if (op === 'exists' || op === 'missing') return { condition: { field, op } };
        return { condition: { field, op, value: paramEls.valueInput.value } };
      }
      case 'sort':
        if (!paramEls.fieldSelect) return {};
        return { by: paramEls.fieldSelect.value, direction: paramEls.directionSelect.value };
      case 'group':
        if (!paramEls.fieldSelect) return {};
        return { by: paramEls.fieldSelect.value };
      case 'annotate':
        return { text: (paramEls.textInput?.value || '').trim() || '●' };
      case 'extract-to-panel':
        return { fields: (paramEls.checkboxes || []).filter((cb) => cb.checked).map((cb) => cb.dataset.field) };
      default:
        return {};
    }
  }

  async function onConfirm(opId, label, target) {
    const params = readParams(opId);
    const ruleName = paramEls.nameInput.value.trim() || `${label} ${target}`;
    const transforms = [{ op: opId, target, params }];
    const result = await self.WebberContent.applyBuiltRule(ruleName, transforms);
    renderMode();
    renderChips();
    if (result.applied > 0) {
      lastRuleName = ruleName;
      setStatus(`Applied: ${ruleName}`, 'ok');
      renderSaveButton();                                  // existing Save flow, unchanged
    } else {
      setStatus('Built the rule, but nothing on this page matched its target.', 'err');
    }
    exitPicker();                                          // clears builder UI + listeners; leaves status/actions intact
  }

  // ---- submit -----------------------------------------------------------------

  async function submit(commandText) {
    els.input.disabled = true;
    els.actions.textContent = '';
    setBusy(' Translating command…');
    try {
      const result = await self.WebberContent.runCommand(commandText);
      lastRuleName = result.ruleName;
      renderMode();
      renderChips();
      if (result.applied > 0) {
        const conf = typeof result.confidence === 'number'
          ? ` (${Math.round(result.confidence * 100)}%)` : '';
        setStatus(`Applied: ${result.ruleName}${conf}`, 'ok');
        renderSaveButton();
        els.input.value = '';
      } else {
        setStatus('Understood the command, but nothing on this page matched its targets.', 'err');
      }
    } catch (e) {
      setStatus(`Error: ${String(e.message || e)}`, 'err');
    } finally {
      els.input.disabled = false;
      els.input.focus();
    }
  }

  // ---- show / hide ----------------------------------------------------------------

  async function show() {
    await build();
    host.style.display = '';
    visible = true;
    renderMode();
    renderChips();
    els.input.focus();
  }

  function hide() {
    if (pickerActive) exitPicker();
    if (host) host.style.display = 'none';
    visible = false;
  }

  function toggle() {
    if (visible) hide(); else show();
  }

  return { show, hide, toggle };
})();

self.WebberCommandBar = WebberCommandBar;
