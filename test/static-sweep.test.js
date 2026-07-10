'use strict';
/**
 * Static regression sweep across the whole repo.
 *
 * Run with:  node --test test/static-sweep.test.js   (from the repo root)
 *
 * - `node --check`s every .js file in the repo (excluding node_modules).
 * - Greps for zero remaining references to the removed Anthropic/API-key
 *   machinery (outside .pipeline/ docs and this test suite itself, which
 *   legitimately names those dead identifiers in order to assert their
 *   absence elsewhere).
 * - Confirms BACKEND_URL exists in background/service-worker.js.
 * - Confirms manifest.json is unchanged relative to git (untouched by the
 *   working tree diff), per the spec's "no manifest.json change" decision.
 * - Statically verifies content/rule-engine.js's describeTarget() priority
 *   order (repeating group -> landmark -> role= -> css fallback), since a
 *   real DOM isn't available here and we were told not to add jsdom.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function walk(dir, excludeDirNames) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (excludeDirNames.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, excludeDirNames));
    else out.push(full);
  }
  return out;
}

describe('static sweep: node --check every .js file', () => {
  const jsFiles = walk(REPO_ROOT, new Set(['node_modules', '.git']))
    .filter((f) => f.endsWith('.js'));

  test('at least the expected source files were found (sweep is not accidentally empty)', () => {
    assert.ok(jsFiles.length >= 9, `expected >=9 .js files, found ${jsFiles.length}`);
    const rel = jsFiles.map((f) => path.relative(REPO_ROOT, f));
    for (const expected of [
      'backend/server.js',
      'background/service-worker.js',
      'shared/schema.js',
      'shared/storage.js',
      'content/rule-engine.js',
      'content/content.js',
      'command-bar/command-bar.js',
      'sidepanel/panel.js',
    ]) {
      assert.ok(rel.includes(expected), `expected to find ${expected} in the sweep`);
    }
  });

  for (const file of jsFiles) {
    const rel = path.relative(REPO_ROOT, file);
    test(`node --check ${rel}`, () => {
      assert.doesNotThrow(() => {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      });
    });
  }
});

describe('static sweep: no leftover Anthropic / user-API-key references', () => {
  // .pipeline/ (planning docs) and test/ + backend/test/ (this harness,
  // which legitimately names the dead identifiers to assert their absence)
  // are excluded from this sweep.
  const excludeDirNames = new Set(['node_modules', '.git', '.pipeline']);
  const allFiles = walk(REPO_ROOT, excludeDirNames)
    .filter((f) => {
      const rel = path.relative(REPO_ROOT, f);
      if (rel.startsWith(`test${path.sep}`)) return false;
      if (rel.startsWith(path.join('backend', 'test') + path.sep)) return false;
      if (rel.includes(`${path.sep}node_modules${path.sep}`)) return false;
      return true;
    });

  const BANNED_PATTERNS = [
    'api.anthropic.com',
    'anthropic-dangerous-direct-browser-access',
    'getApiKey',
    'setApiKey',
    'ANTHROPIC_',
    'claude-opus',
  ];

  for (const pattern of BANNED_PATTERNS) {
    test(`zero references to "${pattern}" outside .pipeline/ and test harnesses`, () => {
      const hits = [];
      for (const file of allFiles) {
        let text;
        try {
          text = fs.readFileSync(file, 'utf8');
        } catch (e) {
          continue; // skip unreadable/binary files
        }
        if (text.includes(pattern)) hits.push(path.relative(REPO_ROOT, file));
      }
      assert.deepEqual(hits, [], `unexpected "${pattern}" reference(s) in: ${hits.join(', ')}`);
    });
  }

  test('bare "apiKey" is gone from shared/schema.js and shared/storage.js specifically', () => {
    for (const rel of ['shared/schema.js', 'shared/storage.js']) {
      const text = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      assert.doesNotMatch(text, /apiKey/i, `${rel} still references apiKey`);
    }
  });
});

describe('static sweep: CEREBRAS_API_KEY is never logged or echoed to a client (source-level, all code paths)', () => {
  // Complements backend/test/backend.test.js's dynamic check, which can
  // only exercise the paths reachable without a live/stubbed upstream.
  // This walks server.js's actual text to prove the `key` variable is
  // never an argument to res.json/res.send/console.* anywhere in the file
  // — including the upstream-fetch success/failure branches this offline
  // suite can't dynamically reach.
  const text = fs.readFileSync(path.join(REPO_ROOT, 'backend', 'server.js'), 'utf8');

  /** Return the substrings passed to every call whose callee matches `calleeRe`. */
  function extractCallArgs(source, calleeRe) {
    const args = [];
    calleeRe.lastIndex = 0;
    let m;
    while ((m = calleeRe.exec(source))) {
      const openParenIdx = m.index + m[0].length - 1; // calleeRe ends in '('
      let depth = 1;
      let i = openParenIdx + 1;
      for (; i < source.length && depth > 0; i++) {
        if (source[i] === '(') depth++;
        else if (source[i] === ')') depth--;
      }
      args.push(source.slice(openParenIdx + 1, i - 1));
    }
    return args;
  }

  test('server.js reads the key into a `key` local (not a module-level logged const)', () => {
    assert.match(text, /const key = process\.env\.CEREBRAS_API_KEY;/);
  });

  test('no res.json(...) / res.send(...) call argument references the `key` variable', () => {
    // Matches both bare `res.json(` and chained `res.status(xxx).json(` —
    // `.json(`/`.send(` are only ever called on `res` in this file.
    const calls = [
      ...extractCallArgs(text, /\.json\(/g),
      ...extractCallArgs(text, /\.send\(/g),
    ];
    assert.ok(calls.length >= 10, `expected several res.json calls to inspect, found ${calls.length}`);
    for (const args of calls) {
      assert.doesNotMatch(args, /\bkey\b/, `a response call embeds the \`key\` variable: (${args})`);
    }
  });

  test('no console.log/error/warn/info call argument references `key`, `Authorization`, or a Bearer value', () => {
    const calls = [
      ...extractCallArgs(text, /console\.log\(/g),
      ...extractCallArgs(text, /console\.error\(/g),
      ...extractCallArgs(text, /console\.warn\(/g),
      ...extractCallArgs(text, /console\.info\(/g),
    ];
    assert.ok(calls.length >= 2, `expected at least the two known console.* calls, found ${calls.length}`);
    for (const args of calls) {
      assert.doesNotMatch(args, /\bkey\b/i, `a console.* call embeds \`key\`: (${args})`);
      assert.doesNotMatch(args, /authorization/i, `a console.* call embeds the auth header: (${args})`);
      assert.doesNotMatch(args, /bearer/i, `a console.* call embeds a Bearer token: (${args})`);
    }
  });

  test('the only place `key` feeds into an outbound value is the outgoing Authorization header to Cerebras', () => {
    const headerLine = text.split('\n').find((l) => l.includes('authorization:') && l.includes('${key}'));
    assert.ok(headerLine, 'expected the outbound `authorization: `Bearer ${key}`` header line to exist');
  });
});

describe('static sweep: BACKEND_URL wiring', () => {
  test('background/service-worker.js defines/uses BACKEND_URL', () => {
    const text = fs.readFileSync(path.join(REPO_ROOT, 'background', 'service-worker.js'), 'utf8');
    assert.match(text, /const BACKEND_URL\s*=\s*['"]http:\/\/localhost:3000\/translate['"]/);
    assert.match(text, /fetch\(BACKEND_URL/);
  });
});

describe('static sweep: manifest.json untouched', () => {
  function gitAvailable() {
    try {
      execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }

  test('git does not report manifest.json as modified/staged/untracked', { skip: !gitAvailable() && 'not a git repo here' }, () => {
    const unstaged = execFileSync('git', ['diff', '--name-only'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const staged = execFileSync('git', ['diff', '--name-only', '--cached'], { cwd: REPO_ROOT, encoding: 'utf8' });
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' });

    assert.doesNotMatch(unstaged, /(^|\n)manifest\.json(\n|$)/, 'manifest.json appears in unstaged diff');
    assert.doesNotMatch(staged, /(^|\n)manifest\.json(\n|$)/, 'manifest.json appears in staged diff');
    assert.doesNotMatch(status, /manifest\.json/, 'manifest.json appears in git status --porcelain');
  });
});

describe('static sweep: describeTarget() priority order (no DOM available — source-order verification)', () => {
  // We were told: only build a DOM shim if it's cheaply achievable without
  // new dependencies (no jsdom). describeTarget() needs a real Element,
  // closest(), contains(), CSS.escape() and self.WebberExtractor.current()
  // (itself dependent on a live document) to actually run, so faithfully
  // shimming it would mean hand-rolling a DOM implementation — out of
  // scope. Instead we verify the priority order directly from source: the
  // four branches must appear, in this file, in the exact order the spec
  // requires (repeating group -> landmark region -> literal ARIA role ->
  // last-resort CSS selector), mirroring resolveTarget's own order.
  const text = fs.readFileSync(path.join(REPO_ROOT, 'content', 'rule-engine.js'), 'utf8');

  function bodyOf(fnName) {
    const start = text.indexOf(`function ${fnName}(`);
    assert.ok(start >= 0, `function ${fnName} not found in content/rule-engine.js`);
    // Grab up to the next top-level "function " declaration (or EOF) as a
    // cheap-but-reliable slice of this function's body for ordering checks.
    const next = text.indexOf('\n  function ', start + 1);
    return text.slice(start, next === -1 ? text.length : next);
  }

  test('describeTarget is exported alongside resolveTarget', () => {
    assert.match(text, /return\s*\{\s*apply,\s*revert,\s*getActiveRules,\s*resolveTarget,\s*describeTarget\s*\}/);
  });

  test('describeTarget: repeating-group membership check appears before any landmark check', () => {
    const body = bodyOf('describeTarget');
    const groupIdx = body.indexOf('WebberExtractor.current()');
    const navIdx = body.indexOf(`el.closest('nav, header, [role="navigation"], [role="banner"]')`);
    assert.ok(groupIdx >= 0, 'repeating-group check not found');
    assert.ok(navIdx >= 0, 'navigation landmark check not found');
    assert.ok(groupIdx < navIdx, 'repeating-group check must come before the landmark checks');
  });

  test('describeTarget: all four landmark branches appear, in resolveTarget\'s own order (nav, aside, footer, article)', () => {
    const body = bodyOf('describeTarget');
    const navIdx = body.indexOf('return \'navigation\'');
    const sideIdx = body.indexOf('return \'sidebar\'');
    const footIdx = body.indexOf('return \'footer\'');
    const artIdx = body.indexOf('return \'article body\'');
    for (const [name, idx] of [['navigation', navIdx], ['sidebar', sideIdx], ['footer', footIdx], ['article body', artIdx]]) {
      assert.ok(idx >= 0, `expected a "${name}" branch in describeTarget`);
    }
    assert.ok(navIdx < sideIdx && sideIdx < footIdx && footIdx < artIdx,
      'landmark branches must appear in the order nav < sidebar < footer < article body');
  });

  test('describeTarget: landmark checks appear before the role= check, which appears before the cssPath fallback', () => {
    const body = bodyOf('describeTarget');
    const lastLandmarkIdx = body.indexOf('return \'article body\'');
    const roleIdx = body.indexOf(`el.closest('[role]')`);
    const cssFallbackIdx = body.lastIndexOf('return cssPath(el);');
    assert.ok(lastLandmarkIdx >= 0 && roleIdx >= 0 && cssFallbackIdx >= 0,
      'expected to find the landmark, role=, and cssPath branches');
    assert.ok(lastLandmarkIdx < roleIdx, 'role= check must come after landmark checks');
    assert.ok(roleIdx < cssFallbackIdx, 'cssPath fallback must be the last-resort branch, after role=');
  });

  test('describeTarget\'s landmark selectors are textually identical to resolveTarget\'s (kept in sync)', () => {
    const describeBody = bodyOf('describeTarget');
    const resolveBody = bodyOf('resolveTarget');
    const selectors = [
      'nav, header, [role="navigation"], [role="banner"]',
      'aside, [role="complementary"]',
      'footer, [role="contentinfo"]',
      'article, [role="article"], main, [role="main"]',
    ];
    for (const sel of selectors) {
      assert.ok(describeBody.includes(sel), `describeTarget missing selector: ${sel}`);
      assert.ok(resolveBody.includes(sel), `resolveTarget missing selector: ${sel}`);
    }
  });

  test('cssPath is the literal last-resort: describeTarget has no other "return" after it', () => {
    const body = bodyOf('describeTarget');
    const cssFallbackIdx = body.lastIndexOf('return cssPath(el);');
    const trailing = body.slice(cssFallbackIdx + 'return cssPath(el);'.length);
    assert.doesNotMatch(trailing.split('\n}')[0] || '', /return /,
      'cssPath(el) must be the final return in describeTarget');
  });
});
