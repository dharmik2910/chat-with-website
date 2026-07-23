'use client';

import { useState, useRef, useEffect } from 'react';

function newId() {
  return Math.random().toString(36).slice(2);
}

// Reads a fetch() response body as Server-Sent Events and calls onEvent for
// each one. Not using EventSource here because it can't send a POST body.
async function readSSE(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split('\n\n');
    buffer = parts.pop();

    for (const part of parts) {
      const lines = part.split('\n');
      let event = 'message';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) data = line.slice(5).trim();
      }
      if (data) {
        try {
          onEvent(event, JSON.parse(data));
        } catch (err) {
          // ignore malformed chunk
        }
      }
    }
  }
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [maxPages, setMaxPages] = useState(25);
  const [maxDepth, setMaxDepth] = useState(3);
  const [crawling, setCrawling] = useState(false);
  const [log, setLog] = useState([]);
  const [site, setSite] = useState(null);
  const [crawlError, setCrawlError] = useState('');

  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  const messagesEndRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function appendLog(text, kind = '') {
    setLog((prev) => [...prev, { id: newId(), text, kind }]);
  }

  async function handleCrawl(e) {
    e.preventDefault();
    if (!url.trim() || crawling) return;

    setCrawling(true);
    setCrawlError('');
    setSite(null);
    setMessages([]);
    setLog([]);
    appendLog(`$ crawl ${url.trim()}`);
    appendLog(`respecting robots.txt, max ${maxPages} pages, depth ${maxDepth}...`);

    try {
      const res = await fetch('/api/crawl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), maxPages, maxDepth }),
      });
      const data = await res.json();

      if (!res.ok) {
        setCrawlError(data.error || 'Crawl failed');
        appendLog(`error: ${data.error || 'crawl failed'}`, 'err');
        return;
      }

      setSite(data);
      appendLog(`indexed ${data.pageCount} pages -> ${data.chunkCount} chunks`, 'ok');
      appendLog(`ready. ask a question below.`, 'ok');
    } catch (err) {
      setCrawlError('Could not reach the backend. Is it running?');
      appendLog('error: could not reach backend', 'err');
    } finally {
      setCrawling(false);
    }
  }

  async function handleSend(e) {
    e.preventDefault();
    const question = input.trim();
    if (!question || !site || sending) return;

    const userMsg = { id: newId(), role: 'user', content: question };
    const assistantMsg = { id: newId(), role: 'assistant', content: '', sources: [] };

    const history = messages.map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: site.siteId, message: question, history }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'chat request failed');
      }

      await readSSE(res, (event, data) => {
        if (event === 'token') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id ? { ...m, content: m.content + data.token } : m
            )
          );
        } else if (event === 'sources') {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantMsg.id ? { ...m, sources: data.sources } : m))
          );
        } else if (event === 'error') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsg.id
                ? { ...m, content: m.content || `Error: ${data.error}` }
                : m
            )
          );
        }
      });
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsg.id ? { ...m, content: `Error: ${err.message}` } : m
        )
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span className="brand-name">chat-with-website</span>
        </div>

        <form onSubmit={handleCrawl}>
          <label className="field-label" htmlFor="url">
            Site URL
          </label>
          <input
            id="url"
            className="url-input"
            type="url"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={crawling}
            required
          />

          <div style={{ height: 12 }} />

          <div className="advanced">
            <div className="field">
              <label className="field-label" htmlFor="maxPages">
                Max pages
              </label>
              <input
                id="maxPages"
                className="number-input"
                type="number"
                min="1"
                max="200"
                value={maxPages}
                onChange={(e) => setMaxPages(e.target.value)}
                disabled={crawling}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="maxDepth">
                Max depth
              </label>
              <input
                id="maxDepth"
                className="number-input"
                type="number"
                min="0"
                max="10"
                value={maxDepth}
                onChange={(e) => setMaxDepth(e.target.value)}
                disabled={crawling}
              />
            </div>
          </div>

          <div style={{ height: 14 }} />

          <button className="btn" type="submit" disabled={crawling} style={{ width: '100%' }}>
            {crawling ? 'Crawling...' : 'Crawl & Index'}
          </button>
        </form>

        {crawlError && <div className="error-box">{crawlError}</div>}

        {log.length > 0 && (
          <div className="log">
            {log.map((l) => (
              <p key={l.id} className={`log-line ${l.kind}`}>
                {l.text}
              </p>
            ))}
          </div>
        )}

        {site && (
          <div className="site-status">
            Indexed <strong>{site.hostname}</strong>
            <br />
            {site.pageCount} pages / {site.chunkCount} chunks
          </div>
        )}
      </aside>

      <main className="chat-panel">
        <div className="chat-header">
          <h1>
            {site ? <span className="active-site">{site.hostname}</span> : 'no site indexed yet'}
          </h1>
        </div>

        <div className="messages">
          {messages.length === 0 && (
            <div className="empty-state">
              <div className="signature">?</div>
              {site
                ? 'Ask anything about this site. Answers are grounded in what was crawled, with sources linked below each reply.'
                : 'Crawl a site on the left to get started.'}
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <span className="msg-role">{m.role}</span>
              <div className="msg-bubble">
                {m.content || (m.role === 'assistant' ? ' ' : '')}
                {m.role === 'assistant' && sending && m === messages[messages.length - 1] && (
                  <span className="cursor-blink" />
                )}
              </div>
              {m.sources && m.sources.length > 0 && (
                <div className="sources">
                  {m.sources.map((s) => (
                    <a
                      key={s.url}
                      className="source-pill"
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      [{s.number}] {s.title || s.url}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <form className="composer" onSubmit={handleSend}>
          <input
            className="composer-input"
            placeholder={site ? 'Ask a question about this site...' : 'Crawl a site first'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={!site || sending}
          />
          <button className="btn" type="submit" disabled={!site || sending}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}
