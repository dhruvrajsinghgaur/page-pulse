import { describe, it, expect, vi } from 'vitest';
import { parseHtml, auditUrl, validateUrl, faviconUrlFor, AuditError } from '../src/audit.js';

const SAMPLE_HTML = `
<!DOCTYPE html>
<html>
  <head>
    <title>  Sample Page  </title>
    <meta name="description" content="A short description of the page." />
    <link rel="canonical" href="/canonical-path" />
  </head>
  <body>
    <h1>Welcome</h1>
    <h1>Second heading</h1>
    <img src="a.png" alt="a decorative photo" />
    <img src="b.png" alt="" />
    <img src="c.png" />
    <p>This is some sample body copy with a handful of words in it.</p>
    <script>var x = 1; var y = 2; var z = 3;</script>
  </body>
</html>
`;

const NOT_FOUND_HTML = `
<!DOCTYPE html>
<html>
  <head><title>404 Not Found</title></head>
  <body><h1>Page not found</h1></body>
</html>
`;

function fakeResponse({ status = 200, contentType = 'text/html; charset=utf-8', body = SAMPLE_HTML } = {}) {
  return {
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

describe('parseHtml (happy path)', () => {
  it('extracts title, meta description, headings, alt-text gaps, and word count', () => {
    const report = parseHtml(SAMPLE_HTML);

    expect(report.title).toBe('Sample Page');
    expect(report.metaDescription).toBe('A short description of the page.');
    expect(report.h1Count).toBe(2);
    expect(report.totalImages).toBe(3);
    // b.png has alt="" (empty) and c.png has no alt attribute at all -> both count as missing
    expect(report.imagesMissingAlt).toBe(2);
    expect(report.wordCount).toBeGreaterThan(0);
  });

  it('excludes <script>/<style> text from the word count', () => {
    const report = parseHtml(SAMPLE_HTML);
    // "var x = 1; var y = 2; var z = 3;" would add ~9 words if not stripped
    expect(report.wordCount).toBeLessThan(20);
  });

  it('returns null for title/description when absent, rather than throwing', () => {
    const bareHtml = '<html><body><p>No head tags here.</p></body></html>';
    const report = parseHtml(bareHtml);
    expect(report.title).toBeNull();
    expect(report.metaDescription).toBeNull();
    expect(report.h1Count).toBe(0);
    expect(report.canonicalUrl).toBeNull();
  });

  it('resolves a relative canonical href against the base URL', () => {
    const report = parseHtml(SAMPLE_HTML, 'https://example.com/some/page');
    expect(report.canonicalUrl).toBe('https://example.com/canonical-path');
  });

  it('matches meta description regardless of attribute name casing', () => {
    const html = '<html><head><meta name="Description" content="Cased description" /></head><body></body></html>';
    const report = parseHtml(html);
    expect(report.metaDescription).toBe('Cased description');
  });
});

describe('faviconUrlFor', () => {
  it('builds a Google favicon service URL from a hostname', () => {
    const url = faviconUrlFor('example.com');
    expect(url).toBe('https://www.google.com/s2/favicons?domain=example.com&sz=64');
  });
});

describe('validateUrl', () => {
  it('accepts well-formed http/https URLs', () => {
    expect(() => validateUrl('https://example.com')).not.toThrow();
  });

  it('rejects malformed strings (failure case 1)', () => {
    expect(() => validateUrl('not a url')).toThrow(AuditError);
    try {
      validateUrl('not a url');
    } catch (err) {
      expect(err.code).toBe('INVALID_URL');
      expect(err.statusCode).toBe(400);
    }
  });

  it('rejects non-http(s) protocols such as ftp:// or javascript:', () => {
    expect(() => validateUrl('ftp://example.com/file')).toThrow(AuditError);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(AuditError);
  });

  it('rejects empty input', () => {
    expect(() => validateUrl('')).toThrow(AuditError);
    expect(() => validateUrl(undefined)).toThrow(AuditError);
  });
});

describe('auditUrl (integration, fetch mocked)', () => {
  it('returns a full report on a successful HTML fetch (happy path)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse());
    const report = await auditUrl('https://example.com', { fetchImpl });

    expect(report.httpStatus).toBe(200);
    expect(report.statusCategory).toBe('2xx');
    expect(report.isSuccess).toBe(true);
    expect(report.warning).toBeNull();
    expect(report.title).toBe('Sample Page');
    expect(report.canonicalUrl).toBe('https://example.com/canonical-path');
    expect(typeof report.responseTimeMs).toBe('number');
    expect(report.pageSizeBytes).toBe(Buffer.byteLength(SAMPLE_HTML, 'utf8'));
    expect(report.faviconUrl).toBe('https://www.google.com/s2/favicons?domain=example.com&sz=64');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('still parses a 404 HTML page, but flags it as unsuccessful with a warning', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ status: 404, body: NOT_FOUND_HTML }));
    const report = await auditUrl('https://example.com/missing', { fetchImpl });

    expect(report.httpStatus).toBe(404);
    expect(report.statusCategory).toBe('4xx');
    expect(report.isSuccess).toBe(false);
    expect(report.warning).toMatch(/404/);
    // The page is still parsed — title/H1 are present, just annotated as unreliable.
    expect(report.title).toBe('404 Not Found');
  });

  it('throws NOT_HTML for non-HTML responses without crashing (failure case 2)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      fakeResponse({ contentType: 'application/json', body: '{"ok":true}' })
    );

    await expect(auditUrl('https://api.example.com/data', { fetchImpl })).rejects.toMatchObject({
      code: 'NOT_HTML',
      statusCode: 415,
    });
  });

  it('throws TIMEOUT when the fetch is aborted (failure case 3)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abortError);

    await expect(auditUrl('https://slow.example.com', { fetchImpl, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'TIMEOUT',
      statusCode: 504,
    });
  });

  it('throws FETCH_FAILED for network-level errors (DNS, connection refused, etc.)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(auditUrl('https://does-not-exist.invalid', { fetchImpl })).rejects.toMatchObject({
      code: 'FETCH_FAILED',
      statusCode: 502,
    });
  });

  it('rejects invalid URLs before ever calling fetch', async () => {
    const fetchImpl = vi.fn();
    await expect(auditUrl('not-a-url', { fetchImpl })).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
