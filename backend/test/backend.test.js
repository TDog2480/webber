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
 * `CEREBRAS_URL` in backend/server.js now has an env-var override
 * (`process.env.CEREBRAS_URL || '<the original literal>'`), so this suite
 * stands up a local `node:http` stub mimicking `POST /v1/chat/completions`
 * (see `startCerebrasStub` below) and points spawned servers at it via the
 * `CEREBRAS_URL` env var. That makes the 200-success path and the various
 * 502 (malformed-model-output) paths fully stub-testable here — a coverage
 * gap in earlier versions of this file, which only ran servers WITHOUT
 * CEREBRAS_API_KEY set and so could only reach the "missing key" 500 guard.
 * The original no-key describe blocks below are kept as-is (still spawn
 * without CEREBRAS_API_KEY, still assert the 500 guard + validation +
 * rate-limiting paths); the new stub-backed describe blocks add the
 * previously-missing 200/502 coverage plus the shared-secret auth gate,
 * including proving (via the stub's hit counter) that rejected requests
 * never reach the rate limiter or Cerebras.
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');
const BACKEND_DIR = path.join(__dirname, '..');
const SECRET = 'test-shared-secret';

// Registry of every child process we spawn, so a global safety net can
// clean up if an `after` hook is skipped because of a thrown assertion.
const liveChildren = new Set();
process.on('exit', () => {
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); } catch (e) { /* already dead */ }
  }
});

// ---- Cerebras upstream stub (node:http, no new dependency) ------------------

function validToolCallBody() {
  return { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({
    transforms: [{ op: 'hide', target: 'ads' }], mode: 'generic', ruleName: 'Stub rule', confidence: 0.9,
  }) } }] } }] };
}

function startCerebrasStub() {
  let hits = 0;
  let respond = (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(validToolCallBody())); };
  const server = http.createServer((req, res) => { hits += 1; respond(res); });
  return {
    listen: () => new Promise((r) => server.listen(0, '127.0.0.1', r)),
    close: () => new Promise((r) => server.close(r)),
    url: () => `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    setResponder: (fn) => { respond = fn; },
    get hits() { return hits; },
  };
}

function startServer(port, extraEnv = {}) {
  const env = { ...process.env };
  // Deliberately unset on every test server — see file header note.
  delete env.CEREBRAS_API_KEY;
  delete env.RATE_LIMIT_MAX;
  delete env.RATE_LIMIT_WINDOW_MS;
  delete env.CEREBRAS_MODEL;
  delete env.PORT;
  // Every spawned server needs this or it exits at boot (see server.js).
  // Set before Object.assign so extraEnv/callers can still override it.
  env.WEBBER_SHARED_SECRET = SECRET;
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
    headers: { 'content-type': 'application/json', 'x-webber-secret': SECRET, ...headers },
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

describe('backend contract: auth gate + Cerebras stub (200/502 paths, never-reaches-Cerebras proofs)', () => {
  const PORT = 3403;
  let server;
  let stub;

  before(async () => {
    stub = startCerebrasStub();
    await stub.listen();
    server = startServer(PORT, { CEREBRAS_API_KEY: 'test-key', CEREBRAS_URL: stub.url() });
    await waitForHealth(server.baseUrl);
  });

  after(async () => {
    await stopServer(server);
    await stub.close();
  });

  test('correct secret + fully valid body -> 200 {ok:true, result} with an array of transforms; stub hit count increments by exactly one', async () => {
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validToolCallBody()));
    });
    const before = stub.hits;
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'stub-user-ok' });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.result.transforms));
    assert.equal(stub.hits, before + 1);
  });

  test('wrong secret -> 401 {ok:false, error:"Unauthorized."}; stub is never reached', async () => {
    const before = stub.hits;
    const res = await postJSON(
      server.baseUrl,
      { command: 'hide ads', installId: 'stub-user-wrong-secret' },
      { 'x-webber-secret': 'nope' },
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized.' });
    assert.equal(stub.hits, before);
  });

  test('missing secret -> 401; stub is never reached', async () => {
    const before = stub.hits;
    const res = await fetch(`${server.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'hide ads', installId: 'stub-user-no-secret' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized.' });
    assert.equal(stub.hits, before);
  });

  test('stub responds with no tool_calls -> 502 {ok:false, error:"Model did not produce transforms."}', async () => {
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: {} }] }));
    });
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'stub-user-no-tool-calls' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'Model did not produce transforms.' });
  });

  test('stub responds with non-JSON tool-call arguments -> 502 {ok:false, error:"Model returned invalid JSON."}', async () => {
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { arguments: 'not json' } }] } }] }));
    });
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'stub-user-bad-json' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'Model returned invalid JSON.' });
  });

  test('stub responds with tool-call arguments missing a transforms array -> 502 {ok:false, error:"Malformed transform spec."}', async () => {
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ mode: 'generic' }) } }] } }],
      }));
    });
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'stub-user-malformed' });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { ok: false, error: 'Malformed transform spec.' });
  });

  test('stub responds with a non-2xx status -> 502 {ok:false}', async () => {
    stub.setResponder((res) => { res.writeHead(500); res.end('{}'); });
    const res = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'stub-user-upstream-500' });
    assert.equal(res.status, 502);
    const data = await res.json();
    assert.equal(data.ok, false);
  });
});

describe('backend contract: 401s never touch the rate limiter or Cerebras', () => {
  const PORT = 3404;
  let server;
  let stub;

  before(async () => {
    stub = startCerebrasStub();
    await stub.listen();
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validToolCallBody()));
    });
    server = startServer(PORT, { CEREBRAS_API_KEY: 'test-key', CEREBRAS_URL: stub.url(), RATE_LIMIT_MAX: '1' });
    await waitForHealth(server.baseUrl);
  });

  after(async () => {
    await stopServer(server);
    await stub.close();
  });

  test('5 wrong/missing-secret requests never consume the rate-limit bucket or reach Cerebras; one authed request then succeeds; a second authed request hits the limiter', async () => {
    const before = stub.hits;

    for (let i = 0; i < 3; i++) {
      const res = await postJSON(
        server.baseUrl,
        { command: 'hide ads', installId: 'rl-secret-user' },
        { 'x-webber-secret': 'nope' },
      );
      assert.equal(res.status, 401);
    }
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.baseUrl}/translate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ command: 'hide ads', installId: 'rl-secret-user' }),
      });
      assert.equal(res.status, 401);
    }
    assert.equal(stub.hits, before, 'unauthenticated requests must never reach the Cerebras stub');

    const okRes = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-secret-user' });
    assert.equal(okRes.status, 200, 'the single authed request must succeed — the 401s must not have consumed the RATE_LIMIT_MAX=1 bucket');

    const limitedRes = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'rl-secret-user' });
    assert.equal(limitedRes.status, 429, 'a second authed request must now be rate-limited (MAX=1 reached by the single authed request)');
  });
});

describe('backend contract: adversarial auth-header edge cases (tester-added)', () => {
  const PORT = 3406;
  let server;
  let stub;

  before(async () => {
    stub = startCerebrasStub();
    await stub.listen();
    stub.setResponder((res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(validToolCallBody()));
    });
    server = startServer(PORT, { CEREBRAS_API_KEY: 'test-key', CEREBRAS_URL: stub.url() });
    await waitForHealth(server.baseUrl);
  });

  after(async () => {
    await stopServer(server);
    await stub.close();
  });

  test('a secret with leading/trailing whitespace around it IS accepted -- HTTP header values are OWS-trimmed by the transport, not by application code (verified below to be a wire-level property, not a leniency bug in server.js)', async () => {
    // Surprising on first read, so documented explicitly: RFC 7230 section 3.2 defines
    // leading/trailing "optional whitespace" (OWS) around a header FIELD VALUE as not
    // part of the semantic value; compliant HTTP stacks strip it during parsing. Verified
    // independently with a raw `node:net` socket (bypassing undici/fetch's own header
    // handling entirely) against a locally spawned server: sending the literal bytes
    // `x-webber-secret:   test-shared-secret   \r\n` still authenticates. So this is NOT
    // something server.js's `req.get(...) !== process.env.WEBBER_SHARED_SECRET` comparison
    // could "fix" by adding a manual trim -- Node's own http parser already trims OWS
    // before the header value ever reaches Express. Not a security concern: only
    // insignificant surrounding whitespace is ignored, the secret's actual content still
    // has to match exactly.
    const before = stub.hits;
    const res = await postJSON(
      server.baseUrl,
      { command: 'hide ads', installId: 'ws-user' },
      { 'x-webber-secret': `  ${SECRET}  ` },
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(stub.hits, before + 1);
  });

  test('a secret that only matches after trimming BUT differs in its actual (non-whitespace) content is still rejected (401)', async () => {
    const before = stub.hits;
    const res = await postJSON(
      server.baseUrl,
      { command: 'hide ads', installId: 'ws-user-wrong-content' },
      { 'x-webber-secret': `  ${SECRET}-nope  ` },
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized.' });
    assert.equal(stub.hits, before);
  });

  test('empty-string header value -> 401 (sent header, empty value)', async () => {
    const res = await postJSON(
      server.baseUrl,
      { command: 'hide ads', installId: 'empty-secret-user' },
      { 'x-webber-secret': '' },
    );
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized.' });
  });

  test('fully missing header (never sent at all) -> 401, identical shape to the empty-string case', async () => {
    const res = await fetch(`${server.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'hide ads', installId: 'missing-secret-user' }),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'Unauthorized.' });
  });

  test('header name is case-insensitive: "X-Webber-Secret" (mixed case) with the correct value is accepted', async () => {
    const before = stub.hits;
    const res = await fetch(`${server.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Webber-Secret': SECRET },
      body: JSON.stringify({ command: 'hide ads', installId: 'case-user-1' }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(stub.hits, before + 1);
  });

  test('header name is case-insensitive: "X-WEBBER-SECRET" (all caps) with the correct value is accepted', async () => {
    const res = await fetch(`${server.baseUrl}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-WEBBER-SECRET': SECRET },
      body: JSON.stringify({ command: 'hide ads', installId: 'case-user-2' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
  });

  test('GET /health needs no auth header, and is unaffected even by a WRONG secret header being present', async () => {
    const res = await fetch(`${server.baseUrl}/health`, {
      headers: { 'x-webber-secret': 'totally-wrong-value' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  test('the configured secret (and a wrong guess sent alongside it) never appears in any response body across a mixed 401/200/502 batch, nor in the child\'s combined stdout+stderr', async () => {
    await postJSON(server.baseUrl, { command: 'hide ads', installId: 'leak-a' }, { 'x-webber-secret': 'totally-wrong-value' });
    await fetch(`${server.baseUrl}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

    stub.setResponder((res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(validToolCallBody())); });
    const okRes = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'leak-b' });
    const okText = await okRes.text();

    stub.setResponder((res) => { res.writeHead(500); res.end('{}'); });
    const errRes = await postJSON(server.baseUrl, { command: 'hide ads', installId: 'leak-c' });
    const errText = await errRes.text();

    const secretPattern = new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    assert.doesNotMatch(okText, secretPattern);
    assert.doesNotMatch(errText, secretPattern);
    assert.doesNotMatch(server.stdout, secretPattern);
    assert.doesNotMatch(server.stderr, secretPattern);
    assert.doesNotMatch(server.stdout + server.stderr, /totally-wrong-value/);
  });
});

test('server refuses to start (non-zero exit) when WEBBER_SHARED_SECRET is unset', async () => {
  const env = { ...process.env, PORT: '3405' };
  delete env.WEBBER_SHARED_SECRET;
  const child = spawn(process.execPath, [SERVER_PATH], { cwd: BACKEND_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  liveChildren.add(child);
  let stderr = ''; child.stderr.on('data', (d) => { stderr += d.toString(); });
  const code = await new Promise((resolve) => child.once('exit', (c) => resolve(c)));
  liveChildren.delete(child);
  assert.notEqual(code, 0);
  assert.match(stderr, /WEBBER_SHARED_SECRET is not set/);
});
