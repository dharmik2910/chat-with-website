const axios = require('axios');

// Using OpenRouter as the API gateway — it supports OpenAI-compatible models
// and works with both OpenAI keys (sk-) and OpenRouter keys (sk-or-).
const API_BASE = 'https://openrouter.ai/api/v1';
const EMBEDDING_MODEL = 'openai/text-embedding-3-small'; // OpenRouter prefix for OpenAI models
const CHAT_MODEL = 'google/gemma-4-26b-a4b-it:free';

// OpenRouter requires these headers for request attribution.
// HTTP-Referer identifies the app, X-Title identifies the user/team.
function openRouterHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://github.com/chat-with-website',
    'X-Title': 'chat-with-website',
  };
}

function client() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set - copy .env.example to .env and add your key');
  }
  return axios.create({
    baseURL: API_BASE,
    timeout: 30000, // 30s timeout to prevent socket hangs
    headers: openRouterHeaders(apiKey),
  });
}

// OpenAI puts the useful part of an error (e.g. "You exceeded your current
// quota") in the response body, not the status text - axios's default
// err.message is just "Request failed with status code 429" which hides
// that. This pulls the real reason out so it actually shows up in logs
// and in the UI.
function unwrapOpenAIError(err) {
  const apiMessage = err.response?.data?.error?.message;
  if (apiMessage) {
    const status = err.response.status;
    const wrapped = new Error(`OpenAI API error (${status}): ${apiMessage}`);
    wrapped.status = status;
    return wrapped;
  }
  return err;
}

// OpenAI's embeddings endpoint takes a batch of strings in one call, which is
// a lot faster than embedding one chunk at a time. We batch in groups of 100
// to stay well under request size limits.
async function embedTexts(texts) {
  const http = client();
  const batchSize = 100;
  const vectors = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    let res;
    try {
      res = await http.post('/embeddings', {
        model: EMBEDDING_MODEL,
        input: batch,
      });
    } catch (err) {
      throw unwrapOpenAIError(err);
    }
    for (const item of res.data.data) {
      vectors.push(item.embedding);
    }
  }

  return vectors;
}

async function embedQuery(text) {
  const vectors = await embedTexts([text]);
  return vectors[0];
}

// Streams a chat completion, calling onToken for each text delta as it arrives.
// Returns the full assembled text once the stream ends.
async function streamChat(messages, onToken) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set - copy .env.example to .env and add your key');
  }

  let res;
  try {
    res = await axios.post(
      `${API_BASE}/chat/completions`,
      {
        model: CHAT_MODEL,
        messages,
        temperature: 0.2,
        stream: true,
      },
      {
        headers: openRouterHeaders(apiKey),
        responseType: 'stream',
        timeout: 60000, // 60s for streaming responses (longer than embed since generation takes time)
      }
    );
  } catch (err) {
    // When using responseType 'stream', a failed request's error body arrives
    // as a stream (not parsed JSON). Read it manually so the real API error
    // message ("insufficient_quota", "rate_limit_exceeded", etc.) makes it
    // into the thrown error instead of just getting the status code.
    if (err.response?.data && typeof err.response.data.on === 'function') {
      try {
        const body = await new Promise((resolve) => {
          let raw = '';
          err.response.data.on('data', (c) => (raw += c.toString('utf8')));
          err.response.data.on('end', () => resolve(raw));
          err.response.data.on('error', () => resolve(''));
        });
        if (body) {
          try {
            err.response.data = JSON.parse(body);
          } catch (parseErr) {
            // body wasn't JSON — fall through, unwrapOpenAIError will re-throw
          }
        }
      } catch (streamErr) {
        // If reading the error stream itself fails, just proceed with the original error
      }
    }
    throw unwrapOpenAIError(err);
  }

  return new Promise((resolve, reject) => {
    let full = '';
    let buffer = '';

    res.data.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop(); // last line might be incomplete, keep it for next chunk

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            onToken(delta);
          }
        } catch (err) {
          // partial JSON that split across chunks - ignore, it'll complete next tick
        }
      }
    });

    res.data.on('end', () => resolve(full));
    res.data.on('error', reject);
  });
}

module.exports = { embedTexts, embedQuery, streamChat };
