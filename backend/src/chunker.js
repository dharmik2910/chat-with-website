// Simple paragraph-aware chunker. Not token-exact, but characters-as-a-proxy-for-tokens
// works fine at this scale and keeps the dependency list short.
const CHUNK_SIZE = 900; // roughly 200-250 tokens
const CHUNK_OVERLAP = 150;

function chunkText(text) {
  const paragraphs = text.split('\n').map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n' + para).length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current.trim());
      // carry the tail of the previous chunk forward for a bit of overlap,
      // so we don't lose context right at a chunk boundary
      const overlapStart = Math.max(0, current.length - CHUNK_OVERLAP);
      current = current.slice(overlapStart) + '\n' + para;
    } else {
      current = current ? current + '\n' + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // A single paragraph longer than CHUNK_SIZE (rare, but happens on dense pages)
  // gets hard-split so nothing sails past the limit unbounded.
  const final = [];
  for (const chunk of chunks) {
    if (chunk.length <= CHUNK_SIZE * 1.5) {
      final.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += CHUNK_SIZE) {
        final.push(chunk.slice(i, i + CHUNK_SIZE));
      }
    }
  }

  return final;
}

function chunkPages(pages) {
  const chunks = [];
  for (const page of pages) {
    const pieces = chunkText(page.text);
    pieces.forEach((text, i) => {
      chunks.push({
        url: page.url,
        title: page.title,
        chunkIndex: i,
        text,
      });
    });
  }
  return chunks;
}

module.exports = { chunkPages, chunkText };
