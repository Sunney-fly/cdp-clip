import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, dirname } from 'node:path';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, 'cdp-clip.mjs');
const fixture = pathToFileURL(join(root, 'test', 'fixture.html')).href;

// A real browser is required; that is the point of the tool.
const TIMEOUT = 90_000;

test('clips a local article to stdout', { timeout: TIMEOUT }, async () => {
  const { stdout } = await run(process.execPath, [cli, 'url', fixture, '--stdout']);

  assert.match(stdout, /^---\n/, 'starts with YAML frontmatter');
  assert.match(stdout, /title: "Why Retrieval Beats Fine-Tuning"/);
  assert.match(stdout, /author: "Test Author"/);

  // Markdown structure survives.
  assert.match(stdout, /## The three failure modes\n/, 'heading text is clean of permalink noise');
  assert.match(stdout, /- Stale weights after every document change/);
  assert.match(stdout, /  - which breaks auditability/, 'nested list keeps its indent');
  assert.match(stdout, /^```python$/m, 'code fence keeps the language');
  assert.match(stdout, /\| Approach \| Latency \| Cost \|/, 'tables are rendered');
  assert.match(stdout, /\*\*frozen\*\*/, 'bold keeps surrounding spaces');
  assert.match(stdout, /\[the paper\]\(https:\/\/example.com\/paper\)/, 'absolute links');

  // Noise is gone.
  assert.ok(!stdout.includes('should not appear'), '<script> content must not leak');
  assert.ok(!stdout.includes('2026 nobody'), '<footer> must be dropped');
  assert.ok(!stdout.includes('[#]('), 'heading permalinks must be dropped');
});

test('json mode returns parseable metadata', { timeout: TIMEOUT }, async () => {
  const { stdout } = await run(process.execPath, [cli, 'url', fixture, '--json']);
  const data = JSON.parse(stdout);

  assert.equal(data.host, 'local');
  assert.ok(data.words > 50);
  assert.ok(data.tokens_est > 0);
  assert.ok(data.markdown.length > 100);
  assert.ok(data.markdown.includes('## Scoring'));
});

test('frontmatter can be turned off', { timeout: TIMEOUT }, async () => {
  const { stdout } = await run(process.execPath, [cli, 'url', fixture, '--stdout', '--no-frontmatter']);
  assert.ok(!stdout.startsWith('---'));
  assert.ok(stdout.includes('# Why Retrieval Beats Fine-Tuning'));
});
