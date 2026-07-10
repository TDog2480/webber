/**
 * Webber — background service worker (Manifest V3).
 * Calls the Webber backend to translate commands (no API key lives in the
 * extension). Also brokers board data to the side panel, records history,
 * and relays the keyboard command to the active tab.
 */

importScripts('../shared/schema.js', '../shared/storage.js');

const Schema = self.WebberSchema;
const Storage = self.WebberStorage;

// Webber backend endpoint. For local dev use http://localhost:3000/translate;
// after deploying backend/, replace with https://<your-host>/translate.
const BACKEND_URL = 'http://localhost:3000/translate';

// ---- setup ------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  // Let content scripts read/write chrome.storage.session (board data).
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
    .catch(() => {});
  // Clicking the toolbar icon opens the side panel.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  // Guarantee an installId exists from first launch.
  Storage.ensureInstallId().catch(() => {});
});

// Keyboard shortcut → toggle the command bar in the active tab.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-command-bar') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: Schema.msg.TOGGLE_COMMAND_BAR }).catch(() => {});
  }
});

// ---- AI rule translator --------------------------------------------------------

/** Compact the schema before sending — cap items and field sizes. */
function compactSchema(schema) {
  return {
    pageType: schema.pageType,
    pageTitle: schema.pageTitle,
    domain: schema.domain,
    landmarks: (schema.landmarks || []).slice(0, 12),
    repeatingItems: (schema.repeatingItems || []).slice(0, 12).map((item) => {
      const out = {};
      for (const [k, v] of Object.entries(item)) {
        out[k] = typeof v === 'string' ? v.slice(0, 120) : v;
      }
      return out;
    }),
    repeatingItemCount: (schema.repeatingItems || []).length,
  };
}

/**
 * Ask the Webber backend to translate a command into a transform spec.
 * The backend owns the Cerebras API key and the prompt/tool schema — this
 * is a thin client over POST {BACKEND_URL}.
 */
async function translateCommand({ command, schema, mode }) {
  const installId = await Storage.ensureInstallId();

  let res;
  try {
    res = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command, schema: compactSchema(schema), mode, installId }),
    });
  } catch (e) {
    throw new Error("Webber couldn't reach its server — check your connection.");
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON body */ }

  if (!res.ok) {
    if (res.status === 429) throw new Error('Rate limited — try again in a moment.');
    throw new Error(data?.error || `Webber server error (${res.status}).`);
  }
  if (!data?.ok || !data.result || !Array.isArray(data.result.transforms)) {
    throw new Error(data?.error || 'Webber server returned an invalid response.');
  }
  return data.result;
}

// ---- message router --------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case Schema.msg.TRANSLATE:
      translateCommand(message)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true; // async

    case Schema.msg.BOARD_ADD:
      Storage.addBoardItems(message.items || [])
        .then((board) => {
          // Live-update any open side panel.
          chrome.runtime.sendMessage({ type: Schema.msg.BOARD_UPDATED, count: board.items.length })
            .catch(() => {});
          // Best-effort: open the panel so the board is visible.
          if (sender.tab?.id) {
            chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
          }
          sendResponse({ ok: true, count: board.items.length });
        })
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;

    case Schema.msg.PAGE_VISIT:
      Storage.recordVisit({
        domain: message.domain,
        pageTitle: message.pageTitle,
        pageType: message.pageType,
        rulesApplied: message.rulesApplied || [],
      }).then(() => sendResponse({ ok: true }));
      return true;

    case Schema.msg.OPEN_PANEL:
      if (sender.tab?.id) chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});
