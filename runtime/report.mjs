import { validateCanonicalFindings } from './lib/findings-contract.mjs';

const JSON_STRINGIFY = JSON.stringify;
const OBJECT_HAS_OWN = Object.hasOwn;
const STRING = String;
const CONTROL_CHARACTERS = '\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007'
  + '\u0008\u0009\u000a\u000b\u000c\u000d\u000e\u000f'
  + '\u0010\u0011\u0012\u0013\u0014\u0015\u0016\u0017'
  + '\u0018\u0019\u001a\u001b\u001c\u001d\u001e\u001f';

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

function validateFindings(findings) {
  return validateCanonicalFindings(findings, {
    code: 'FINDINGS_DOCUMENT_INVALID',
    message: 'Report input is not a canonical Sentinel findings document',
  });
}

function join(values, separator) {
  let result = '';
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) result += separator;
    result += values[index];
  }
  return result;
}

function unsafeFormatCode(character) {
  let code = -1;
  if (character === '\u007f') code = 127;
  else {
    for (let index = 0; index < CONTROL_CHARACTERS.length; index += 1) {
      if (character === CONTROL_CHARACTERS[index]) {
        code = index;
        break;
      }
    }
  }
  if (code >= 0) return code;
  const unit = character.charCodeAt(0);
  return (unit >= 0x80 && unit <= 0x9f)
    || unit === 0x061c
    || (unit >= 0x200b && unit <= 0x200f)
    || (unit >= 0x2028 && unit <= 0x202e)
    || (unit >= 0x2060 && unit <= 0x206f)
    || unit === 0xfeff
    ? unit
    : -1;
}

function asciiAlphaNumeric(character) {
  return (character >= 'A' && character <= 'Z')
    || (character >= 'a' && character <= 'z')
    || (character >= '0' && character <= '9');
}

function escapeHtml(value) {
  const source = STRING(value);
  let escaped = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '&') escaped += '&amp;';
    else if (character === '<') escaped += '&lt;';
    else if (character === '>') escaped += '&gt;';
    else if (character === '"') escaped += '&quot;';
    else if (character === "'") escaped += '&#39;';
    else if (character === '\u2028') escaped += '&#8232;';
    else if (character === '\u2029') escaped += '&#8233;';
    else if (character === '\r') escaped += '&#13;';
    else if (character === '\n') escaped += '&#10;';
    else {
      const code = unsafeFormatCode(character);
      escaped += code >= 0 ? `&#${code};` : character;
    }
  }
  return escaped;
}

function escapeMarkdown(value) {
  const escaped = escapeHtml(value);
  let markdown = '';
  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index];
    const structural = character === '\\'
      || character === '|'
      || character === '`'
      || character === '['
      || character === ']'
      || character === '('
      || character === ')'
      || character === '*'
      || character === '!'
      || character === '#'
      || character === '~';
    const exposedUnderscore = character === '_'
      && (!asciiAlphaNumeric(escaped[index - 1]) || !asciiAlphaNumeric(escaped[index + 1]));
    if (structural || exposedUnderscore) markdown += '\\';
    markdown += character;
  }
  return markdown;
}

function evidenceText(evidence) {
  let fields = '';
  for (let index = 0; index < EVIDENCE_FIELDS.length; index += 1) {
    const name = EVIDENCE_FIELDS[index];
    if (OBJECT_HAS_OWN(evidence, name)) {
      if (fields.length > 0) fields += '; ';
      fields += `${name}=${STRING(evidence[name])}`;
    }
  }
  return fields.length === 0 ? 'none' : fields;
}

function markdownSummary(summary) {
  let output = '| Result | Count |\n| --- | ---: |';
  for (let index = 0; index < SUMMARY_ROWS.length; index += 1) {
    const row = SUMMARY_ROWS[index];
    output += `\n| ${row[0]} | ${summary[row[1]]} |`;
  }
  return output;
}

function markdownDiagnostics(coverage) {
  if (coverage.diagnostics.length === 0) return 'None.';
  let output = '| Code | Source | Pointer | Message |\n| --- | --- | --- | --- |';
  for (let index = 0; index < coverage.diagnostics.length; index += 1) {
    const diagnostic = coverage.diagnostics[index];
    output += `\n| ${escapeMarkdown(diagnostic.code)}`
      + ` | ${escapeMarkdown(diagnostic.sourcePath ?? 'unknown')}`
      + ` | ${escapeMarkdown(diagnostic.pointer ?? 'unknown')}`
      + ` | ${escapeMarkdown(diagnostic.message)} |`;
  }
  return output;
}

function markdownFindings(findings) {
  if (findings.length === 0) return 'No findings.';
  let output = '| Severity | Category | Subject | Role | Service | Message | Evidence |\n'
    + '| --- | --- | --- | --- | --- | --- | --- |';
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    output += `\n| ${escapeMarkdown(finding.severity)}`
      + ` | ${escapeMarkdown(finding.category)}`
      + ` | ${escapeMarkdown(`${finding.subject.type}:${finding.subject.id}`)}`
      + ` | ${escapeMarkdown(finding.role ?? 'unauthenticated')}`
      + ` | ${escapeMarkdown(finding.service ?? 'default')}`
      + ` | ${escapeMarkdown(finding.message)}`
      + ` | ${escapeMarkdown(evidenceText(finding.evidence))} |`;
  }
  return output;
}

/** Renders the canonical human-readable report without recomputing any counts. */
export function renderMarkdown(findings) {
  findings = validateFindings(findings);
  return join([
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
  ], '\n');
}

function htmlSummary(summary) {
  let output = '';
  for (let index = 0; index < SUMMARY_ROWS.length; index += 1) {
    const row = SUMMARY_ROWS[index];
    output += `<div class="metric metric-${row[1]}"><strong>${summary[row[1]]}</strong>`
      + `<span>${row[0]}</span></div>`;
  }
  return output;
}

function htmlDiagnostics(coverage) {
  if (coverage.diagnostics.length === 0) return '<p>None.</p>';
  let rows = '';
  for (let index = 0; index < coverage.diagnostics.length; index += 1) {
    const diagnostic = coverage.diagnostics[index];
    rows += `<tr><td>${escapeHtml(diagnostic.code)}</td>`
      + `<td>${escapeHtml(diagnostic.sourcePath ?? 'unknown')}</td>`
      + `<td>${escapeHtml(diagnostic.pointer ?? 'unknown')}</td>`
      + `<td>${escapeHtml(diagnostic.message)}</td></tr>`;
  }
  return '<table><thead><tr><th>Code</th><th>Source</th><th>Pointer</th><th>Message</th>'
    + `</tr></thead><tbody>${rows}</tbody></table>`;
}

function htmlFindings(findings) {
  if (findings.length === 0) return '<p>No findings.</p>';
  let rows = '';
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index];
    rows += `<tr><td>${escapeHtml(finding.severity)}</td>`
      + `<td>${escapeHtml(finding.category)}</td>`
      + `<td>${escapeHtml(`${finding.subject.type}:${finding.subject.id}`)}</td>`
      + `<td>${escapeHtml(finding.role ?? 'unauthenticated')}</td>`
      + `<td>${escapeHtml(finding.service ?? 'default')}</td>`
      + `<td>${escapeHtml(finding.message)}</td>`
      + `<td>${escapeHtml(evidenceText(finding.evidence))}</td></tr>`;
  }
  return '<table><thead><tr><th>Severity</th><th>Category</th><th>Subject</th><th>Role</th>'
    + `<th>Service</th><th>Message</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function safeEmbeddedJson(value) {
  const serialized = JSON_STRINGIFY(value);
  let embedded = '';
  for (let index = 0; index < serialized.length; index += 1) {
    const character = serialized[index];
    if (character === '&') embedded += '\\u0026';
    else if (character === '<') embedded += '\\u003c';
    else if (character === '>') embedded += '\\u003e';
    else if (character === '\u2028') embedded += '\\u2028';
    else if (character === '\u2029') embedded += '\\u2029';
    else embedded += character;
  }
  return embedded;
}

/** Renders a self-contained, non-executable static dashboard. */
export function renderDashboard(findings) {
  findings = validateFindings(findings);
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
  findings = validateFindings(findings);
  let summary = '';
  for (let index = 0; index < SUMMARY_ROWS.length; index += 1) {
    const row = SUMMARY_ROWS[index];
    if (summary.length > 0) summary += ' · ';
    summary += `${row[0]} ${findings.summary[row[1]]}`;
  }
  let diagnostics = 'None.';
  if (findings.coverage.diagnostics.length > 0) {
    diagnostics = '';
    for (let index = 0; index < findings.coverage.diagnostics.length; index += 1) {
      const diagnostic = findings.coverage.diagnostics[index];
      if (diagnostics.length > 0) diagnostics += '\n';
      diagnostics += `- **${escapeMarkdown(diagnostic.code)}**`
        + ` — ${escapeMarkdown(diagnostic.message)}`;
    }
  }
  let rows = 'No findings.';
  if (findings.findings.length > 0) {
    rows = '';
    for (let index = 0; index < findings.findings.length; index += 1) {
      const finding = findings.findings[index];
      if (rows.length > 0) rows += '\n';
      rows += `- **${escapeMarkdown(finding.severity)}`
        + ` / ${escapeMarkdown(finding.category)}** `
        + `${escapeMarkdown(finding.subject.type)}:${escapeMarkdown(finding.subject.id)} — `
        + escapeMarkdown(finding.message);
    }
  }
  return join([
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
  ], '\n');
}

/** Returns 2 for a completed sweep with critical/error findings, otherwise 0. */
export function summaryExitCode(findings) {
  findings = validateFindings(findings);
  return findings.summary.critical > 0 || findings.summary.error > 0 ? 2 : 0;
}
