'use strict';
/**
 * Pure-logic tests for shared/schema.js and shared/storage.js.
 *
 * Run with:  node --test test/shared.test.js   (from the repo root)
 *
 * These files are IIFEs written for a browser/extension context
 * (`self.WebberX = ...`). We load them with plain `require()` after
 * pointing the global `self` (and, for storage.js, a stubbed
 * `chrome.storage.local`) at objects we control — no jsdom, no new
 * dependencies. Because `require()` caches modules, each scenario that
 * needs a fresh module instance clears `require.cache` first.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, '..', 'shared', 'schema.js');
const STORAGE_PATH = path.join(__dirname, '..', 'shared', 'storage.js');

function freshRequire(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
}

/** In-memory stand-in for chrome.storage.local, backed by a Map. */
function makeChromeStorageStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    _store: store,
    storage: {
      local: {
        async get(keys) {
          const keyList = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of keyList) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) store.set(k, v);
        },
        async remove(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) store.delete(k);
        },
      },
    },
  };
}

describe('shared/schema.js', () => {
  test('loads clean and exposes WebberSchema.keys.installId; no apiKey key remains', () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);

    assert.equal(typeof sandboxSelf.WebberSchema, 'object');
    assert.equal(sandboxSelf.WebberSchema.keys.installId, 'webber:installId');
    assert.equal(sandboxSelf.WebberSchema.keys.apiKey, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(sandboxSelf.WebberSchema.keys, 'apiKey'), false);

    // Belt-and-suspenders: no literal "apiKey" substring anywhere in the
    // loaded schema object (keys, MODE_CONFIGS, msg, etc.)
    assert.doesNotMatch(JSON.stringify(sandboxSelf.WebberSchema), /apiKey/i);
  });

  test('exposes the new shared-secret / backend-URL keys and DEFAULT_BACKEND_URL', () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);

    assert.equal(sandboxSelf.WebberSchema.keys.sharedSecret, 'webber:sharedSecret');
    assert.equal(sandboxSelf.WebberSchema.keys.backendUrl, 'webber:backendUrl');
    assert.equal(sandboxSelf.WebberSchema.DEFAULT_BACKEND_URL, 'http://localhost:3000/translate');
  });
});

describe('shared/storage.js', () => {
  test('ensureInstallId() generates a UUID once and returns the same value on subsequent calls; getInstallId() agrees', async () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);
    global.chrome = makeChromeStorageStub();
    freshRequire(STORAGE_PATH);

    const WebberStorage = sandboxSelf.WebberStorage;
    assert.equal(typeof WebberStorage.ensureInstallId, 'function');
    assert.equal(typeof WebberStorage.getInstallId, 'function');

    const first = await WebberStorage.ensureInstallId();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const second = await WebberStorage.ensureInstallId();
    assert.equal(second, first, 'ensureInstallId must not regenerate once a value is persisted');

    const viaGetInstallId = await WebberStorage.getInstallId();
    assert.equal(viaGetInstallId, first, 'getInstallId must return the persisted id');

    // Persisted under the exact schema key, nowhere else.
    assert.equal(global.chrome._store.get('webber:installId'), first);
  });

  test('getInstallId() reflects a pre-seeded id without generating a new one', async () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);
    const preset = 'preset-fixed-id-0000';
    global.chrome = makeChromeStorageStub({ 'webber:installId': preset });
    freshRequire(STORAGE_PATH);

    const WebberStorage = sandboxSelf.WebberStorage;
    const got = await WebberStorage.getInstallId();
    assert.equal(got, preset);

    // ensureInstallId() on an already-seeded store must return the existing
    // value, not overwrite it with a freshly generated UUID.
    const ensured = await WebberStorage.ensureInstallId();
    assert.equal(ensured, preset);
  });

  test('getApiKey/setApiKey no longer exist on the returned WebberStorage object', async () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);
    global.chrome = makeChromeStorageStub();
    freshRequire(STORAGE_PATH);

    const WebberStorage = sandboxSelf.WebberStorage;
    assert.equal(WebberStorage.getApiKey, undefined);
    assert.equal(WebberStorage.setApiKey, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(WebberStorage, 'getApiKey'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(WebberStorage, 'setApiKey'), false);

    // Sanity: the rest of the storage API is still intact (no accidental
    // over-trimming of the returned object).
    for (const fn of [
      'getRulesFor', 'saveRule', 'deleteRule', 'incrementApplyCount', 'getAllRules',
      'recordVisit', 'getHistory', 'getBoard', 'addBoardItems', 'removeBoardItem', 'clearBoard',
    ]) {
      assert.equal(typeof WebberStorage[fn], 'function', `expected WebberStorage.${fn} to remain a function`);
    }
  });

  test('getSharedSecret()/setSharedSecret() default to \'\' and round-trip through chrome.storage.local', async () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);
    global.chrome = makeChromeStorageStub();
    freshRequire(STORAGE_PATH);

    const WebberStorage = sandboxSelf.WebberStorage;
    assert.equal(await WebberStorage.getSharedSecret(), '');

    await WebberStorage.setSharedSecret('s3cret');
    assert.equal(await WebberStorage.getSharedSecret(), 's3cret');
    assert.equal(global.chrome._store.get('webber:sharedSecret'), 's3cret');
  });

  test('getBackendUrl()/setBackendUrl() default to DEFAULT_BACKEND_URL, persist a real value, and treat \'\' as "use the default"', async () => {
    const sandboxSelf = {};
    global.self = sandboxSelf;
    freshRequire(SCHEMA_PATH);
    global.chrome = makeChromeStorageStub();
    freshRequire(STORAGE_PATH);

    const WebberStorage = sandboxSelf.WebberStorage;
    assert.equal(await WebberStorage.getBackendUrl(), sandboxSelf.WebberSchema.DEFAULT_BACKEND_URL);

    await WebberStorage.setBackendUrl('https://api.example.com/translate');
    assert.equal(await WebberStorage.getBackendUrl(), 'https://api.example.com/translate');
    assert.equal(global.chrome._store.get('webber:backendUrl'), 'https://api.example.com/translate');

    await WebberStorage.setBackendUrl('');
    assert.equal(await WebberStorage.getBackendUrl(), sandboxSelf.WebberSchema.DEFAULT_BACKEND_URL);
  });
});
