const axios = require('axios');
const cheerio = require('cheerio');
const robotsParser = require('robots-parser');

const USER_AGENT = 'ChatWithWebsiteBot/1.0 (+https://example.com/bot)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = '';
    // strip trailing slash except for root, so /about and /about/ don't get crawled twice
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch (err) {
    return null;
  }
}

async function loadRobots(origin) {
  const robotsUrl = new URL('/robots.txt', origin).toString();
  try {
    const res = await axios.get(robotsUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 8000,
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 300) {
      return robotsParser(robotsUrl, res.data);
    }
  } catch (err) {
    // no robots.txt, or it didn't load - treat as "everything allowed"
  }
  return robotsParser(robotsUrl, '');
}

// Pulls the readable text out of a page, dropping nav/footer/scripts/etc so
// the index isn't full of "Home | About | Contact" boilerplate.
function extractContent(html, pageUrl) {
  const $ = cheerio.load(html);

  $('script, style, noscript, svg, nav, footer, header, aside, form, iframe, [role="navigation"], .cookie-banner, .cookie-consent').remove();

  const title = $('title').first().text().trim() || pageUrl;

  // Prefer <main> or [role=main] if the page has one, it's usually the real content
  let $root = $('main, [role="main"], article').first();
  if (!$root || $root.length === 0) {
    $root = $('body');
  }

  const text = $root
    .find('p, li, h1, h2, h3, h4, h5, h6, td, blockquote')
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 0)
    .join('\n');

  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) links.push(href);
  });

  return { title, text, links };
}

/**
 * Crawls a site breadth-first, staying on the same hostname, up to maxPages
 * or maxDepth, whichever comes first. Respects robots.txt and waits
 * crawlDelayMs (or whatever robots.txt asks for, if it's stricter) between
 * requests so we don't hammer the target.
 */
async function crawlSite(startUrl, options = {}) {
  const maxPages = options.maxPages || 25;
  const maxDepth = options.maxDepth || 3;
  const baseDelay = options.crawlDelayMs || 400;
  const onProgress = options.onProgress || (() => {});

  const start = normalizeUrl(startUrl);
  if (!start) {
    throw new Error('Invalid URL');
  }
  const origin = new URL(start).origin;
  const host = new URL(start).hostname;

  const robots = await loadRobots(origin);
  const robotsDelaySec = robots.getCrawlDelay(USER_AGENT);
  const delayMs = robotsDelaySec ? robotsDelaySec * 1000 : baseDelay;

  const visited = new Set();
  const queue = [{ url: start, depth: 0 }];
  const pages = [];

  while (queue.length > 0 && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    if (!robots.isAllowed(url, USER_AGENT)) {
      continue;
    }

    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000,
        validateStatus: (status) => status < 400,
      });

      const contentType = res.headers['content-type'] || '';
      if (!contentType.includes('text/html')) {
        continue;
      }

      const { title, text, links } = extractContent(res.data, url);

      if (text.length > 200) {
        pages.push({ url, title, text });
        onProgress({ pagesCrawled: pages.length, currentUrl: url });
      }

      if (depth < maxDepth) {
        for (const href of links) {
          let absolute;
          try {
            absolute = new URL(href, url).toString();
          } catch (err) {
            continue;
          }
          const normalized = normalizeUrl(absolute);
          if (!normalized) continue;

          const linkHost = new URL(normalized).hostname;
          if (linkHost !== host) continue; // stay on this site
          if (visited.has(normalized)) continue;
          if (/\.(pdf|jpg|jpeg|png|gif|svg|zip|mp4|mp3|css|js|ico|woff2?)$/i.test(normalized)) continue;

          queue.push({ url: normalized, depth: depth + 1 });
        }
      }
    } catch (err) {
      // one bad page shouldn't kill the whole crawl - skip and move on
      continue;
    }

    await sleep(delayMs);
  }

  return pages;
}

module.exports = { crawlSite, normalizeUrl };
