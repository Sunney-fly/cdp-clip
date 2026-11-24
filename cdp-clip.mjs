#!/usr/bin/env node
/**
 * cdp-clip — clip any browser tab to clean Markdown, straight from the Chrome DevTools Protocol.
 *
 * Zero dependencies: Node >= 22 ships everything it needs (fetch, WebSocket).
 * Read-only: it extracts text from a page that is already open. No extension, no injection,
 * no cookie access, no clicking.
 *
 * Usage:
 *   cdp-clip url <https://...>          launch a throwaway browser, clip that URL, exit
 *   cdp-clip clip                       clip the focused tab of a browser started with
 *                                       --remote-debugging-port
 *   cdp-clip clip --tab=<n|substring>   clip a specific tab
 *   cdp-clip list                       list clip-able tabs
 *   cdp-clip status                     check whether a debug port answers
 *   cdp-clip launch [--port=9222]       open a browser with a debug port so you can log in
 *   cdp-clip open <url>                 open a tab in that browser
 *
 * Common flags: --out=<dir> --stdout --json --no-frontmatter --port=<n> --browser=<edge|chrome|brave|chromium>
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';

const VERSION = '0.1.0';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const command = argv[0] || 'help';
const flags = Object.create(null);
const positional = [];

for (const arg of argv.slice(1)) {
  if (arg.startsWith('--')) {
    const [key, ...rest] = arg.slice(2).split('=');
    flags[key] = rest.length ? rest.join('=') : true;
  } else {
    positional.push(arg);
  }
}

const PORT = String(flags.port || process.env.CDP_CLIP_PORT || '9222');
const OUT_DIR = resolve(process.cwd(), flags.out || 'clips');
const WANT_JSON = Boolean(flags.json);
const TO_STDOUT = Boolean(flags.stdout);
const FRONTMATTER = !flags['no-frontmatter'];
const HEADED = Boolean(flags.headed);

/** Only real pages are clip-able: internal UI, devtools and extension pages are skipped. */
const READABLE = /^(https?|file):/i;

// ---------------------------------------------------------------- CDP transport

async function targets(base) {
  const res = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`CDP answered HTTP ${res.status}`);
  const all = await res.json();
  return all.filter((t) => t.type === 'page' && READABLE.test(t.url) && t.url !== 'about:blank');
}

function openCdp(wsUrl) {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;

    ws.onopen = () => resolvePromise({
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++nextId;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* already closed */ } },
    });

    ws.onerror = () => reject(new Error(`cannot connect to ${wsUrl}`));
    ws.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (!message.id || !pending.has(message.id)) return;
      const { res, rej } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rej(new Error(message.error.message || 'CDP error'));
      else res(message.result);
    };
  });
}

async function evaluate(ws, expression) {
  const result = await ws.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails;
    throw new Error(detail.text || detail.exception?.description || 'page script failed');
  }
  return result.result?.value;
}

// ---------------------------------------------------------------- page extraction

/**
 * Runs inside the page. Picks the densest text container, drops chrome (nav/ads/scripts),
 * and renders Markdown. Pure read: it never writes to the DOM.
 */
const EXTRACT = `(() => {
  const abs = (u) => { try { return new URL(u, location.href).href; } catch { return u; } };
  const DROP = 'script,style,noscript,iframe,svg,canvas,form,nav,footer,aside,header,button,select,textarea,input,video,audio,object,embed';
  const clean = (s) => String(s).replace(/\\s+/g, ' ').trim();
  const cell = (s) => clean(s).replace(/\\|/g, '\\\\|');

  // Score candidate containers by "text minus link text", so prose beats link farms.
  const score = (el) => {
    const text = (el.innerText || '').trim();
    if (text.length < 80) return -Infinity;
    let linkText = 0;
    for (const a of el.querySelectorAll('a')) linkText += (a.innerText || '').length;
    return text.length - linkText * 1.5;
  };

  const SELECTORS = ['article', 'main', '[role=main]', '[itemprop=articleBody]', '.article',
    '.article-content', '.post', '.post-content', '.entry-content', '.markdown-body',
    '#content', '.content'];

  let best = null;
  let bestScore = -Infinity;
  for (const sel of SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      const s = score(el);
      if (s > bestScore) { bestScore = s; best = el; }
    }
  }
  const bodyLen = (document.body?.innerText || '').length;
  if (!best || bestScore < bodyLen * 0.3) best = document.body;

  const clone = best.cloneNode(true);
  for (const el of clone.querySelectorAll(DROP)) el.remove();

  // Text nodes keep one space where the source had whitespace, otherwise inline
  // marks would glue to neighbouring words ("model**frozen**and").
  const textNode = (node) => {
    const raw = node.textContent;
    if (!raw.trim()) return raw ? ' ' : '';
    return (/^\\s/.test(raw) ? ' ' : '') + clean(raw) + (/\\s$/.test(raw) ? ' ' : '');
  };

  const inline = (node) => {
    if (node.nodeType === 3) return textNode(node);
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '  \\n';
    if (tag === 'img') {
      const src = abs(node.getAttribute('src') || '');
      const alt = clean(node.getAttribute('alt') || '').replace(/\\]/g, '\\\\]');
      return src ? '![' + alt + '](' + src + ')' : '';
    }
    const inner = [...node.childNodes].map(inline).join('');
    if (tag === 'strong' || tag === 'b') { const t = inner.trim(); return t ? '**' + t + '**' : ''; }
    if (tag === 'em' || tag === 'i') { const t = inner.trim(); return t ? '*' + t + '*' : ''; }
    if (tag === 'code') { const t = inner.trim(); return t ? '\`' + t + '\`' : ''; }
    if (tag === 'a') {
      const rawHref = node.getAttribute('href') || '';
      const cls = String(node.className || '').toLowerCase();
      const label = clean(node.textContent);
      // Heading permalinks ("#", "¶") and in-page anchors are noise, not information.
      if (['#', '\\u00b6', '\\u00a7', '\\u{1f517}'].includes(label) || /anchor|permalink/.test(cls)) return '';
      if (rawHref.startsWith('#')) return inner;
      if (!inner) return rawHref ? '<' + abs(rawHref) + '>' : '';
      return rawHref ? '[' + inner + '](' + abs(rawHref) + ')' : inner;
    }
    if (tag === 'del' || tag === 's') { const t = inner.trim(); return t ? '~~' + t + '~~' : ''; }
    return inner;
  };

  const block = (node, depth = 0) => {
    if (node.nodeType === 3) {
      const t = clean(node.textContent);
      return t ? t + '\\n\\n' : '';
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = [...node.childNodes];

    if (/^h[1-6]$/.test(tag)) {
      const t = clean(kids.map(inline).join(''));
      return t ? '#'.repeat(Number(tag[1])) + ' ' + t + '\\n\\n' : '';
    }
    if (tag === 'p') {
      const t = kids.map(inline).join('').trim();
      return t ? t + '\\n\\n' : '';
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = [...node.children].filter((el) => el.tagName.toLowerCase() === 'li');
      return items.map((li, index) => {
        const marker = tag === 'ol' ? (index + 1) + '. ' : '- ';
        const text = [...li.childNodes]
          .map((child) => child.nodeType === 1
            ? (['ul', 'ol'].includes(child.tagName.toLowerCase()) ? '' : inline(child))
            : inline(child))
          .join('').trim();
        const nested = [...li.children]
          .filter((el) => ['ul', 'ol'].includes(el.tagName.toLowerCase()))
          .map((el) => block(el, depth + 1)).join('').trimEnd();
        return '  '.repeat(depth) + marker + text + '\\n' + (nested ? nested + '\\n' : '');
      }).join('') + '\\n';
    }
    if (tag === 'blockquote') {
      const inner = kids.map((c) => block(c, depth)).join('').trim();
      return inner ? inner.split('\\n').map((line) => '> ' + line).join('\\n') + '\\n\\n' : '';
    }
    if (tag === 'pre') {
      const codeEl = node.querySelector('code');
      const cls = (codeEl && codeEl.className) || '';
      const lang = (String(cls).match(/language-([\\w+#.-]+)/) || [])[1] || '';
      const code = (node.innerText || '').replace(/\\n+$/, '');
      return code ? '\`\`\`' + lang + '\\n' + code + '\\n\`\`\`\\n\\n' : '';
    }
    if (tag === 'hr') return '---\\n\\n';
    if (tag === 'table') {
      const rows = [...node.querySelectorAll('tr')]
        .map((tr) => [...tr.children].map((c) => cell(c.innerText)).join(' | '));
      if (!rows.length) return '';
      const head = rows.shift();
      const divider = head.split('|').map(() => ' --- ').join('|');
      return '| ' + head + ' |\\n|' + divider + '|\\n' + rows.map((r) => '| ' + r + ' |').join('\\n') + '\\n\\n';
    }
    if (['div', 'section', 'article', 'main', 'body', 'figure', 'figcaption', 'span', 'li',
      'td', 'th', 'dd', 'dt', 'dl', 'hgroup', 'details', 'summary', 'header'].includes(tag)) {
      return kids.map((c) => block(c, depth)).join('');
    }
    return inline(node) + ' ';
  };

  let markdown = [...clone.childNodes]
    .map((c) => block(c, 0))
    .join('')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim();

  // Drop the H1 when it merely repeats the page title — the document header already carries it.
  const head = document.querySelector('meta[property="og:title"],meta[name="og:title"]');
  const pageTitle = ((head && head.content) || document.title || '').trim();
  const firstLine = markdown.split('\\n')[0].trim();
  if (pageTitle && firstLine === '# ' + pageTitle) {
    markdown = markdown.slice(markdown.indexOf('\\n') + 1).trim();
  }

  const meta = (name) => (document.querySelector(
    'meta[name="' + name + '"],meta[property="' + name + '"]')?.content || '').trim();

  const wordCount = (markdown.match(/[A-Za-z0-9_]+/g) || []).length
    + (markdown.match(/[\\u4e00-\\u9fff]/g) || []).length;

  return {
    title: (meta('og:title') || document.title || '').trim(),
    url: location.href,
    host: location.host,
    lang: document.documentElement.lang || meta('og:locale') || '',
    author: meta('author') || meta('article:author') || '',
    published: meta('article:published_time') || meta('og:updated_time') || '',
    description: meta('description') || meta('og:description') || '',
    words: wordCount,
    chars: markdown.length,
    markdown,
  };
})()`;

// ---------------------------------------------------------------- output

function slugify(info) {
  const base = String(info.title || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const host = String(info.host || 'page').replace(/[^a-z0-9.-]/gi, '');
  const digest = fnv1a(`${info.url}|${info.title}`);
  return `${host}-${base || digest}`.slice(0, 80);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 6);
}

/** Rough token estimate: Latin words ~1.3 tokens, CJK characters ~1 token each. */
function estimateTokens(info) {
  const latin = (info.markdown.match(/[A-Za-z0-9_]+/g) || []).length;
  const cjk = (info.markdown.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.round(latin * 1.3 + cjk);
}

function documentFor(info, stamp) {
  const iso = stamp.toISOString();
  const lines = [];

  if (FRONTMATTER) {
    lines.push(
      '---',
      `title: ${JSON.stringify(info.title)}`,
      `url: ${JSON.stringify(info.url)}`,
      `host: ${JSON.stringify(info.host || 'local')}`,
      `clipped_at: ${JSON.stringify(iso)}`,
      `words: ${info.words}`,
      `tokens_est: ${estimateTokens(info)}`,
    );
    if (info.author) lines.push(`author: ${JSON.stringify(info.author)}`);
    if (info.published) lines.push(`published: ${JSON.stringify(info.published)}`);
    if (info.lang) lines.push(`lang: ${JSON.stringify(info.lang)}`);
    lines.push('source: cdp-clip', '---', '');
  }

  lines.push(
    `# ${info.title}`,
    '',
    `> Source: ${info.url}`,
    `> Clipped: ${iso.slice(0, 19).replace('T', ' ')} (${info.host || 'local file'}, ~${info.words} words, ~${estimateTokens(info)} tokens)`,
  );
  if (info.description) lines.push('', `> ${info.description}`);
  lines.push('', info.markdown, '');

  return lines.join('\n');
}

function emit(info) {
  const stamp = new Date();

  if (TO_STDOUT) {
    process.stdout.write(documentFor(info, stamp));
    return;
  }

  if (WANT_JSON) {
    process.stdout.write(JSON.stringify({
      title: info.title,
      url: info.url,
      host: info.host || 'local',
      author: info.author,
      published: info.published,
      lang: info.lang,
      words: info.words,
      chars: info.chars,
      tokens_est: estimateTokens(info),
      markdown: info.markdown,
    }, null, 2) + '\n');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`;
  const file = join(OUT_DIR, `${date}-${slugify(info)}.md`);
  writeFileSync(file, documentFor(info, stamp), 'utf8');

  console.log(`clipped  ${info.title}`);
  console.log(`file     ${file}`);
  console.log(`size     ~${info.words} words, ~${estimateTokens(info)} tokens`);
}

// ---------------------------------------------------------------- browser discovery

const CANDIDATES = {
  win32: [
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ],
  darwin: [
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    ['chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
  ],
  linux: [
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/google-chrome-stable'],
    ['chromium', '/usr/bin/chromium'],
    ['chromium', '/usr/bin/chromium-browser'],
    ['edge', '/usr/bin/microsoft-edge'],
    ['brave', '/usr/bin/brave-browser'],
  ],
};

function findBrowser(preferred) {
  if (process.env.CDP_CLIP_BROWSER) return process.env.CDP_CLIP_BROWSER;
  const list = CANDIDATES[platform()] || CANDIDATES.linux;
  const wanted = String(preferred || 'auto').toLowerCase();
  for (const [name, path] of list) {
    if (wanted !== 'auto' && name !== wanted) continue;
    if (existsSync(path)) return path;
  }
  if (wanted !== 'auto') {
    throw new Error(`no ${wanted} binary found; set CDP_CLIP_BROWSER=/path/to/browser`);
  }
  throw new Error('no Chromium-based browser found (Edge/Chrome/Brave); set CDP_CLIP_BROWSER=/path/to/browser');
}

// ---------------------------------------------------------------- throwaway browser

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launchForClip(url) {
  const exe = findBrowser(flags.browser);
  const profile = join(tmpdir(), `cdp-clip-${process.pid}-${Date.now()}`);
  mkdirSync(profile, { recursive: true });

  const args = [
    ...(HEADED ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-component-update',
    '--disable-background-networking',
    '--disable-sync',
    '--window-size=1440,960',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // Start on a blank page and open the real target ourselves: a fresh profile can
    // surface first-run dialogs (sync, welcome) that would otherwise win the "first tab".
    'about:blank',
  ];

  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((r) => proc.once('exit', r));

  try {
    // Chrome writes "<port>\n<devtools path>" once the debug endpoint is live.
    const portFile = join(profile, 'DevToolsActivePort');
    const deadline = Date.now() + 20000;
    let port = null;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error('browser exited before the debug port came up');
      if (existsSync(portFile)) {
        const first = (await import('node:fs')).readFileSync(portFile, 'utf8').split('\n')[0].trim();
        if (first) { port = first; break; }
      }
      await sleep(100);
    }
    if (!port) throw new Error('timed out waiting for the browser debug port');

    const base = `http://127.0.0.1:${port}`;
    let created = null;
    const tabDeadline = Date.now() + 15000;
    while (Date.now() < tabDeadline) {
      try {
        const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
          method: 'PUT',
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) { created = await res.json(); break; }
      } catch { /* endpoint not ready yet */ }
      await sleep(200);
    }
    if (!created || !created.webSocketDebuggerUrl) throw new Error('browser started but refused to open a tab');

    const expectedHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
    const ws = await openCdp(created.webSocketDebuggerUrl);
    try {
      await waitForNavigation(ws, expectedHost);
      await waitForReady(ws);
      if (flags.wait) await sleep(Math.max(0, Number(flags.wait) || 0)); // late hydration, lazy images
      const info = await evaluate(ws, EXTRACT);
      if (!info || !info.markdown || info.markdown.length < 40) {
        throw new Error('no article-like text found (PDF, canvas app, or a login wall?)');
      }
      return info;
    } finally {
      ws.close();
    }
  } finally {
    try { proc.kill(); } catch { /* already gone */ }
    await Promise.race([exited, sleep(3000)]);
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows may hold locks; harmless */ }
  }
}

async function waitForNavigation(ws, expectedHost, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const href = await evaluate(ws, 'location.href');
      if (href && href !== 'about:blank' && !href.startsWith('chrome-error://')) {
        if (!expectedHost || href.includes(expectedHost)) return href;
      }
    } catch { /* context still being created */ }
    await sleep(150);
  }
  throw new Error(`page did not reach ${expectedHost || 'the target URL'} in ${Math.round(timeout / 1000)}s`);
}

async function waitForReady(ws, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (await evaluate(ws, 'document.readyState') === 'complete') {
        await sleep(350); // let late paints / hydration settle
        return;
      }
    } catch { /* navigation in flight */ }
    await sleep(200);
  }
}

// ---------------------------------------------------------------- attach to a running browser

async function attachedTargets() {
  const base = `http://127.0.0.1:${PORT}`;
  try {
    return await targets(base);
  } catch (error) {
    throw new Error(
      `no debug endpoint on port ${PORT}.\n` +
      `Start one first, then clip:\n` +
      `  cdp-clip launch            # opens a browser with a debug port\n` +
      `  cdp-clip clip              # clips its focused tab\n` +
      `(or point --port at an existing --remote-debugging-port)`
    );
  }
}

async function pickTarget(list) {
  const needle = flags.tab;
  if (needle !== undefined && /^\d+$/.test(String(needle))) {
    const tab = list[Number(needle)];
    if (!tab) throw new Error(`there is no tab #${needle}`);
    return tab;
  }
  if (needle) {
    const lower = String(needle).toLowerCase();
    const match = list.find((t) => `${t.title} ${t.url}`.toLowerCase().includes(lower));
    if (!match) throw new Error(`no tab matching "${needle}"`);
    return match;
  }
  // Prefer the tab the user is actually looking at.
  for (const tab of list) {
    if (!tab.webSocketDebuggerUrl) continue;
    try {
      const ws = await openCdp(tab.webSocketDebuggerUrl);
      const visible = await evaluate(ws, 'document.visibilityState');
      ws.close();
      if (visible === 'visible') return tab;
    } catch { /* unreadable tab, try the next */ }
  }
  const fallback = [...list].reverse().find((t) => t.webSocketDebuggerUrl);
  if (!fallback) throw new Error('no readable tab (all on browser-internal pages?)');
  return fallback;
}

// ---------------------------------------------------------------- commands

async function cmdStatus() {
  const list = await attachedTargets();
  console.log(`debug endpoint  http://127.0.0.1:${PORT}`);
  console.log(`clip-able tabs  ${list.length}`);
}

async function cmdList() {
  const list = await attachedTargets();
  if (!list.length) { console.log('no clip-able tabs'); return; }
  for (const [i, tab] of list.entries()) {
    console.log(`${i}\t${tab.title}`);
    console.log(`\t${tab.url}`);
  }
}

async function cmdClip() {
  const list = await attachedTargets();
  if (!list.length) throw new Error('no clip-able tabs');
  const tab = await pickTarget(list);
  const ws = await openCdp(tab.webSocketDebuggerUrl);
  let info;
  try {
    info = await evaluate(ws, EXTRACT);
  } finally {
    ws.close();
  }
  if (!info || !info.markdown || info.markdown.length < 40) {
    throw new Error('no article-like text found (PDF, canvas app, or a login wall?)');
  }
  emit(info);
}

async function cmdUrl() {
  const url = positional[0];
  if (!url) throw new Error('url needs an address, e.g. cdp-clip url https://example.com');
  const info = await launchForClip(url);
  emit(info);
}

async function cmdLaunch() {
  const exe = findBrowser(flags.browser);
  const profile = flags.profile || join(tmpdir(), 'cdp-clip-profile');
  mkdirSync(profile, { recursive: true });
  const child = spawn(exe, [
    `--remote-debugging-port=${flags.port || 9222}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { stdio: 'ignore', detached: true });
  child.unref();
  console.log(`launched ${exe}`);
  console.log(`profile   ${profile}`);
  console.log(`debug     http://127.0.0.1:${flags.port || 9222}`);
  console.log('');
  console.log('Log in to whatever you need, then run:  cdp-clip clip');
}

async function cmdOpen() {
  const url = positional[0];
  if (!url) throw new Error('open needs a URL');
  const base = `http://127.0.0.1:${PORT}`;
  const res = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, {
    method: 'PUT',
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`could not open a tab (HTTP ${res.status})`);
  const created = await res.json();
  console.log(`opened  ${created.url || url}`);
}

function usage() {
  console.log(`cdp-clip ${VERSION} — clip browser tabs to clean Markdown over CDP. Zero dependencies.`);
  console.log('');
  console.log('  cdp-clip url <https://...>     clip a URL in a throwaway headless browser');
  console.log('  cdp-clip clip                  clip the focused tab of a debug-enabled browser');
  console.log('  cdp-clip list                  list clip-able tabs');
  console.log('  cdp-clip status                check the debug endpoint');
  console.log('  cdp-clip launch                open a browser with a debug port (for logged-in pages)');
  console.log('  cdp-clip open <url>            open a tab in that browser');
  console.log('');
  console.log('  --tab=<n|substring>  --out=<dir>  --stdout  --json  --no-frontmatter');
  console.log('  --port=<n>  --browser=<edge|chrome|brave|chromium>  --headed  --wait=<ms>');
}

// ---------------------------------------------------------------- entry

try {
  if (command === 'status') await cmdStatus();
  else if (command === 'list') await cmdList();
  else if (command === 'clip') await cmdClip();
  else if (command === 'url') await cmdUrl();
  else if (command === 'launch') await cmdLaunch();
  else if (command === 'open') await cmdOpen();
  else if (command === 'version' || command === '--version' || command === '-v') console.log(VERSION);
  else usage();
} catch (error) {
  console.error(`error: ${error.message}`);
  if (String(error.message).includes('no debug endpoint') === false && command !== 'url' && command !== 'launch') {
    console.error('hint: run `cdp-clip launch` first, or use `cdp-clip url <https://...>` for a one-shot clip.');
  }
  process.exitCode = 1;
}
