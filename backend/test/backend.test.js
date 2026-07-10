'use strict';
/**
 * Backend contract tests for backend/server.js.
 *
 * Run with:  node --test backend/test/backend.test.js   (from the repo root)
 *   or:      cd backend && node --test test/backend.test.js
 *
 * Uses node:test + node's built-in fetch (Node 18+) only — no new
 * test-framework dependencies. Each describe block spawns its own
 * `node server.js` child process with a controlled env and kills it
 * afterwards (see `after` hooks + the safety-net `process.on('exit')`
 * below).
 *
 * IMPORTANT SCOPE NOTE — read before changing this file:
 * `CEREBRAS_URL` in backend/server.js is a hardcoded literal
 * (`https://api.cerebras.ai/v1/chat/completions`) with NO env-var override.
 * Per the test-writing brief, we do not modify server.js to add one, and we
 * do not build tests that depend on a live (non-stub) third-party call
 * (even though this sandbox happens to have outbound network access to
 * api.cerebras.ai — confirmed separately, not relied upon here). Every
 * server this file spawns therefore runs WITHOUT CEREBRAS_API_KEY set, so
 * every request that passes input validation + rate limiting deterministically
 * stops at the "missing key" 500 guard instead of calling fetch(). That
 * lets us fully exercise validation, rate limiting, the missing-key guard,
 * and health — the paths explicitly called out as reachable without a stub.
 * The 200-success / upstream-502 / garbage-tool-call paths are NOT
 * exercised here; see .pipeline/test-results.md "Not testable here".
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const BACKEND_DIR = path.join(__dirname, '..');

// Registry of every child process we spawn, so a global safety net can
// clean up if an `after` hook is skipped because of a thrown assertion.
const liveChildren = new Set();
process.on('exit', () => {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
});

function startServer(port, extraEnv = {}) {
  const env = { ...process.env };
  // Deliberately unset on every test server — see file header note.
  delete env.CEREBRAS_API_KEY;
  delete env.RATE_LIMIT_MAX;
  delete env.RATE_LIMIT_WINDOW_MS;
  delete env.CEREBRAS_MODEL;
  delete env.PORT;
  Object.assign(env, extraEnv, { PORT: String(port) });

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  liveChildren.add(child);

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  return {
    child,
    baseUrl: `http://localhost:${port}`,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

async function waitForHealth(baseUrl, timeoutMs = 8000) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Server at ${baseUrl} never became healthy: ${lastErr}`);
}

async function stopServer(handle) {
  if (!handle || !handle.child) return;
  const child = handle.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (e) { /* noop */ }
    }, 2000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
    child.kill('SIGTERM');
  });
  liveChildren.delete(child);
}

function postJSON(baseUrl, bodyObj, headers = {}) {
  return fetch(`${baseUrl}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(bodyObj),
  });
}

// ---------------------------------------------------------------------------

describe('backend contract: health + input validation (no CEREBRAS_API_KEY)', () => {
  const PORT = 3401;
  let server;

  before(async () => {
    server = startServer(PORT, { RATE_LIMIT_MAX: '1000' });
    await waitForHealth(server.baseUrl);
  });

  after(async () => { await stopServer(server); });

  test('GET /health -> 200 {ok:true}', async () => {
    const res = await fetch(`${server.baseUrl}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('POST /translate with {} -> 400 {ok:false,error:"Missing command."}', async () => {
    const res = await postJSON(server.baseUrl, {});
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing command.' });
  });

  test('POST /translate with whitespace-only command -> 400 missing command', async () => {
    const res = await postJSON(server.baseUrl, { command: '   ', installId: 'abc' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing command.' });
  });

  test('POST /translate with no command key at all -> 400 missing command', async () => {
    const res = await postJSON(server.baseUrl, { installId: 'abc' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing command.' });
  });

  test('POST /translate missing installId -> 400 {ok:false,error:"Missing installId."}', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing installId.' });
  });

  test('POST /translate with non-string installId -> 400 missing installId', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 12345 });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing installId.' });
  });

  test('POST /translate with empty-string installId -> 400 missing installId', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: '' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing installId.' });
  });

  test('wrong content-type (text/plain) -> body-parser does not parse it -> 400 JSON, not a crash', async () => {
    const res = await postJSON(
      server.baseUrl,
      { command: 'hide ads', installId: 'abc' },
      { 'content-type': 'text/plain' },
    );
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    // req.body is undefined (content-type didn't match express.json()'s
    // filter) -> falls back to {} -> same "Missing command." branch.
    assert.deepEqual(await res.json(), { ok: false, error: 'Missing command.' });
  });

  test('[documented gap] syntactically-invalid JSON body -> 400 but an HTML error page, not {ok:false} JSON', async () => {
    const res = await fetch(`${server.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    assert.doesNotMatch(text, /"ok":false/);
    // This is Express's own body-parser error handler (no custom error
    // middleware exists in server.js), left as-is per the coder's own
    // self-verification notes in .pipeline/changes.md — not a code path the
    // spec's edge-case list asked for. Documented here, not treated as a
    // failure of the {ok,error} contract described in the spec (that
    // contract only covers requests that reach our route handler).
  });

  test('non-object `schema` field is NOT rejected with 400 — silently defaults to {} and validation proceeds', async () => {
    const res = await postJSON(server.baseUrl, {
      command: 'hide ads',
      installId: 'schema-shape-test',
      schema: 'not-an-object',
    });
    // No CEREBRAS_API_KEY on this server: if command/installId validation
    // had failed we'd see 400; instead we should see the missing-key 500,
    // proving `schema`'s type was never validated (matches server.js:
    // `const pageSchema = schema && typeof schema === 'object' ? schema : {};`).
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'Server is not configured (missing CEREBRAS_API_KEY).',
    });
  });

  test('missing CEREBRAS_API_KEY -> 500 {ok:false, error} for an otherwise fully valid body', async () => {
    const res = await postJSON(server.baseUrl, {
      command: 'hide ads',
      installId: 'key-guard-test',
      schema: {},
      mode: 'generic',
    });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'Server is not configured (missing CEREBRAS_API_KEY).',
    });
  });

  test('boot-time console.error fires when CEREBRAS_API_KEY is unset', () => {
    assert.match(server.stderr, /CEREBRAS_API_KEY is not set/);
  });

  test('a response body may name the missing env var, but never a header/secret value', async () => {
    const res = await postJSON(server.baseUrl, { command: 'x', installId: 'leak-probe' });
    const text = await res.text();
    // The intentional, user-facing "not configured" message legitimately
    // names the env var (CEREBRAS_API_KEY) — that's not a leak, it's a
    // config hint, and it's expected here. What must never appear is an
    // actual credential/header value.
    assert.match(text, /CEREBRAS_API_KEY/); // sanity: this is the branch we're hitting
    assert.doesNotMatch(text, /bearer\s+\S/i);
    assert.doesNotMatch(text, /"authorization"\s*:/i);
    // See static-sweep.test.js for the complete, source-level guarantee
    // that the `key` variable itself is never passed to res.json/res.send/
    // console.* anywhere in server.js (covering the upstream-fetch code
    // path too, which this offline suite can't dynamically reach).
  });
});

describe('backend contract: rate limiting (per-installId, in-memory sliding window)', () => {
  const PORT = 3402;
  let server;

  before(async () => {
    server = startServer(PORT, { RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '3600000' });
    await waitForHealth(server.baseUrl);
  });

  after(async () => { await stopServer(server); });

  test('requests 1-3 from one installId pass the rate limiter (500, missing key); 4th and 5th -> 429', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-user-A' });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [500, 500, 500, 429, 429]);
  });

  test('429 body shape is {ok:false, error: "Rate limit exceeded..."}', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-user-A' });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: 'Rate limit exceeded — try again later.',
    });
  });

  test('a different installId is isolated from installId A\'s exhausted bucket (not 429)', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-user-B' });
    assert.notEqual(res.status, 429);
    assert.equal(res.status, 500); // passed rate limiting; stopped at the missing-key guard instead
  });

  test('installId A is still rate-limited (429) after B succeeded past the limiter', async () => {
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-user-A' });
    assert.equal(res.status, 429);
  });
});
