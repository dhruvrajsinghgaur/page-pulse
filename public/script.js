const form = document.getElementById('audit-form');
const input = document.getElementById('url-input');
const submitBtn = document.getElementById('submit-btn');
const statusEl = document.getElementById('status');
const reportEl = document.getElementById('report');

function setStatus(message, kind) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.innerHTML = '';
    statusEl.className = 'status';
    return;
  }
  statusEl.hidden = false;
  statusEl.className = `status ${kind}`;
  statusEl.innerHTML = kind === 'loading'
    ? `<span class="spinner"></span><span>${escapeHtml(message)}</span>`
    : escapeHtml(message);
}

function metricCard(icon, label, value, tone) {
  return `
    <div class="metric">
      <div class="label"><span>${icon}</span>${label}</div>
      <div class="value ${tone ?? ''}">${value}</div>
    </div>`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fieldBlock(label, value) {
  const isMissing = value === null || value === undefined || value === '';
  return `
    <div class="field-block">
      <div class="label">${label}</div>
      <div class="value ${isMissing ? 'missing' : ''}">${isMissing ? 'Not found' : escapeHtml(value)}</div>
    </div>`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderReport(report) {
  const dotClass = report.isSuccess ? 'good' : (report.statusCategory === '3xx' ? 'warn' : 'bad');
  const statusTone = report.isSuccess ? 'good' : 'warn';
  const altTone = report.imagesMissingAlt > 0 ? 'warn' : 'good';

  reportEl.hidden = false;
  reportEl.innerHTML = `
    <div class="title-row">
      <img class="favicon" src="${escapeHtml(report.faviconUrl)}" alt="" onerror="this.style.display='none'" />
      <h2>${escapeHtml(report.title || report.url)}</h2>
    </div>
    <div class="url-line">${escapeHtml(report.url)}</div>
    ${report.warning ? `<div class="warning-banner">⚠️ <span>${escapeHtml(report.warning)}</span></div>` : ''}
    <div class="metric-grid">
      ${metricCard('🌐', 'HTTP Status', `<span class="status-dot ${dotClass}"></span>${report.httpStatus} <span style="font-weight:400;color:var(--muted);font-size:0.85rem">(${report.statusCategory})</span>`, statusTone)}
      ${metricCard('⚡', 'Response Time', `${report.responseTimeMs} ms`)}
      ${metricCard('📄', 'H1 Count', report.h1Count)}
      ${metricCard('🖼', 'Images w/o Alt', `${report.imagesMissingAlt} / ${report.totalImages}`, altTone)}
      ${metricCard('📝', 'Word Count', report.wordCount)}
      ${metricCard('💾', 'Page Size', formatBytes(report.pageSizeBytes))}
    </div>
    ${fieldBlock('Meta Description', report.metaDescription)}
    ${fieldBlock('Canonical URL', report.canonicalUrl)}
  `;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = input.value.trim();
  if (!url) return;

  reportEl.hidden = true;
  submitBtn.disabled = true;
  setStatus('Auditing…', 'loading');

  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      setStatus(data.error?.message || 'Something went wrong.', 'error');
      return;
    }

    setStatus(null);
    renderReport(data.report);
  } catch (err) {
    setStatus('Network error — could not reach the Page Pulse server.', 'error');
  } finally {
    submitBtn.disabled = false;
  }
});
