# Chat with a Website

Give it a URL, it crawls the site (politely, staying on-domain), builds a small
vector index over the content, and lets you ask questions in a chat box.
Every answer is grounded in the crawled pages and cites which page(s) it
came from.

**Live demo:** https://chat-with-website-production-ae43.up.railway.app
**Backend API:** https://chat-with-website-6pgt.onrender.com

## Running it locally

Requires Node 18+ and an OpenAI API key (used for embeddings and chat
completions).

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
# edit .env and set NEXT_PUBLIC_API_URL=http://localhost:8080
npm install
npm run dev
```

Runs on `http://localhost:3000`, calling the backend at whatever URL is set
in `NEXT_PUBLIC_API_URL`. Open it, paste a site URL, hit "Crawl & Index",
then chat.

A site with a few dozen pages typically takes 15-60 seconds to crawl,
depending on crawl delay and page count.

## Deploying it

Backend and frontend deploy as two separate services (backend on Render,
frontend on Railway), each pointed at its own subfolder (`backend/` or
`frontend/`).

**Backend env vars**
- `OPENAI_API_KEY` — your OpenAI/OpenRouter key
- `FRONTEND_URL` — the deployed frontend origin, used for CORS
- `MAX_PAGES`, `MAX_DEPTH`, `CRAWL_DELAY_MS` — crawl defaults (optional)

**Frontend env vars**
- `NEXT_PUBLIC_API_URL` — the deployed backend URL

`NEXT_PUBLIC_*` variables are baked in at **build time** in Next.js, so
this must be set before the frontend is built — changing it later requires
a fresh build, not just a redeploy.

## How it works

**Crawling** (`backend/src/crawler.js`) — breadth-first, starting from the
given URL. Respects `robots.txt` (including `Crawl-delay`), stays on the
same hostname, skips non-HTML links, and caps page count/depth (default
25 pages, depth 3, both adjustable in the UI). A single bad page is
skipped rather than killing the crawl. Content extraction strips nav/
footer/header/script/style tags and prefers `<main>`/`<article>` when
present — a simple heuristic, not full readability parsing.

**Chunking** (`backend/src/chunker.js`) — splits page text on paragraph
boundaries into ~900-character chunks with ~150-character overlap, so
answers spanning a chunk boundary don't lose context.

**Retrieval** (`backend/src/store.js`) — chunks are embedded with
`text-embedding-3-small` and stored in memory, with a JSON dump per site
on disk so you don't need to re-crawl after a restart. Queries are
compared against every stored chunk via brute-force cosine similarity —
no ANN index, since a capped ~25-50 page site only produces a few hundred
chunks, well within sub-millisecond brute-force territory. `search()` is
the one place that would need to change to swap in a real vector DB.

**Grounding** (`backend/src/rag.js`) — the top 5 chunks go into the prompt
as numbered, cited excerpts. The model is instructed to answer only from
those excerpts, cite claims inline with `[n]`, and say plainly when the
site doesn't cover something. Every response returns a source list
(URL + title) so the UI can render clickable citations regardless of what
the model cited inline. Combined with low temperature (0.2) and an
explicit "I don't know" option, this holds up well in practice — though
it isn't a hallucination guarantee.

**Streaming** — chat responses stream token-by-token over Server-Sent
Events (`POST /api/chat`, not `EventSource`, since SSE via GET can't carry
a request body).

## What works

- Crawling respects `robots.txt` and stays scoped to the domain.
- Chat is grounded and cites sources; off-topic questions get an honest
  "the site doesn't cover that" instead of a made-up answer.
- Streaming feels responsive.

## What I'd improve with more time

- **JS-rendered sites aren't handled** — the crawler does a plain HTTP GET
  and parses static HTML with Cheerio, so client-rendered sites (a lot of
  React/Vue marketing pages) index as mostly empty. Fix: a headless
  browser (Playwright) for fetching, at the cost of crawl speed.
- **Boilerplate stripping is heuristic**, not semantic — it won't catch
  cookie banners or sidebars outside known structural tags. A
  readability-style content-scoring algorithm would do better.
- **Long pages can lose retrieval precision** — a very long page becomes
  many chunks, and top-5 retrieval can miss one if an answer needs to
  synthesize across several. Worth trying a higher k for long pages, or a
  re-ranking step over a larger candidate set.
- **No eval yet** — I'd add question/expected-source pairs per test site
  and script a check that top-k retrieval includes the expected URL, as a
  fast regression check when tuning chunk size or k.
- **Crawl blocks the request until it finishes** — fine at 25 pages, but a
  bigger crawl should be a background job with a progress endpoint
  instead of one long-held HTTP request.
- **In-memory + JSON-file storage** works for one site at a time locally
  but won't scale past a handful of sites or survive concurrent writes.
  Swapping in pgvector would be the first production step.

## Notes on ambiguous calls

- Defaulted to 25 pages / depth 3 as a "sensible" crawl limit, but exposed
  both as UI inputs since the right value depends on the site.
- Chat history is trimmed to the last 6 turns before being sent to the
  model, bounding prompt size while still supporting follow-ups.
- A site is keyed by hostname (hashed to a short id), so re-crawling the
  same domain overwrites its previous index rather than accumulating
  duplicates.
