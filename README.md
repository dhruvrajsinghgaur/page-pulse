# Page Pulse

A small tool that audits any URL: HTTP status, response time, page title, meta
description, H1 count, images missing `alt` text, and approximate word count.

Built for the Digital Heroes SDE internship qualification task.

**Live demo:** https://page-pulse-dmmp.onrender.com
**Repo:** `github.com/dhruvrajsinghgaur/page-pulse`

---

## Setup

Requires Node.js 18+ (native `fetch` and `AbortController`).

```bash
npm install
npm start        # serves the app on http://localhost:3000
```

For local development with auto-restart:

```bash
npm run dev
```

Run the test suite:

```bash
npm test
```

### Deploying (free tier)

The easiest path is **Render**:

1. Push this folder to a public GitHub repo.
2. On [render.com](https://render.com), create a **New Web Service** → connect the repo.
3. Build command: `npm install`. Start command: `npm start`. That's it — Render
   auto-detects the Node runtime and free tier is sufficient for this tool.
4. Once deployed, copy the live URL into this README and your submission.

(Railway or Vercel's Node runtime work the same way — any host that runs
`npm start` on a Node 18+ box is fine.)

---

## API Contract

### `POST /api/audit`

**Request body**

```json
{ "url": "https://example.com" }
```

**Success — `200 OK`**

```json
{
  "ok": true,
  "report": {
    "url": "https://example.com/",
    "httpStatus": 200,
    "statusCategory": "2xx",
    "isSuccess": true,
    "warning": null,
    "responseTimeMs": 143,
    "pageSizeBytes": 1256,
    "faviconUrl": "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    "title": "Example Domain",
    "metaDescription": "This domain is for use in illustrative examples.",
    "canonicalUrl": "https://example.com/",
    "h1Count": 1,
    "totalImages": 0,
    "imagesMissingAlt": 0,
    "wordCount": 28
  }
}
```

When the page returns a non-2xx status (e.g. a custom 404 page that's still
valid HTML), the report is still built — `isSuccess` is `false` and `warning`
explains that the SEO values may not represent a real page, e.g.:

```json
{
  "httpStatus": 404,
  "statusCategory": "4xx",
  "isSuccess": false,
  "warning": "Page returned 404. SEO values may not represent a valid page."
}
```

**Failure — `4xx` / `5xx`**

```json
{
  "ok": false,
  "error": { "code": "INVALID_URL", "message": "\"not a url\" is not a valid URL." }
}
```

| `code`          | HTTP status | Meaning                                                        |
|-----------------|-------------|-----------------------------------------------------------------|
| `INVALID_URL`   | 400         | Missing, empty, malformed, or non-http(s) URL                   |
| `TIMEOUT`       | 504         | Target server didn't respond within 8s                          |
| `FETCH_FAILED`  | 502         | DNS failure, connection refused, TLS error, etc.                 |
| `NOT_HTML`      | 415         | Response `Content-Type` isn't `text/html` (e.g. a JSON API)      |
| `READ_FAILED`   | 502         | Response body couldn't be read after a successful connection    |
| `INTERNAL_ERROR`| 500         | Anything unanticipated — caught, logged server-side, never a crash |

The server process itself never crashes on a bad request: every failure path
above is caught and normalized before it reaches Express.

### `GET /api/health`

Returns `{ "ok": true }`. Useful for uptime checks on whichever host you deploy to.

---

## Design decisions

**1. `cheerio` for HTML parsing instead of regex.**
Titles, meta tags, and `alt` attributes can be spread across multiple lines,
self-closing or not, single- or double-quoted. A regex-based scraper breaks on
edge cases like `<title>\n  Multi-line\n</title>` or nested quotes inside an
attribute. `cheerio` gives a real DOM-like query API (`$('h1').length`,
`$(el).attr('alt')`) so the parsing logic reads like what it's doing, and edge
cases in malformed-but-valid HTML are handled by a battle-tested parser rather
than by me guessing at a regex.

**2. A single `AuditError` class with a machine-readable `code` and an HTTP `statusCode`, instead of throwing generic `Error`s.**
The task requires "sensible errors, never a crash" for at least three distinct
failure modes (invalid URL, timeout, non-HTML). If every failure path threw a
bare `Error`, the API layer would have to sniff error messages to decide what
HTTP status to return — fragile and easy to get wrong. By attaching `code` and
`statusCode` at the point where the error is *known* (inside `audit.js`), the
Express route becomes a dumb, reliable dispatcher: `if AuditError → use its
status; else → 500`. This is also what makes the error paths independently
unit-testable (`expect(...).rejects.toMatchObject({ code, statusCode })`)
without needing an actual HTTP server running.

**3. `AbortController` with an explicit timeout, and a strict content-type check *before* attempting to parse the body.**
Two failure modes the spec explicitly calls out — timeouts and non-HTML
responses — both come from things outside my control (a slow or non-page
server). Rather than let `fetch` hang indefinitely or let `cheerio` choke on a
binary/JSON payload, both are checked defensively: the abort fires at 8s, and
the `Content-Type` header is checked before the body is even read as text.
This trades a small amount of correctness (a mislabeled server that sends HTML
with the wrong content-type will be rejected) for a much stronger reliability
guarantee (the tool never hangs or throws on a non-HTML response) — the right
trade for a public-facing audit tool that fetches arbitrary user-supplied URLs.

**4. Reporting non-2xx statuses instead of treating them as either an error or a silent success.**
A 404 page is still valid HTML — title, meta tags, and H1s all parse fine —
so it would be wrong to throw an error for it. But it would also be
misleading to hand back a clean report with no indication that the page
being measured is an error page. The report is built either way, with
`isSuccess`/`statusCategory`/`warning` fields added so the *caller* decides
what to do with a non-200 response, rather than the tool silently deciding
for them.

**5. A belt-and-suspenders `onsubmit="return false"` on the form, in addition to the JS event handler.**
The single-page app relies on `script.js` intercepting the submit event to
call the API via `fetch`. If that script is ever slow to load or fails
silently (a flaky connection, a host's cold start, etc.), a plain HTML
`<form>` with no explicit `action` falls back to the browser's default
behavior: a full GET page reload with the form data appended as a query
string — which looks like a broken, unstyled page and does nothing useful.
Setting `action="javascript:void(0)"` and an inline `onsubmit="return false"`
means the form can never do that, regardless of whether the external script
has attached yet. This is a real bug I hit against the live deployment (a
momentary cold-start delay on the free host meant the JS hadn't loaded when
the form was submitted) — the fix generalizes to any host/network hiccup.

---

## What I'd change with another day

- **Redirect chain visibility.** Right now `fetch` follows redirects silently
  and only the final URL/status is reported. I'd surface the redirect chain
  (e.g. `301 → 200`) since that's genuinely useful audit information.
- **Per-IP rate limiting** on `/api/audit`, since this endpoint lets anyone
  make the server fetch arbitrary URLs — worth guarding against abuse before
  a wider public launch.
- **SSRF hardening.** Currently any http(s) URL is allowed, including ones
  that resolve to internal/private IP ranges. A production version should
  resolve the hostname and reject private/loopback ranges before fetching.

## Tests

`tests/audit.test.js` covers:
- **Happy path:** full metric extraction from a representative HTML sample,
  including that `<script>` content is excluded from the word count.
- **Failure case 1 — invalid URL:** malformed strings, empty input, and
  non-http(s) protocols are rejected with `INVALID_URL` before any network call.
- **Failure case 2 — non-HTML response:** a JSON API response is rejected with
  `NOT_HTML` rather than being handed to the HTML parser.
- **Failure case 3 — timeout / network failure:** a mocked `AbortError` maps to
  `TIMEOUT`, and a generic network failure maps to `FETCH_FAILED`.

`fetch` is injected as a parameter (`fetchImpl`) specifically so these cases
can be tested without making real network calls or spinning up a live server.
