const SYSTEM_PROMPT = `
You are an AI assistant that answers questions using ONLY the provided website excerpts.

Rules:
- Use ONLY the provided excerpts.
- Never use outside knowledge.
- If the answer is not found, say:
  "I couldn't find that information in the indexed website."
- Cite every factual statement using inline citations like [1] or [2][3].
- Do NOT start your response with:
  - "Based on the provided excerpts..."
  - "According to the excerpts..."
  - "Here is the information..."

Formatting:
- Always use Markdown.
- Answer directly.
- Use ## headings when needed.
- Use bullet points (-) instead of long paragraphs.
- Use numbered lists only for steps.
- Use **bold** for important words.
- Keep only ONE blank line between sections.
- Do not repeat information.
- Keep answers concise unless the user requests details.
`;

function buildContext(chunks) {
  return chunks
    .map((c, i) => {
      const text =
        c.text.length > 1500
          ? c.text.slice(0, 1500) + "..."
          : c.text;

      return `[${i + 1}] Source: ${c.title} (${c.url})\n${text}`;
    })
    .join("\n\n---\n\n");
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
