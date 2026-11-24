# cdp-clip

**Clip any browser tab to clean Markdown — straight from the Chrome DevTools Protocol.**

One file. Zero dependencies. No extension, no bookmarklet, no login hand-off.

It reads pages you are already signed into, runs fully headless, and drops straight into an
LLM / RAG pipeline.

[中文说明](README.zh-CN.md)

---

## The problem

Every "web page to Markdown" tool asks you to install something: an extension, a bookmarklet,
a Puppeteer script with 300 MB of `node_modules`. Each has a wall:

- **Extensions** need host permissions, break on sites with a strict `Content-Security-Policy`,
  and go through a store review for every change.
- **Copy-paste** keeps the words but loses the structure — code blocks, tables, nested lists
  and links all arrive as flat text.
- **Puppeteer / Playwright** work, but you ship a browser download just to read one page.

## Why CDP

Chrome, Edge, Brave — every Chromium browser already exposes a remote-control protocol.
`cdp-clip` opens one socket to it and runs a single `Runtime.evaluate` to extract the article.
That means:

| | Browser extension | Copy-paste | `cdp-clip` |
|---|---|---|---|
| Works on logged-in / intranet pages | sometimes (CSP blocks it) | yes | **yes** |
| Keeps code blocks, tables, nested lists | yes | no | **yes** |
| Runs headless in CI or a cron job | no | no | **yes** |
| Installs anything | 1 extension | nothing | **nothing** |
| Touches cookies or credentials | requests host access | no | **no** |

Read-only by construction: one evaluate call, no clicking, no navigation, no cookie reads,
no injected script left behind.

## Quick start

```bash
git clone https://github.com/Sunney-fly/cdp-clip.git
cd cdp-clip

# one-shot: launch a throwaway headless browser, clip the page, exit
node cdp-clip.mjs url https://nodejs.org/api/stream.html --stdout

# or install it globally
npm i -g .
cdp-clip url https://example.com
```

Requirements: **Node >= 22** (built-in `fetch` + `WebSocket`) and any installed Chromium
browser (Edge / Chrome / Brave / Chromium — auto-detected). Nothing else.

## Two modes

### 1. `url` — fire and forget

Launches a temporary browser with its own throwaway profile, opens the URL, waits for
hydration, clips, and shuts the browser down. Use it for scripts:

```bash
cdp-clip url https://example.com/article --out=./notes
cdp-clip url https://example.com/article --json | jq -r .markdown
```

### 2. `clip` — the tab you are looking at

For pages behind a login. Start a browser with a debug port, sign in normally, then clip:

```bash
cdp-clip launch                 # opens Edge/Chrome with --remote-debugging-port=9222
#   ... sign in, open the page you want ...
cdp-clip clip                   # clips the focused tab
cdp-clip clip --tab=docs        # or a tab whose title/URL matches "docs"
cdp-clip list                   # see what is clip-able
```

The debug port only listens on `127.0.0.1`. Use a dedicated profile
(`cdp-clip launch` keeps one in your temp dir) and avoid clipping banking sessions.

## Output

```markdown
---
title: "Stream | Node.js v26.13.1 Documentation"
url: "https://nodejs.org/api/stream.html"
host: "nodejs.org"
clipped_at: "2026-11-24T04:08:37.573Z"
words: 24590
tokens_est: 31967
lang: "en"
source: cdp-clip
---

# Stream | Node.js v26.13.1 Documentation

> Source: https://nodejs.org/api/stream.html
> Clipped: 2026-11-24 04:08:37 (nodejs.org, ~24590 words, ~31967 tokens)

## Stream

**Source Code:** [lib/stream.js](https://github.com/nodejs/node/blob/main/lib/stream.js) ...
```

`tokens_est` is a rough budget number (Latin words ≈ 1.3 tokens, CJK characters ≈ 1 each),
so you can tell whether a page fits a context window before feeding it to a model.

## Options

| Flag | Applies to | Meaning |
|---|---|---|
| `--out=<dir>` | `clip`, `url` | Output directory (default `./clips`) |
| `--stdout` | `clip`, `url` | Print the document instead of writing a file |
| `--json` | `clip`, `url` | Print metadata + Markdown as JSON |
| `--no-frontmatter` | `clip`, `url` | Skip the YAML block |
| `--tab=<n\|substring>` | `clip` | Pick a tab by index (`list` order) or title/URL substring |
| `--port=<n>` | `clip`, `list`, `status`, `open` | Debug port (default `9222`) |
| `--browser=<edge\|chrome\|brave\|chromium>` | `url`, `launch` | Force a browser binary |
| `--headed` | `url` | Show the window (default is headless) |
| `--wait=<ms>` | `url` | Extra settle time for late hydration |
| `CDP_CLIP_BROWSER` (env) | all | Absolute path to a browser binary |

## What it keeps and what it drops

1. Scores candidate containers (`article`, `main`, `[role=main]`, `.entry-content`,
   `.markdown-body`, `#content`, …) by `text length − 1.5 × link text`, so prose beats link farms.
   Falls back to `<body>` when nothing scores well.
2. Drops `script`, `style`, `nav`, `footer`, `aside`, `header`, `iframe`, `form`, media elements
   and heading permalinks.
3. Renders headings, paragraphs, nested lists, blockquotes, fenced code (with the language from
   `class="language-*"`), tables, images (absolute URLs), bold / italic / strikethrough / links.

## Limits — read this before filing an issue

- **Cross-origin iframes are not read.** The main frame only.
- **PDFs are not converted.** The debug browser renders PDFs in a viewer; there is no article DOM.
- **Canvas / WebGL apps and DRM video pages** have no extractable text.
- **Heavy SPAs** may need `--wait=2000` (or more) before hydration finishes.
- A page behind a login wall, clipped in `url` mode, is exactly that: a login wall.
  Use `clip` mode with a signed-in browser instead.

## Design notes

- **Zero dependencies is a feature, not a stunt.** `fetch` and `WebSocket` are in Node 22;
  an extractor that needs `jsdom` + `readability` + `cheerio` is 40 MB to do the same job.
- **One `Runtime.evaluate`, not `DOM.getOuterHTML`.** The page serialises itself to Markdown
  inside the tab; only the result crosses the wire. Large pages stay under a few hundred KB.
- **No `Page.navigate` in attach mode.** Clipping a tab you are looking at must not change
  what that tab is showing.

## License

MIT
