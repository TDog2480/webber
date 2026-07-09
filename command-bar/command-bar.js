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
          </div>
          <div class="wb-chips"></div>
          <div class="wb-status"></div>
          <div class="wb-actions"></div>
        </div>
      </div>`;

    els = {
      overlay: root.querySelector('.wb-overlay'),
      mode: root.querySelector('.wb-mode'),
      input: root.querySelector('.wb-input'),
      chips: root.querySelector('.wb-chips'),
      status: root.querySelector('.wb-status'),
      actions: root.querySelector('.wb-actions'),
    };

    els.mode.addEventListener('click', cycleMode);
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
      const msg = String(e.message || e);
      if (/api key/i.test(msg)) {
        setStatus('No API key set. Open the Webber side panel (toolbar icon) to add one.', 'err');
      } else {
        setStatus(`Error: ${msg}`, 'err');
      }
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
    if (host) host.style.display = 'none';
    visible = false;
  }

  function toggle() {
    if (visible) hide(); else show();
  }

  return { show, hide, toggle };
})();

self.WebberCommandBar = WebberCommandBar;
