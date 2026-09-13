import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import zlib from 'zlib';
import { getAiConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Dependency-free retail report analysis.
//
// Every workflow downloads a spreadsheet (CSV or XLSX) and calls
// summarizeReport(). We:
//   1. parse the file locally (XLSX is a ZIP of XML, read with Node's zlib),
//   2. compute per-column statistics and deltas against the cached previous
//      run (anomaly detection),
//   3. optionally ask an OpenAI-compatible endpoint for a short narrative,
//      falling back to the deterministic local summary on any error.
//
// summarizeReport() never throws: the workflow must always be able to upload.
// ---------------------------------------------------------------------------

// ----------------------------- ZIP / XLSX reader ---------------------------

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

function unzip(buf) {
  const eocd = findEocd(buf);
  if (eocd === -1) throw new Error('not a zip archive (no EOCD)');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    if (buf.readUInt32LE(localOff) === LOC_SIG) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      try {
        files.set(name, method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data));
      } catch {
        // Skip unreadable entries rather than aborting the whole analysis.
      }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function decodeXml(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si[\s>][\s\S]*?<\/si>|<si\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const texts = [...m[0].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]));
    out.push(texts.join(''));
  }
  return out;
}

function colToIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, strings) {
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const refMatch = attrs.match(/r="([A-Z]+)\d+"/);
      const idx = refMatch ? colToIndex(refMatch[1]) : cells.length;
      const type = (attrs.match(/t="([^"]+)"/) || [])[1];
      let value = '';
      if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1])).join('');
      } else {
        const v = body.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        if (v) value = type === 's' ? strings[Number(v[1])] ?? '' : decodeXml(v[1]);
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
}

function readWorkbook(buf) {
  const files = unzip(buf);
  const strings = sharedStrings(files.get('xl/sharedStrings.xml')?.toString('utf8'));
  const sheetName = [...files.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!sheetName) throw new Error('no worksheet found');
  return parseSheet(files.get(sheetName).toString('utf8'), strings);
}

// -------------------------------- CSV parser ------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------- table -> statistics -------------------------

function parseNumber(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  // Normalise both "1.234,56" (es-CL) and "1,234.56" (en-US).
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function analyseTable(rows) {
  const nonEmpty = rows.filter((r) => r.some((c) => c !== '' && c != null));
  if (nonEmpty.length < 2) throw new Error('spreadsheet has no data rows');

  const header = nonEmpty[0].map((h) => (h == null ? '' : String(h).trim()));
  const body = nonEmpty.slice(1);

  const columns = header.map((name, i) => {
    let numericCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const r of body) {
      const raw = r[i];
      if (raw === '' || raw == null) continue;
      const n = parseNumber(raw);
      if (n === null) continue;
      numericCount++;
      sum += n;
      if (n < min) min = n;
      if (n > max) max = n;
    }
    return {
      name: name || `column_${i + 1}`,
      numeric: numericCount > 0 && numericCount >= body.length * 0.5,
      count: numericCount,
      sum: numericCount ? sum : null,
      min: numericCount ? min : null,
      max: numericCount ? max : null,
      avg: numericCount ? sum / numericCount : null,
    };
  });

  return { header, body, columns, rowCount: body.length };
}

// ------------------------------ anomaly detection -------------------------

function historyPath() {
  const dir = path.join(__dirname, '.ai-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return path.join(dir, 'history.json');
}

function loadHistory() {
  try {
    return JSON.parse(readFileSync(historyPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveHistory(history) {
  try {
    writeFileSync(historyPath(), JSON.stringify(history, null, 2));
  } catch {
    // Cache is best-effort; never fail a run over it.
  }
}

function detectAnomalies(stats, previous, threshold) {
  const notes = [];
  if (!previous) return notes;
  for (const col of stats.columns) {
    if (!col.numeric || col.sum === null) continue;
    const prev = previous[col.name];
    if (typeof prev !== 'number') continue;
    if (prev === 0) {
      if (col.sum !== 0) notes.push(`${col.name}: appeared this period (was 0)`);
      continue;
    }
    const pct = ((col.sum - prev) / Math.abs(prev)) * 100;
    if (Math.abs(pct) >= threshold) {
      notes.push(
        `${col.name}: ${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs previous run ` +
        `(${prev.toLocaleString('en-US')} -> ${col.sum.toLocaleString('en-US')})`
      );
    }
  }
  return notes;
}

// -------------------------------- local summary ---------------------------

function formatNumber(n) {
  if (n === null || n === undefined) return 'n/a';
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function localSummary({ store, report, stats, anomalies }) {
  const lines = [];
  lines.push(`### ${store} - ${report}`);
  lines.push('');
  lines.push(`- Data rows: **${formatNumber(stats.rowCount)}**`);
  lines.push(`- Columns: ${stats.header.filter(Boolean).length}`);
  const numeric = stats.columns.filter((c) => c.numeric);
  if (numeric.length) {
    lines.push('');
    lines.push('| Column | Total | Min | Max | Avg |');
    lines.push('| --- | ---: | ---: | ---: | ---: |');
    for (const c of numeric) {
      lines.push(`| ${c.name} | ${formatNumber(c.sum)} | ${formatNumber(c.min)} | ${formatNumber(c.max)} | ${formatNumber(c.avg)} |`);
    }
  }
  lines.push('');
  if (anomalies.length) {
    lines.push('**Anomalies**');
    for (const a of anomalies) lines.push(`- ${a}`);
  } else {
    lines.push('_No anomalies above threshold._');
  }
  return lines.join('\n');
}

// -------------------------------- LLM summary -----------------------------

function buildPrompt({ store, report, stats, anomalies, maxRows }) {
  const sample = stats.body
    .slice(0, maxRows)
    .map((r) => stats.header.map((_, i) => r[i] ?? '').join(' | '));
  const numeric = stats.columns
    .filter((c) => c.numeric)
    .map((c) => `${c.name}: total=${formatNumber(c.sum)} min=${formatNumber(c.min)} max=${formatNumber(c.max)} avg=${formatNumber(c.avg)}`)
    .join('\n');

  return [
    `You are a retail operations analyst. Summarise the daily "${report}" report for ${store}.`,
    'Be concise: 3-6 bullet points plus a one-line takeaway. Highlight stock risks, unusual movements and anything that needs action.',
    '',
    `Rows: ${stats.rowCount}`,
    `Columns: ${stats.header.join(', ')}`,
    '',
    'Numeric column totals:',
    numeric || '(none)',
    '',
    anomalies.length ? 'Flagged anomalies:\n' + anomalies.join('\n') : 'Flagged anomalies: none',
    '',
    `First ${sample.length} rows (pipe-separated, same order as columns):`,
    sample.join('\n'),
  ].join('\n');
}

async function callLlm(ai, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ai.timeoutMs);
  try {
    const res = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: 'You produce terse, factual retail report summaries in Markdown. No preamble.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('LLM returned an empty response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------- entrypoint -----------------------------

function readTable(filePath) {
  const buf = readFileSync(filePath);
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip || /\.xlsx$/i.test(filePath)) return readWorkbook(buf);
  return parseCsv(buf.toString('utf8'));
}

/**
 * Analyse a downloaded retail report.
 *
 * @param {{ store: string, report: string, filePath: string }} opts
 * @returns {Promise<{ markdown: string, stats: object|null, anomalies: string[], ai: boolean }>}
 */
export async function summarizeReport({ store, report, filePath }) {
  const ai = getAiConfig();
  const result = { markdown: '', stats: null, anomalies: [], ai: false };

  try {
    const rows = readTable(filePath);
    const stats = analyseTable(rows);
    result.stats = stats;

    const history = loadHistory();
    const key = `${store}::${report}`;
    const previous = history[key]?.totals || null;
    const anomalies = detectAnomalies(stats, previous, ai.anomalyThreshold);
    result.anomalies = anomalies;

    const local = localSummary({ store, report, stats, anomalies });

    if (ai.enabled && ai.apiKey) {
      try {
        const narrative = await callLlm(ai, buildPrompt({ store, report, stats, anomalies, maxRows: ai.maxRows }));
        result.markdown = `${narrative}\n\n---\n\n${local}`;
        result.ai = true;
      } catch (e) {
        result.markdown = `${local}\n\n> AI narrative unavailable: ${e.message}`;
      }
    } else {
      result.markdown = local;
    }

    history[key] = {
      updatedAt: new Date().toISOString(),
      totals: Object.fromEntries(stats.columns.filter((c) => c.numeric).map((c) => [c.name, c.sum])),
    };
    saveHistory(history);
  } catch (e) {
    result.markdown = `### ${store} - ${report}\n\n_Analysis skipped: ${e.message}_`;
  }

  return result;
}