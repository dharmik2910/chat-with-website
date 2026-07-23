const SYSTEM_PROMPT = `You are a helpful assistant that answers questions using ONLY the excerpts
provided below, taken from a website the user has already crawled and indexed.

Rules:
- Base your answer strictly on the excerpts. Do not use outside knowledge, and do not guess.
- Every claim you make should be traceable to one of the excerpts. Cite the excerpt(s) you
  used inline with bracketed numbers, e.g. [1] or [2][3], right after the relevant sentence.
- If the excerpts don't contain enough information to answer the question, say so plainly
  ("The site doesn't seem to cover that") instead of inventing an answer.
- Keep answers concise and directly responsive to the question.`;

function buildContext(chunks) {
  return chunks
    .map((c, i) => `[${i + 1}] Source: ${c.title} (${c.url})\n${c.text}`)
    .join('\n\n---\n\n');
}

function buildMessages(chunks, question, history = []) {
  const context = buildContext(chunks);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'system',
      content: `Excerpts from the site:\n\n${context || '(no relevant excerpts found)'}`,
    },
  ];

  // keep prior turns for follow-up questions, but trim to the last few
  // so the prompt doesn't grow unbounded over a long conversation
  const recentHistory = history.slice(-6);
  for (const turn of recentHistory) {
    messages.push({ role: turn.role, content: turn.content });
  }

  messages.push({ role: 'user', content: question });

  return messages;
}

// De-dupes retrieved chunks that map back to the same source page, so the
// citation list shown to the user doesn't repeat a URL five times.
function sourcesFrom(chunks) {
  const seen = new Map();
  chunks.forEach((c, i) => {
    if (!seen.has(c.url)) {
      seen.set(c.url, { number: i + 1, url: c.url, title: c.title });
    }
  });
  return Array.from(seen.values());
}

module.exports = { buildMessages, sourcesFrom, SYSTEM_PROMPT };
