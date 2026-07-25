import * as cheerio from 'cheerio';

/**
 * AuditError carries a machine-readable `code` and an HTTP `statusCode`
 * so the API layer never has to guess what went wrong or leak a stack trace.
 */
export class AuditError extends Error {
  constructor(code, message, statusCode) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = 'PagePulse/1.0 (+https://github.com/dhruvrajsinghgaur/page-pulse)';

/**
 * Validates a raw string is a fetchable http(s) URL.
 * Throws AuditError('INVALID_URL', ..., 400) otherwise.
 */
export function validateUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new AuditError('INVALID_URL', 'A non-empty "url" field is required.', 400);
  }
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new AuditError('INVALID_URL', `"${rawUrl}" is not a valid URL.`, 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AuditError('INVALID_URL', 'Only http:// and https:// URLs are supported.', 400);
  }
  return parsed;
}

/**
 * Builds a favicon URL via Google's public favicon service. No extra fetch
 * needed — it's a pure URL construction from the page's hostname.
 */
export function faviconUrlFor(hostname) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=64`;
}

/**
 * Parses raw HTML into the audit metrics. Pure function, no I/O — this is
 * the part covered directly by unit tests.
 *
 * @param {string} html
 * @param {string} [baseUrl] used to resolve a relative <link rel="canonical"> href
 *   into an absolute URL. If omitted, a relative canonical href is returned as-is.
 */
export function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  const title = $('title').first().text().trim() || null;

  // Case-insensitive attribute match ([name="description" i]) so sites that
  // write name="Description" (or any other casing) are still picked up.
  const metaDescriptionRaw = $('meta[name="description" i]').attr('content');
  const metaDescription = metaDescriptionRaw ? metaDescriptionRaw.trim() : null;

  const canonicalHref = $('link[rel="canonical" i]').attr('href');
  let canonicalUrl = null;
  if (canonicalHref) {
    try {
      canonicalUrl = baseUrl ? new URL(canonicalHref, baseUrl).toString() : canonicalHref;
    } catch {
      canonicalUrl = canonicalHref; // keep the raw value rather than dropping it
    }
  }

  const h1Count = $('h1').length;

  const images = $('img');
  let imagesMissingAlt = 0;
  images.each((_, el) => {
    const alt = $(el).attr('alt');
    if (alt === undefined || alt.trim() === '') imagesMissingAlt += 1;
  });

  // Strip script/style content before counting words so JS/CSS text doesn't
  // inflate the word count.
  $('script, style, noscript').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const wordCount = bodyText ? bodyText.split(' ').filter(Boolean).length : 0;

  return {
    title,
    metaDescription,
    canonicalUrl,
    h1Count,
    totalImages: images.length,
    imagesMissingAlt,
    wordCount,
  };
}

/**
 * Fetches a URL and returns the full Page Pulse report.
 * Never throws a raw/unexpected error to the caller — all failure paths
 * are normalized into AuditError with a code + status the API can trust.
 */
export async function auditUrl(rawUrl, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const parsed = validateUrl(rawUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // performance.now() is a monotonic high-resolution clock — unlike Date.now()
  // it can't be skewed by system clock adjustments (NTP sync, DST, etc.),
  // which matters for a metric whose whole point is measuring elapsed time.
  const start = performance.now();
  let response;
  try {
    response = await fetchImpl(parsed.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT },
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new AuditError('TIMEOUT', `Request timed out after ${timeoutMs}ms.`, 504);
    }
    throw new AuditError('FETCH_FAILED', `Could not reach the URL: ${err.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  const responseTimeMs = Math.round(performance.now() - start);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new AuditError(
      'NOT_HTML',
      `Expected an HTML page but received content-type "${contentType || 'unknown'}".`,
      415
    );
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    throw new AuditError('READ_FAILED', 'Failed to read the response body.', 502);
  }

  const report = parseHtml(html, parsed.toString());

  const statusCategory = `${Math.floor(response.status / 100)}xx`;
  const isSuccess = response.status >= 200 && response.status < 300;
  const warning = isSuccess
    ? null
    : `Page returned ${response.status}. SEO values may not represent a valid page.`;

  return {
    url: parsed.toString(),
    httpStatus: response.status,
    statusCategory,
    isSuccess,
    warning,
    responseTimeMs,
    pageSizeBytes: Buffer.byteLength(html, 'utf8'),
    faviconUrl: faviconUrlFor(parsed.hostname),
    ...report,
  };
}
