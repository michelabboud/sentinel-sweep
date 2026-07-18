import { readFileSync } from 'node:fs';

import { SentinelError } from './lib/errors.mjs';
import { validateAgainstSchema } from './lib/schema.mjs';

const FINDINGS_SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/findings.schema.json', import.meta.url), 'utf8'),
);
const SUMMARY_ROWS = [
  ['Critical', 'critical'],
  ['Error', 'error'],
  ['Warning', 'warning'],
  ['Info', 'info'],
  ['Skipped', 'skipped'],
];
const EVIDENCE_FIELDS = [
  'expected',
  'actual',
  'statusCode',
  'durationMs',
  'viewport',
  'screenshotPath',
];

function reportError() {
  return new SentinelError(
    'FINDINGS_DOCUMENT_INVALID',
    'Report input is not a canonical Sentinel findings document',
  );
}

function validateFindings(findings) {
  try {
    validateAgainstSchema(findings, FINDINGS_SCHEMA, { name: 'findings' });
  } catch {
    throw reportError();
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\u2028', '&#8232;')
    .replaceAll('\u2029', '&#8233;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, (
      character,
    ) => `&#${character.codePointAt(0)};`);
}

function escapeMarkdown(value) {
  return escapeHtml(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll('`', '\\`')
    .replace(/[\[\]()*!#~]/gu, '\\$&')
    .replace(/(?<![A-Za-z0-9])_|_(?![A-Za-z0-9])/gu, '\\$&');
}

function evidenceText(evidence) {
  const fields = [];
  for (const name of EVIDENCE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(evidence, name)) {
      fields.push(`${name}=${String(evidence[name])}`);
    }
  }
  return fields.length === 0 ? 'none' : fields.join('; ');
}

function markdownSummary(summary) {
  return [
    '| Result | Count |',
    '| --- | ---: |',
    ...SUMMARY_ROWS.map(([label, key]) => `| ${label} | ${summary[key]} |`),
  ].join('\n');
}

function markdownDiagnostics(coverage) {
  if (coverage.diagnostics.length === 0) return 'None.';
  return [
    '| Code | Source | Pointer | Message |',
    '| --- | --- | --- | --- |',
    ...coverage.diagnostics.map((diagnostic) => [
      diagnostic.code,
      diagnostic.sourcePath ?? 'unknown',
      diagnostic.pointer ?? 'unknown',
      diagnostic.message,
    ].map(escapeMarkdown).join(' | ')).map((row) => `| ${row} |`),
  ].join('\n');
}

function markdownFindings(findings) {
  if (findings.length === 0) return 'No findings.';
  return [
    '| Severity | Category | Subject | Role | Service | Message | Evidence |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...findings.map((finding) => [
      finding.severity,
      finding.category,
      `${finding.subject.type}:${finding.subject.id}`,
      finding.role ?? 'unauthenticated',
      finding.service ?? 'default',
      finding.message,
      evidenceText(finding.evidence),
    ].map(escapeMarkdown).join(' | ')).map((row) => `| ${row} |`),
  ].join('\n');
}

/** Renders the canonical human-readable report without recomputing any counts. */
export function renderMarkdown(findings) {
  validateFindings(findings);
  return [
    '# Sentinel sweep report',
    '',
    `- Run: \`${escapeMarkdown(findings.runId)}\``,
    `- Coverage: \`${escapeMarkdown(findings.coverage.status)}\``,
    `- Started: \`${escapeMarkdown(findings.startedAt)}\``,
    `- Finished: \`${escapeMarkdown(findings.finishedAt)}\``,
    '',
    '## Summary',
    '',
    markdownSummary(findings.summary),
    '',
    '## Coverage diagnostics',
    '',
    markdownDiagnostics(findings.coverage),
    '',
    '## Findings',
    '',
    markdownFindings(findings.findings),
    '',
  ].join('\n');
}

function htmlSummary(summary) {
  return SUMMARY_ROWS.map(([label, key]) => (
    `<div class="metric metric-${key}"><strong>${summary[key]}</strong><span>${label}</span></div>`
  )).join('');
}

function htmlDiagnostics(coverage) {
  if (coverage.diagnostics.length === 0) return '<p>None.</p>';
  const rows = coverage.diagnostics.map((diagnostic) => (
    `<tr><td>${escapeHtml(diagnostic.code)}</td>`
      + `<td>${escapeHtml(diagnostic.sourcePath ?? 'unknown')}</td>`
      + `<td>${escapeHtml(diagnostic.pointer ?? 'unknown')}</td>`
      + `<td>${escapeHtml(diagnostic.message)}</td></tr>`
  )).join('');
  return '<table><thead><tr><th>Code</th><th>Source</th><th>Pointer</th><th>Message</th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlFindings(findings) {
  if (findings.length === 0) return '<p>No findings.</p>';
  const rows = findings.map((finding) => (
    `<tr><td>${escapeHtml(finding.severity)}</td>`
      + `<td>${escapeHtml(finding.category)}</td>`
      + `<td>${escapeHtml(`${finding.subject.type}:${finding.subject.id}`)}</td>`
      + `<td>${escapeHtml(finding.role ?? 'unauthenticated')}</td>`
      + `<td>${escapeHtml(finding.service ?? 'default')}</td>`
      + `<td>${escapeHtml(finding.message)}</td>`
      + `<td>${escapeHtml(evidenceText(finding.evidence))}</td></tr>`
  )).join('');
  return '<table><thead><tr><th>Severity</th><th>Category</th><th>Subject</th><th>Role</th>'
    + `<th>Service</th><th>Message</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function safeEmbeddedJson(value) {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

/** Renders a self-contained, non-executable static dashboard. */
export function renderDashboard(findings) {
  validateFindings(findings);
  const embeddedSummary = safeEmbeddedJson(findings.summary);
  return '<!doctype html>\n'
    + '<html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="Content-Security-Policy" '
    + 'content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; script-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    + `<title>Sentinel ${escapeHtml(findings.runId)}</title>`
    + '<style>html{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:1200px;margin:0 auto;padding:2rem}'
    + 'h1,h2{line-height:1.2}.meta{color:#667085}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(8rem,1fr));gap:.75rem}'
    + '.metric{border:1px solid #98a2b3;border-radius:.5rem;padding:1rem;display:flex;flex-direction:column}.metric strong{font-size:1.8rem}'
    + 'table{width:100%;border-collapse:collapse;margin-block:1rem}th,td{text-align:left;vertical-align:top;border:1px solid #98a2b3;padding:.5rem;overflow-wrap:anywhere}'
    + 'th{background:rgba(127,127,127,.15)}</style></head><body>'
    + '<main><h1>Sentinel sweep report</h1>'
    + `<p class="meta">Run ${escapeHtml(findings.runId)} · Coverage ${escapeHtml(findings.coverage.status)} · `
    + `${escapeHtml(findings.startedAt)} to ${escapeHtml(findings.finishedAt)}</p>`
    + `<section aria-labelledby="summary"><h2 id="summary">Summary</h2><div class="metrics">${htmlSummary(findings.summary)}</div></section>`
    + `<section aria-labelledby="coverage"><h2 id="coverage">Coverage diagnostics</h2>${htmlDiagnostics(findings.coverage)}</section>`
    + `<section aria-labelledby="findings"><h2 id="findings">Findings</h2>${htmlFindings(findings.findings)}</section>`
    + '</main>'
    + `<script id="sentinel-summary" type="application/json">${embeddedSummary}</script>`
    + '</body></html>\n';
}

/** Renders PR-ready Markdown; publishing remains an explicit host action. */
export function renderPrComment(findings) {
  validateFindings(findings);
  const summary = SUMMARY_ROWS.map(([label, key]) => `${label} ${findings.summary[key]}`)
    .join(' · ');
  const diagnostics = findings.coverage.diagnostics.length === 0
    ? 'None.'
    : findings.coverage.diagnostics.map((diagnostic) => (
      `- **${escapeMarkdown(diagnostic.code)}** — ${escapeMarkdown(diagnostic.message)}`
    )).join('\n');
  const rows = findings.findings.length === 0
    ? 'No findings.'
    : findings.findings.map((finding) => (
      `- **${escapeMarkdown(finding.severity)} / ${escapeMarkdown(finding.category)}** `
      + `${escapeMarkdown(finding.subject.type)}:${escapeMarkdown(finding.subject.id)} — `
      + escapeMarkdown(finding.message)
    )).join('\n');
  return [
    '## Sentinel sweep',
    '',
    `Run \`${escapeMarkdown(findings.runId)}\` · Coverage \`${escapeMarkdown(findings.coverage.status)}\``,
    '',
    `**Summary:** ${summary}`,
    '',
    '**Coverage diagnostics:**',
    '',
    diagnostics,
    '',
    '<details>',
    '<summary>Canonical findings</summary>',
    '',
    rows,
    '',
    '</details>',
    '',
  ].join('\n');
}

/** Returns 2 for a completed sweep with critical/error findings, otherwise 0. */
export function summaryExitCode(findings) {
  validateFindings(findings);
  return findings.summary.critical > 0 || findings.summary.error > 0 ? 2 : 0;
}
