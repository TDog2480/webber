/**
 * Webber — side panel (workflow board).
 * Tabs: Board (live comparison table fed by extract-to-panel), Rules (saved
 * rule sets grouped by domain/category), History (last 20 Webber-active pages).
 */

(() => {
  const Schema = self.WebberSchema;
  const Storage = self.WebberStorage;

  const $ = (id) => document.getElementById(id);

  let boardSort = { column: null, direction: 'asc' };

  // ---- onboarding / main switch ------------------------------------------

  async function initViews() {
    const key = await Storage.getApiKey();
    $('onboarding').hidden = !!key;
    $('main').hidden = !key;
    if (key) refreshAll();
  }

  $('api-key-save').addEventListener('click', async () => {
    const value = $('api-key-input').value.trim();
    if (!value) {
      $('onboard-status').textContent = 'Enter a key first.';
      return;
    }
    await Storage.setApiKey(value);
    $('api-key-input').value = '';
    initViews();
  });

  $('change-key').addEventListener('click', async () => {
    $('main').hidden = true;
    $('onboarding').hidden = false;
  });

  // ---- tabs -----------------------------------------------------------------

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
      for (const panel of document.querySelectorAll('.tab-panel')) {
        panel.hidden = panel.id !== `tab-${tab.dataset.tab}`;
      }
    });
  }

  // ---- board ------------------------------------------------------------------

  function boardColumns(items) {
    if (!items.length) return [];
    // Columns come from the first item's fields (spec), with 'link' rendered
    // inside the title cell rather than as its own column.
    const first = Object.keys(items[0].fields).filter((k) => k !== 'link');
    // include any extra keys later items introduce, appended after
    const extra = new Set();
    for (const it of items.slice(1)) {
      for (const k of Object.keys(it.fields)) {
        if (k !== 'link' && !first.includes(k)) extra.add(k);
      }
    }
    return [...first, ...extra];
  }

  function sortedItems(items) {
    if (!boardSort.column) return items;
    const dir = boardSort.direction === 'desc' ? -1 : 1;
    const col = boardSort.column;
    return [...items].sort((a, b) => {
      const va = a.fields[col];
      const vb = b.fields[col];
      if (va === undefined && vb === undefined) return 0;
      if (va === undefined) return 1;
      if (vb === undefined) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
      return String(va).localeCompare(String(vb)) * dir;
    });
  }

  async function renderBoard() {
    const board = await Storage.getBoard();
    const items = board.items || [];
    $('board-count').textContent = items.length
      ? `${items.length} item${items.length === 1 ? '' : 's'}` : '';
    $('board-empty').hidden = items.length > 0;
    $('board-table').hidden = items.length === 0;
    if (!items.length) return;

    const columns = boardColumns(items);

    const head = $('board-head');
    head.textContent = '';
    const srcTh = document.createElement('th');
    srcTh.textContent = 'source';
    srcTh.addEventListener('click', () => toggleSort('__domain'));
    head.appendChild(srcTh);
    for (const col of columns) {
      const th = document.createElement('th');
      th.textContent = col;
      if (boardSort.column === col) {
        const arrow = document.createElement('span');
        arrow.className = 'sort-arrow';
        arrow.textContent = boardSort.direction === 'asc' ? '▲' : '▼';
        th.appendChild(arrow);
      }
      th.addEventListener('click', () => toggleSort(col));
      head.appendChild(th);
    }
    head.appendChild(document.createElement('th')); // delete column

    const body = $('board-body');
    body.textContent = '';
    const rows = boardSort.column === '__domain'
      ? [...items].sort((a, b) => a.domain.localeCompare(b.domain) * (boardSort.direction === 'desc' ? -1 : 1))
      : sortedItems(items);

    for (const item of rows) {
      const tr = document.createElement('tr');

      const src = document.createElement('td');
      src.textContent = item.domain;
      src.title = item.domain;
      tr.appendChild(src);

      for (const col of columns) {
        const td = document.createElement('td');
        const value = item.fields[col];
        if (col === 'title' && item.fields.link) {
          const a = document.createElement('a');
          a.href = item.fields.link;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = value ?? item.fields.link;
          td.appendChild(a);
        } else {
          td.textContent = value === undefined ? '—' : String(value);
        }
        td.title = value === undefined ? '' : String(value);
        tr.appendChild(td);
      }

      const del = document.createElement('td');
      const btn = document.createElement('button');
      btn.className = 'btn-tiny';
      btn.textContent = '×';
      btn.title = 'Remove row';
      btn.addEventListener('click', async () => {
        await Storage.removeBoardItem(item.id);
        renderBoard();
      });
      del.appendChild(btn);
      tr.appendChild(del);

      body.appendChild(tr);
    }
  }

  function toggleSort(column) {
    if (boardSort.column === column) {
      boardSort.direction = boardSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      boardSort = { column, direction: 'asc' };
    }
    renderBoard();
  }

  $('board-clear').addEventListener('click', async () => {
    await Storage.clearBoard();
    boardSort = { column: null, direction: 'asc' };
    renderBoard();
  });

  // ---- rules --------------------------------------------------------------------

  function describeKey(storageKey) {
    if (storageKey.startsWith('rules:category:')) {
      return `All ${storageKey.slice('rules:category:'.length)} pages`;
    }
    return storageKey.slice('rules:'.length);
  }

  async function renderRules() {
    const all = await Storage.getAllRules();
    const keys = Object.keys(all).sort();
    $('rules-empty').hidden = keys.length > 0;
    const list = $('rules-list');
    list.textContent = '';

    for (const key of keys) {
      const group = document.createElement('div');
      group.className = 'rule-group';
      const h = document.createElement('h2');
      h.textContent = describeKey(key);
      group.appendChild(h);

      for (const rule of all[key]) {
        const row = document.createElement('div');
        row.className = 'rule-item';

        const info = document.createElement('div');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = rule.ruleName;
        info.appendChild(name);
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `applied ×${rule.applyCount || 0}`;
        info.appendChild(badge);
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = `${rule.mode || 'generic'} · ${rule.transforms.length} transform${rule.transforms.length === 1 ? '' : 's'} · ${new Date(rule.createdAt).toLocaleDateString()}`;
        info.appendChild(meta);
        row.appendChild(info);

        const del = document.createElement('button');
        del.className = 'btn-tiny';
        del.textContent = '×';
        del.title = 'Delete rule';
        del.addEventListener('click', async () => {
          await Storage.deleteRule(key, rule.ruleName);
          renderRules();
        });
        row.appendChild(del);

        group.appendChild(row);
      }
      list.appendChild(group);
    }
  }

  // ---- history -------------------------------------------------------------------

  async function renderHistory() {
    const history = await Storage.getHistory();
    $('history-empty').hidden = history.length > 0;
    const list = $('history-list');
    list.textContent = '';
    for (const entry of history) {
      const li = document.createElement('li');
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = entry.pageTitle || entry.domain;
      li.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'meta';
      const rules = entry.rulesApplied?.length
        ? ` · rules: ${entry.rulesApplied.join(', ')}`
        : ' · no rules applied';
      meta.textContent = `${entry.domain} · ${entry.pageType} · ${new Date(entry.ts).toLocaleTimeString()}${rules}`;
      li.appendChild(meta);
      list.appendChild(li);
    }
  }

  // ---- live updates -----------------------------------------------------------------

  function refreshAll() {
    renderBoard();
    renderRules();
    renderHistory();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === Schema.msg.BOARD_UPDATED) renderBoard();
    if (message?.type === Schema.msg.RULES_CHANGED) renderRules();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[Schema.keys.board]) renderBoard();
    if (area === 'local') {
      if (changes[Schema.keys.history]) renderHistory();
      if (Object.keys(changes).some((k) => k.startsWith('rules:'))) renderRules();
    }
  });

  initViews();
})();
