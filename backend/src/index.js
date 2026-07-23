require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { crawlSite } = require('./crawler');
const { chunkPages } = require('./chunker');
const { embedTexts, embedQuery, streamChat } = require('./openai');
const store = require('./store');
const { buildMessages, sourcesFrom } = require('./rag');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 8080;

// Kicks off a crawl of the given site, chunks and embeds everything it finds,
// and stores it under a siteId derived from the hostname. This is synchronous
// from the client's point of view - for the page limits we default to
// (~25 pages) it usually finishes in well under a minute, which felt like a
// reasonable tradeoff over building out a job queue for a take-home.
// Helper: runs a promise with a timeout so a slow API call doesn't leave
// the client hanging on a socket timeout. The caller still gets the error
// back, it just won't wait forever for it.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label || 'request'} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

app.post('/api/crawl', async (req, res) => {
  const { url, maxPages, maxDepth } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch (err) {
    return res.status(400).json({ error: 'not a valid URL' });
  }

  try {
    const pages = await withTimeout(
      crawlSite(url, {
        maxPages: maxPages ? Number(maxPages) : Number(process.env.MAX_PAGES) || 25,
        maxDepth: maxDepth ? Number(maxDepth) : Number(process.env.MAX_DEPTH) || 3,
        crawlDelayMs: Number(process.env.CRAWL_DELAY_MS) || 400,
      }),
      120000, // 2 minutes for the crawl itself
      'crawl'
    );

    if (pages.length === 0) {
      return res.status(422).json({
        error: 'Could not find any readable pages on that site (check the URL, or robots.txt may be blocking everything).',
      });
    }

    const chunks = chunkPages(pages);
    const embeddings = await withTimeout(
      embedTexts(chunks.map((c) => c.text)),
      60000, // 1 minute for embedding generation
      'embedding'
    );

    const chunksWithEmbeddings = chunks.map((chunk, i) => ({
      ...chunk,
      embedding: embeddings[i],
    }));

    const siteId = store.siteIdFor(hostname);
    store.saveSite(siteId, {
      hostname,
      startUrl: url,
      crawledAt: new Date().toISOString(),
      chunks: chunksWithEmbeddings,
    });

    res.json({
      siteId,
      hostname,
      pageCount: pages.length,
      chunkCount: chunks.length,
    });
  } catch (err) {
    console.error('crawl failed:', err.message);
    res.status(500).json({ error: err.message || 'crawl failed' });
  }
});

// Streams the answer back over Server-Sent Events so the UI can render tokens
// as they arrive instead of waiting for the full response.
app.post('/api/chat', async (req, res) => {
  const { siteId, message, history } = req.body || {};

  if (!siteId || !message) {
    return res.status(400).json({ error: 'siteId and message are required' });
  }

  const site = store.loadSite(siteId);
  if (!site) {
    return res.status(404).json({ error: 'Unknown site - crawl it first' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const queryEmbedding = await embedQuery(message);
    const topChunks = store.search(siteId, queryEmbedding, 5);
    const sources = sourcesFrom(topChunks);

    const messages = buildMessages(topChunks, message, history || []);

    await streamChat(messages, (token) => {
      send('token', { token });
    });

    send('sources', { sources });
    send('done', {});
  } catch (err) {
    console.error('chat failed:', err.message);
    send('error', { error: err.message || 'chat failed' });
  } finally {
    res.end();
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
});
