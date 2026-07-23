const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// We're using a plain array in memory plus a JSON dump on disk instead of a
// real vector DB. For one site at a time with a few hundred chunks, brute
// force cosine similarity over an array is fast enough (a few milliseconds)
// and it means zero setup for anyone running this locally. Swapping in
// pgvector or Pinecone later would just mean replacing this file - the
// search() interface stays the same either way.
const sites = new Map(); // siteId -> { hostname, chunks: [{url, title, text, embedding}] }

function siteIdFor(hostname) {
  return crypto.createHash('sha1').update(hostname).digest('hex').slice(0, 12);
}

function filePath(siteId) {
  return path.join(DATA_DIR, `${siteId}.json`);
}

function saveSite(siteId, data) {
  sites.set(siteId, data);
  fs.writeFileSync(filePath(siteId), JSON.stringify(data));
}

function loadSite(siteId) {
  if (sites.has(siteId)) return sites.get(siteId);
  const file = filePath(siteId);
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    sites.set(siteId, data);
    return data;
  }
  return null;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function search(siteId, queryEmbedding, topK = 5) {
  const site = loadSite(siteId);
  if (!site) return [];

  const scored = site.chunks.map((chunk) => ({
    ...chunk,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

module.exports = { siteIdFor, saveSite, loadSite, search };
