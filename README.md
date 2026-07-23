# Chat with a Website

Give it a URL, it crawls the site (politely, staying on-domain), builds a small
vector index over the content, and lets you ask questions in a chat box.
Every answer is grounded in the crawled pages and cites which page(s) it
came from.

## Running it

You need Node 18+ and an OpenAI API key (used for embeddings and chat
completions - any account with API access works).

**Backend**

```bash
cd backend
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm install
npm run dev
```

Runs on `http://localhost:8080`.

**Frontend**

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

Runs on `http://localhost:3000` and proxies `/api/*` to the backend (see
`next.config.js`). Open it, paste a URL, hit "Crawl & Index", then chat.

I tested this against a few small documentation sites (a few dozen pages).
On a site that size a crawl takes somewhere between 15-60 seconds depending
on the crawl delay and page count.

## How it works

### Crawling

`backend/src/crawler.js` does a breadth-first crawl starting from the given
URL:

- Fetches `robots.txt` first and checks every URL against it before
  fetching. If the site sets a `Crawl-delay`, that's used instead of the
  default delay.
- Stays on the same hostname as the start URL - links to other domains are
  dropped, so it never wanders off the site.
- Hard caps on page count and depth (defaults: 25 pages, depth 3), both
  configurable from the sidebar in the UI. This is the main lever for
  "don't hammer the target site" along with a delay between requests
  (defaults to 400ms, or whatever `robots.txt` asks for).
- Skips obvious non-HTML links (images, PDFs, stylesheets, etc.) before
  queuing them, and checks `Content-Type` on the response as a second
  guard.
- One bad page (timeout, 404, whatever) just gets skipped rather than
  killing the whole crawl.

Boilerplate stripping is intentionally simple: it removes `<nav>`,
`<footer>`, `<header>`, `<script>`, `<style>`, and a few similar tags before
extracting text, and prefers `<main>`/`[role=main]`/`<article>` if the page
has one. It's a decent first pass, not a full readability algorithm - see
"What I'd improve" below.

### Chunking

`backend/src/chunker.js` splits each page's text on paragraph boundaries
and greedily packs paragraphs into ~900-character chunks with a ~150
character overlap between consecutive chunks, so an answer that straddles a
chunk boundary doesn't lose context. This is character-based rather than
token-based - close enough at this scale, and it avoids pulling in a
tokenizer dependency for a take-home.

### Retrieval

Chunks are embedded with `text-embedding-3-small` and stored in memory as
plain JS objects (`backend/src/store.js`), with a JSON dump per site on
disk so you don't have to re-crawl after restarting the backend. At query
time the question gets embedded and compared against every stored chunk
with cosine similarity - brute force, no ANN index.

I chose this over a real vector DB deliberately: the assignment is one site
at a time, and a site capped at ~25-50 pages turns into a few hundred
chunks at most. Brute-force cosine similarity over a few hundred vectors is
sub-millisecond in JS, so an ANN index would add setup and dependency
weight without buying anything at this scale. The `search()` function is
the only place that would need to change to swap in pgvector or a hosted
vector DB later - everything else is unaware of how retrieval works
internally.

### Keeping answers grounded

`backend/src/rag.js` builds the prompt: the top 5 retrieved chunks go in as
numbered, cited excerpts, and the system prompt instructs the model to
answer only from those excerpts, cite every claim inline with `[n]`, and
say plainly when the site doesn't cover something rather than guessing.
The chat endpoint always returns the source list (URL + title) alongside
the answer, deduplicated by page, so the UI can render clickable citations
under each reply regardless of what the model actually cited inline.

This doesn't *guarantee* zero hallucination - nothing short of a stricter
verification pass would - but combined with a low temperature (0.2) and a
prompt that gives the model an explicit "I don't know" option, it holds up
well in practice on the sites I tried it against.

### Streaming

Chat responses stream token-by-token over Server-Sent Events
(`POST /api/chat`, not `EventSource` since that can't send a body) so the
UI shows the answer as it's generated instead of waiting for the full
response.

## What works

- Crawling respects robots.txt and stays scoped to the domain.
- Chat is grounded and cites sources; asking about something off-topic
  gets an honest "the site doesn't cover that" instead of a made-up answer.
- Streaming feels responsive.

## What doesn't, and what I'd improve with more time

- **JS-rendered sites aren't handled.** The crawler does a plain HTTP GET
  and parses static HTML with Cheerio - a site that renders its content
  client-side (a lot of React/Vue marketing sites) will index as mostly
  empty. Fixing this means a headless browser (Playwright) for the fetch
  step, at the cost of a much slower crawl.
- **Boilerplate stripping is heuristic, not semantic.** It removes known
  structural tags but doesn't detect things like repeated cookie banners
  that aren't in a `<footer>`, or sidebars that aren't tagged `<aside>`. A
  readability-style content-scoring algorithm (what Firefox's Reader Mode
  uses) would do better.
- **Long pages lose some retrieval precision.** A single very long page
  becomes many chunks, and if the answer needs to synthesize across
  several of them, top-5 retrieval can miss one. I'd try increasing k for
  long-page sites, or adding a re-ranking step (cross-encoder over the
  top ~20 candidates before picking 5).
- **No eval yet.** I'd add a small set of question / expected-source pairs
  per test site and script it to check that the top-k retrieved chunks
  include the expected URL - a fast regression check for retrieval
  quality when tuning chunk size or k.
- **Crawl is synchronous from the client's perspective** - the request
  blocks until the whole crawl finishes. Fine at 25 pages, but for a
  bigger crawl I'd move this to a background job with a progress endpoint
  the UI polls, rather than holding one HTTP request open.
- **In-memory + JSON-file store is fine for one site at a time locally**,
  but doesn't scale past a handful of sites or survive concurrent writes.
  Swapping in pgvector would be the first thing I'd do before this went
  anywhere near production.

## Notes on ambiguous calls

- "Sensible page or depth limit" - I defaulted to 25 pages / depth 3, but
  exposed both as inputs in the UI since what's "sensible" really depends
  on the site.
- Chat history is trimmed to the last 6 turns before being sent to the
  model, to keep prompt size bounded on longer conversations while still
  supporting follow-up questions.
- A site is keyed by hostname (hashed to a short id), so re-crawling the
  same domain overwrites its previous index rather than accumulating
  duplicates.
