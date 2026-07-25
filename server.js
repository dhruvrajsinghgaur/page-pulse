import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { auditUrl, AuditError } from './src/audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Explicit root route as a safety net — express.static already serves
// index.html at "/" by default, but this makes it unambiguous rather than
// relying on that implicit behavior.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/audit', async (req, res) => {
  const { url } = req.body ?? {};
  try {
    const report = await auditUrl(url);
    return res.status(200).json({ ok: true, report });
  } catch (err) {
    if (err instanceof AuditError) {
      return res.status(err.statusCode).json({
        ok: false,
        error: { code: err.code, message: err.message },
      });
    }
    // Anything unexpected is logged server-side but never crashes the
    // process or leaks internals to the client.
    console.error('Unexpected error auditing URL:', err);
    return res.status(500).json({
      ok: false,
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong while auditing that URL.' },
    });
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Anything else unmatched gets a clear, consistent 404 instead of Express's
// bare "Cannot GET /..." text — helps distinguish a real routing miss from a
// host-level hiccup (e.g. a cold-start proxy response) when debugging.
app.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// Fail loudly for anything unhandled instead of letting Node crash silently.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Page Pulse listening on port ${PORT}`));
