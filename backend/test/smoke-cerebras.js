'use strict';
/**
 * Standalone smoke test for a real Cerebras call through the Webber backend.
 *
 * NOT a `node --test` test — this file defines no tests. It is guarded by the
 * `--run` argv flag (see the bottom of this file) so that if `node --test`
 * happens to load it (because it lives under a `test/` directory), it is a
 * zero-test no-op. It only does anything when invoked directly:
 *
 *   node test/smoke-cerebras.js --run     (from backend/)
 *   npm run smoke                         (from backend/, see package.json)
 *
 * Requires a real CEREBRAS_API_KEY and WEBBER_SHARED_SECRET in backend/.env —
 * this makes one real call to the Cerebras API. Never logs the secret or the
 * key.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const BACKEND_DIR = path.join(__dirname, '..');
const SERVER_PATH = path.join(BACKEND_DIR, 'server.js');
const PORT = Number(process.env.SMOKE_PORT || 3500);
const BASE_URL = `http://localhost:${PORT}`;

// Reuses the polling pattern from backend/test/backend.test.js's waitForHealth.
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

function fixtureBody() {
  return {
    command: 'hide out of stock items and sort by price',
    schema: {
      pageType: 'product-listing',
      pageTitle: 'Smoke',
      domain: 'example.com',
      repeatingItems: [{ title: 'A', price: 10, availability: 'in stock' }],
      landmarks: [],
    },
    mode: 'shopping',
    installId: 'smoke-test',
  };
}

async function main() {
  require('dotenv').config();

  const secret = process.env.WEBBER_SHARED_SECRET;
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!secret || !apiKey) {
    console.log('SMOKE FAIL — set both CEREBRAS_API_KEY and WEBBER_SHARED_SECRET in backend/.env first.');
    process.exitCode = 1;
    return;
  }

  const env = { ...process.env, PORT: String(PORT) };
  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  try {
    await waitForHealth(BASE_URL);

    const res = await fetch(`${BASE_URL}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webber-secret': secret },
      body: JSON.stringify(fixtureBody()),
    });

    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON body */ }

    console.log(`HTTP ${res.status}`);
    console.log(JSON.stringify(data, null, 2));

    const pass = res.status === 200 && !!data?.ok && Array.isArray(data?.result?.transforms);
    if (pass) {
      console.log('SMOKE PASS — 200 with a usable transforms array.');
      process.exitCode = 0;
    } else {
      console.log('SMOKE FAIL — did not get a 200 with a usable transforms array.');
      process.exitCode = 1;
    }
  } catch (e) {
    console.log(`SMOKE FAIL — ${e && e.message ? e.message : e}`);
    if (stderr) console.log(`(server stderr: ${stderr.trim()})`);
    process.exitCode = 1;
  } finally {
    try { child.kill('SIGTERM'); } catch (e) { /* already dead */ }
  }
}

if (process.argv.includes('--run')) main();
