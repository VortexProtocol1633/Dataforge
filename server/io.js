'use strict';
/**
 * File I/O: spreadsheet / document parsing & type detection, table export
 * (XLSX / CSV / DOCX), chart image persistence and row-share tokens.
 *
 * IMPORT PARSERS (all normalise to `{ headers, rows }`):
 *  - .xlsx / .xls / .csv   SheetJS
 *  - .docx                 direct WordprocessingML table extraction (fflate)
 *  - .pdf                  pdfjs text layer; scanned pages fall back to OCR
 *                          (tesseract.js + @napi-rs/canvas). OCR needs the
 *                          'eng' traineddata — by default it downloads it on
 *                          first use; set TESSDATA_DIR to a local folder that
 *                          already contains eng.traineddata for offline use.
 *
 * Extension guide:
 *  - Add parsers here that return `{ sheetName, headers, rows }` and register
 *    their extension in createImportJob(). The import preview/mapping UI
 *    already works with any source that yields that shape.
 *  - CLOUD STORAGE: replace the Saves/ + data/files writes with S3 helpers
 *    preserving the same Saves/Tables, Saves/Charts folder layout.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const XLSX = require('xlsx');
const { unzipSync, strFromU8 } = require('fflate');
const { Document, Packer, Table, TableRow, TableCell, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, WidthType } = require('docx');
const Fx = require('../public/js/formula.js');
const { uid, nowISO, sanitizeName } = require('./util');
const { coerceValue } = require('./store');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TMP_DIR = path.join(DATA_DIR, 'tmp');
const SAVES_DIR = path.join(ROOT, 'Saves');
const TABLES_SAVE_DIR = path.join(SAVES_DIR, 'Tables');
const CHARTS_SAVE_DIR = path.join(SAVES_DIR, 'Charts');
const SHARES_FILE = path.join(DATA_DIR, 'shares.json');

for (const d of [TMP_DIR, TABLES_SAVE_DIR, CHARTS_SAVE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const MAX_IMPORT_ROWS = 10000;
const PREVIEW_ROWS = 50;

function loadShares() {
  if (!fs.existsSync(SHARES_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(SHARES_FILE, 'utf8')); } catch (e) { return []; }
}
function saveShares(list) {
  fs.writeFileSync(SHARES_FILE, JSON.stringify(list, null, 2));
}

/* ------------------------------------------------------------------ */
/* Parsing + type detection                                           */
/* ------------------------------------------------------------------ */

/** Parse a spreadsheet buffer into a normalized grid (first non-empty row = header). */
function parseSpreadsheet({ filename, data }) {
  let wb;
  try {
    wb = XLSX.read(data, { type: 'base64', cellDates: false });
  } catch (e) {
    throw new Error(`Could not parse "${filename}": ${e.message}`);
  }
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error('The file contains no sheets');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  return { sheetName, ...aoaToGrid(aoa) };
}

/** Normalise an array-of-arrays into { headers, rows } with unique header names. */
function aoaToGrid(aoa) {
  if (!aoa || !aoa.length) throw new Error('The file appears to be empty');
  const headerIdx = aoa.findIndex((r) => r.some((c) => c !== null && c !== '' && String(c).trim() !== ''));
  if (headerIdx === -1) throw new Error('The file appears to be empty');
  const headerRow = aoa[headerIdx];
  const width = Math.max(headerRow.length, ...aoa.slice(headerIdx + 1).map((r) => r.length), 1);
  const padRow = Array.from({ length: width }, (_, i) => (headerRow[i] == null ? '' : headerRow[i]));
  const headers = padRow.map((h, i) => uniqueHeader(String(h).trim() || `Column ${i + 1}`, i, padRow));
  const rows = aoa.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== null && c !== '' && String(c).trim() !== ''))
    .map((r) => headers.map((_, i) => normalizeCell(r[i])));
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`This file has ${rows.length} data rows — the importer accepts up to ${MAX_IMPORT_ROWS}. Please split the file.`);
  }
  return { headers, rows };
}

function uniqueHeader(base, idx, headerRow) {
  let name = base;
  let n = 2;
  while (headerRow.some((h, i) => i !== idx && String(h == null ? '' : h).trim() === name)) {
    name = `${base} (${n++})`;
  }
  return name;
}

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    // xlsx may return rich text or booleans-as-objects
    if (v.t !== undefined && v.v !== undefined) return v.v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  if (typeof v === 'number' && !isFinite(v)) return '';
  return v;
}

/** Heuristic column-type detection over non-empty sample values. */
function detectType(headerName, values) {
  const n = values.length;
  if (!n) return { type: 'text', subtype: 'single' };
  const s = values.map((v) => String(v).trim());
  const count = (pred) => s.filter(pred).length;
  const numeric = count((x) => x !== '' && isFinite(Number(String(x).replace(/[$€£₦¥₹,\s]/g, ''))));

  const truthy = new Set(['true', 'yes', 'y', '1', 'on', '✓', 'x']);
  const falsy = new Set(['false', 'no', 'n', '0', 'off', '']);
  const boolLike = count((x) => truthy.has(x.toLowerCase()) || falsy.has(x.toLowerCase()));
  const distinct = new Set(s.map((x) => x.toLowerCase()));
  const fracRe = /^-?(\d+\s+)?\d+\/\d+$/;
  const fractions = count((x) => fracRe.test(x));
  const timeRe = /^(\d{1,2}):(\d{2})(:(\d{2}))?$/;
  const times = count((x) => timeRe.test(x));
  const dateRe = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
  const shortDateRe = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
  const dates = count((x) => dateRe.test(x) || shortDateRe.test(x));
  const dtRe = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/;
  const datetimes = count((x) => dtRe.test(x));
  const currency = /[$€£₦¥₹]/;

  const ratio = (c) => (n ? c / n : 0);
  // SheetJS parses date-like CSV cells into Excel serial numbers (day count
  // since 1899-12-30); serials in the plausible range ~20000..~70000 map to
  // years 1954..2091, so columns whose values all sit in that band are dates.
  const nums = values.map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''))));
  const serialish = nums.length && nums.every((v) => !isNaN(v) && v >= 20000 && v <= 70000);
  const dateyHeader = /date|added|since|created|when|dob|birth|due|start|end|day|updated/i.test(headerName);
  if (serialish && (dateyHeader || nums.length >= n * 0.8)) return { type: 'date', subtype: null };
  if (datetimes >= n * 0.8 && datetimes > 0) return { type: 'datetime', subtype: null };
  if (dates >= n * 0.8 && dates > 0) return { type: 'date', subtype: null };
  if (times >= n * 0.8 && times > 0) return { type: 'time', subtype: null };
  if (fractions >= n * 0.8 && fractions > 0) return { type: 'fraction', subtype: null };
  if (numeric >= n * 0.85 && numeric > 0) {
    const allInt = count((x) => { const v = Number(String(x).replace(/,/g, '')); return Number.isInteger(v); });
    const hasCurrency = currency.test(headerName) || s.some((x) => currency.test(x));
    if (hasCurrency) return { type: 'currency', subtype: null };
    return { type: 'number', subtype: allInt >= n * 0.85 ? 'integer' : 'decimal' };
  }
  if (boolLike >= n * 0.8 && distinct.size <= 4 && boolLike > 0) return { type: 'boolean', subtype: null };
  // fall back to dropdown when few distinct values, else text
  if (distinct.size <= 15 && distinct.size >= 2 && n >= 5) return { type: 'dropdown', subtype: null };
  return { type: 'text', subtype: 'single' };
}

/* ------------------------------------------------------------------ */
/* DOCX parsing — WordprocessingML tables (no HTML round-trip needed) */
/* ------------------------------------------------------------------ */

function decodeXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Text of one <w:tc> cell: paragraphs joined by newlines, runs concatenated. */
function docxCellText(tcXml) {
  const paragraphs = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(tcXml)) !== null) {
    const p = m[0];
    let text = '';
    // runs + line breaks within the paragraph
    const inner = p.replace(/<w:tab[^>]*\/>/g, '\t');
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:br[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) text += t[0].startsWith('<w:br') ? '\n' : t[1];
    paragraphs.push(decodeXml(text).replace(/\u0000/g, ''));
  }
  return paragraphs.filter((p, i) => !(p === '' && i === 0)).join('\n').trimEnd();
}

function docxTablesToAoa(xml) {
  const tables = [];
  const tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tbl;
  while ((tbl = tblRe.exec(xml)) !== null) {
    const aoa = [];
    const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let tr;
    while ((tr = trRe.exec(tbl[0])) !== null) {
      const cells = [];
      const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let tc;
      while ((tc = tcRe.exec(tr[0])) !== null) cells.push(docxCellText(tc[0]));
      aoa.push(cells);
    }
    if (aoa.length) tables.push(aoa);
  }
  return tables;
}

/** Document paragraphs (used when the .docx has no tables) -> single-column rows. */
function docxParagraphs(xml) {
  const paras = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = docxCellText(m[0]);
    if (text.trim()) paras.push(text.trim());
  }
  return paras;
}

/** Parse a .docx into { headers, rows }. Prefers the largest real table. */
function parseDocx({ filename, data }) {
  const buf = Buffer.from(data, 'base64');
  let zip;
  try { zip = unzipSync(new Uint8Array(buf)); }
  catch (e) { throw new Error(`Could not unzip "${filename}": ${e.message}`); }
  const xmlBytes = zip['word/document.xml'];
  if (!xmlBytes) throw new Error('“document.xml” was not found in this .docx — is it a valid Word document?');
  const xml = strFromU8(xmlBytes);
  const tables = docxTablesToAoa(xml).map((aoa) => aoaToGrid(aoa));
  if (tables.length) {
    // use the table with the most data rows (usually the main content table)
    tables.sort((a, b) => b.rows.length - a.rows.length || b.headers.length - a.headers.length);
    return { sheetName: 'Document', ...tables[0] };
  }
  // plain document: one row per paragraph
  const paras = docxParagraphs(xml);
  if (!paras.length) throw new Error(`No tables or text found in "${filename}".`);
  return { sheetName: 'Document', headers: ['Text'], rows: paras.map((p) => [p]).slice(0, MAX_IMPORT_ROWS) };
}

/* ------------------------------------------------------------------ */
/* PDF parsing — pdfjs text layer + tesseract OCR fallback            */
/* ------------------------------------------------------------------ */

/**
 * Detect page-wide column centers from token midpoints. Returns a list of x
 * centers when several lines share aligned columns (e.g. a table), else [].
 */
function detectColumnCenters(lines) {
  const withWords = lines.filter((l) => l.items && l.items.length);
  if (withWords.length < 2) return [];
  const midpoints = [];
  for (const l of withWords) for (const it of l.items) midpoints.push(it.x + (it.w || 0) / 2);
  midpoints.sort((a, b) => a - b);
  const clusters = [];
  for (const m of midpoints) {
    const last = clusters[clusters.length - 1];
    if (last && m - last.sum / last.n <= 8) { last.sum += m; last.n++; }
    else clusters.push({ sum: m, n: 1 });
  }
  const candidates = clusters.filter((c) => c.n >= Math.max(2, withWords.length * 0.25));
  if (!candidates.length) return [];
  const centers = candidates.map((c) => c.sum / c.n);
  // merge centers closer than 14px
  const merged = [centers[0]];
  for (const c of centers.slice(1)) if (c - merged[merged.length - 1] > 14) merged.push(c);
  return merged;
}

/** Assign each line's tokens to the nearest detected column center. */
function lineToCells(line, centers) {
  if (!centers.length) return [line.items.map((it) => it.text).join(' ')];
  const cells = centers.map(() => []);
  for (const it of line.items) {
    const mid = it.x + (it.w || 0) / 2;
    let best = 0;
    let bestD = Infinity;
    centers.forEach((c, i) => {
      const d = Math.abs(mid - c);
      if (d < bestD) { bestD = d; best = i; }
    });
    cells[best].push(it.text);
  }
  return cells.map((c) => c.join(' ').trim());
}

/**
 * Turn per-line word geometry into a grid. Aligned multi-column layouts
 * (tables) become columns; plain text stays one column where every line is a
 * row (no first-line-as-header loss).
 */
function linesToRows(lines) {
  const withWords = lines.filter((l) => l.items && l.items.length && !l.pageBreak);
  if (!withWords.length) throw new Error('No readable text was found in this document.');
  const centers = detectColumnCenters(withWords);
  const celled = withWords.map((l) => lineToCells(l, centers));
  const filled = celled.filter((c) => c.filter((x) => x).length >= 2);
  if (centers.length > 1 && filled.length >= Math.max(2, celled.length * 0.35)) {
    const width = centers.length;
    const aoa = celled
      .map((row) => Array.from({ length: width }, (_, i) => (row[i] === undefined ? '' : row[i])))
      .filter((r) => r.some((x) => x !== ''));
    return aoaToGrid(aoa);
  }
  const rows = celled.map((c) => c.join(' ').trim()).filter(Boolean)
    .slice(0, MAX_IMPORT_ROWS).map((t) => [t]);
  return { headers: ['Text'], rows };
}

/** Extract lines (with per-word geometry) from one pdfjs page. */
async function pageTextLines(page) {
  const content = await page.getTextContent();
  const items = content.items.filter((it) => it.str && it.str.trim());
  const lines = [];
  let chars = 0;
  for (const it of items) {
    const y = it.transform[5];
    const x = it.transform[4];
    const w = typeof it.width === 'number' ? it.width : 0;
    const line = lines.find((l) => Math.abs(l.y - y) <= 2.5);
    const item = { x, w, text: it.str };
    chars += it.str.length;
    if (line) { line.items.push(item); line.chars += it.str.length; }
    else lines.push({ y, items: [item], chars: it.str.length });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  lines.sort((a, b) => b.y - a.y); // pdf y grows upward → top lines first
  return { lines, chars };
}

/** pdfjs Node canvas factory backed by @napi-rs/canvas (no native build). */
function nodeCanvasFactory(canvasLib) {
  return {
    create(width, height) {
      const canvas = canvasLib.createCanvas(Math.ceil(width), Math.ceil(height));
      return { canvas, context: canvas.getContext('2d') };
    },
    reset(c, w, h) { c.canvas.width = Math.ceil(w); c.canvas.height = Math.ceil(h); },
    destroy(c) { c.canvas = null; c.context = null; },
  };
}

async function renderPdfPageImage(page, scale = 2, canvasLib) {
  const viewport = page.getViewport({ scale });
  const { canvas, context } = nodeCanvasFactory(canvasLib).create(viewport.width, viewport.height);
  const ctx = context;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

/** OCR a page image into lines with word geometry (tesseract.js). */
async function ocrPageImage(png, filename) {
  const { createWorker } = await import('tesseract.js');
  const options = { logger: () => {} };
  if (process.env.TESSDATA_DIR) options.langPath = process.env.TESSDATA_DIR;
  const worker = await createWorker('eng', 1, options);
  try {
    // tesseract.js v7 only computes requested outputs (default: text alone) —
    // blocks carry paragraphs → lines → words with per-word bboxes.
    const { data } = await worker.recognize(png, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of data.blocks || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          const items = (l.words || [])
            .filter((w) => w && w.text && w.bbox)
            .map((w) => ({ x: w.bbox.x0, w: w.bbox.x1 - w.bbox.x0, text: w.text }))
            .sort((a, b) => a.x - b.x);
          if (items.length) lines.push({ y: (l.bbox && l.bbox.y0) || 0, items });
        }
      }
    }
    // image y grows downward → smaller y0 is higher on the page (top first)
    return lines.sort((a, b) => a.y - b.y);
  } finally {
    await worker.terminate();
  }
}

/** Parse a PDF: text layer first, OCR fallback for scanned pages. */
async function parsePdf({ filename, data }) {
  const buf = Buffer.from(data, 'base64');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const canvasLib = await import('@napi-rs/canvas');
  let doc;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      verbosity: 0,
      canvasFactory: nodeCanvasFactory(canvasLib),
    }).promise;
  } catch (e) {
    throw new Error(`Could not open "${filename}" as a PDF: ${e.message}`);
  }
  try {
    if (doc.numPages > 200) throw new Error('This PDF has more than 200 pages — please split it before importing.');
    let totalChars = 0;
    const allLines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const { lines, chars } = await pageTextLines(page);
      totalChars += chars;
      if (allLines.length && lines.length) allLines.push({ items: [{ x: -1, w: 0, text: '' }], pageBreak: true });
      for (const l of lines) allLines.push(l);
      page.cleanup();
    }
    if (totalChars >= 20) {
      // digital PDF — the text layer already has real content
      const grid = linesToRows(allLines.filter((l) => !l.pageBreak));
      return { sheetName: doc.numPages === 1 ? 'Page 1' : `PDF (${doc.numPages} pages)`, ...grid };
    }
    // near-empty text layer → scanned document: OCR each rendered page
    const ocrLines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const png = await renderPdfPageImage(page, 2, canvasLib);
      const lines = await ocrPageImage(png, filename);
      ocrLines.push(...lines.map((l) => ({ items: l.items })));
      page.cleanup();
    }
    const grid = linesToRows(ocrLines);
    return { sheetName: `Scanned (OCR · ${doc.numPages} page${doc.numPages > 1 ? 's' : ''})`, ...grid };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

/* ---------------- import job temp storage ---------------- */

/** Column suggestions + stats over a normalized grid (shared by all parsers). */
function buildColumnInfo(headers, rows) {
  return headers.map((name, i) => {
    const values = rows.map((r) => r[i]).filter((v) => v !== null && v !== '');
    const det = detectType(name, values);
    return {
      index: i,
      name,
      suggestedType: det.type,
      suggestedSubtype: det.subtype || null,
      stats: { nonEmpty: values.length, distinct: new Set(values.map((v) => String(v))).size, total: rows.length },
    };
  });
}

async function createImportJob({ filename, data }) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  let parsed;
  if (['.xlsx', '.xls', '.csv'].includes(ext)) parsed = parseSpreadsheet({ filename, data });
  else if (ext === '.docx') parsed = parseDocx({ filename, data });
  else if (ext === '.pdf') parsed = await parsePdf({ filename, data });
  else {
    throw new Error(`Unsupported file type “${ext}”. Supported: .xlsx .xls .csv .docx .pdf`);
  }
  const jobId = 'job_' + uid(10);
  const file = path.join(TMP_DIR, `${jobId}.json`);
  const columns = buildColumnInfo(parsed.headers, parsed.rows);
  const job = {
    jobId, fileName: filename, sheetName: parsed.sheetName || 'Sheet 1',
    totalRows: parsed.rows.length, headers: parsed.headers, columns, rows: parsed.rows,
  };
  // full dataset is persisted server-side (under `rows`); only the preview goes to the client
  await fsp.writeFile(file, JSON.stringify(job));
  return {
    jobId, fileName: filename, sheetName: job.sheetName, totalRows: job.totalRows,
    columns, headers: job.headers, preview: parsed.rows.slice(0, PREVIEW_ROWS),
  };
}

async function loadImportJob(jobId) {
  const file = path.join(TMP_DIR, `${jobId}.json`);
  if (!fs.existsSync(file)) throw new Error('Import session expired — please upload the file again');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

function cleanupStaleJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const f of fs.existsSync(TMP_DIR) ? fs.readdirSync(TMP_DIR) : []) {
    try {
      const st = fs.statSync(path.join(TMP_DIR, f));
      if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(TMP_DIR, f));
    } catch (e) { /* ignore */ }
  }
}

/** Convert an imported raw cell to the canonical stored value for a column type. */
function convertImportCell(type, subtype, raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  if (type === 'number' || type === 'currency') {
    if (typeof raw === 'number') return subtype === 'integer' ? Math.round(raw) : raw;
    const s = String(raw).replace(/[$€£₦¥₹,\s]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? (subtype === 'integer' ? Math.round(n) : n) : null;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    return ['true', '1', 'yes', 'y', 'on', '✓', 'x'].includes(String(raw).trim().toLowerCase());
  }
  if (type === 'date') {
    if (raw instanceof Date) return raw.toISOString().slice(0, 10);
    if (typeof raw === 'number') return excelSerialToDate(raw);
    const d = parseDateString(String(raw));
    return d || null;
  }
  if (type === 'datetime') {
    if (raw instanceof Date) return raw.toISOString().slice(0, 16).replace('T', ' ');
    if (typeof raw === 'number') return excelSerialToDate(raw).slice(0, 16);
    const s = String(raw).replace('T', ' ');
    return s.length >= 16 ? s.slice(0, 16) : null;
  }
  if (type === 'time') {
    if (typeof raw === 'number') {
      const mins = Math.round((raw % 1) * 1440);
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    }
    const s = String(raw);
    const m = s.match(/(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  if (type === 'fraction') {
    if (raw instanceof Date) return null;
    const c = coerceValue('fraction', null, raw);
    return c;
  }
  if (type === 'dropdown') return String(raw);
  return String(raw);
}

function excelSerialToDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDateString(s) {
  const p = (x) => String(x).padStart(2, '0');
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return `${m[1]}-${p(+m[2])}-${p(+m[3])}`;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    const a = +m[1]; const b = +m[2]; const y = +m[3];
    const year = y < 50 ? 2000 + y : y < 100 ? 1900 + y : y;
    // "3/4/24" -> assume US month/day; if the first part exceeds 12 it must be day/month
    if (a > 12) return `${year}-${p(b)}-${p(a)}`;
    return `${year}-${p(a)}-${p(b)}`;
  }
  if ((m = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})/))) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const mo = months[String(m[1]).slice(0, 3).toLowerCase()];
    return mo ? `${m[3]}-${p(mo)}-${p(+m[2])}` : null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Export                                                             */
/* ------------------------------------------------------------------ */

/** Build rows (array-of-arrays) with computed columns evaluated. */
function buildExportAoa(table) {
  const nameById = new Map((table.columns || []).map((c) => [c.id, c.name]));
  const numericCols = new Set();
  for (const c of table.columns) {
    if (c.type === 'number' || c.type === 'currency') numericCols.add(c.id);
  }
  const formulaCols = table.columns.filter((c) => c.type === 'formula');
  const compiled = formulaCols.map((c) => ({ col: c, cpl: Fx.compile(c.options.formula || '') }));
  const header = table.columns.map((c) => c.name);
  const aoa = [header];
  for (const row of table.rows || []) {
    const values = [];
    for (const c of table.columns) {
      const raw = row.values[c.id];
      if (c.type === 'formula') {
        const ctx = {
          getValue: (name) => {
            const col = table.columns.find((x) => x.name === name || nameById.get(x.id) === name);
            if (!col) return undefined;
            const v = row.values[col.id];
            return valueForFormula(col, v);
          },
        };
        const r = compiled.find((x) => x.col.id === c.id).cpl.run(ctx);
        values.push(r && r.error ? `#${r.error.replace(/^#/, '')}` : cleanFormulaResult(r));
      } else if (raw === null || raw === undefined || raw === '') {
        values.push('');
      } else if (c.type === 'fraction') {
        values.push(raw.d === 1 ? `${raw.n}` : `${raw.n}/${raw.d}`);
      } else if (c.type === 'dropdown' && Array.isArray(raw)) {
        values.push(raw.join(', '));
      } else if (c.type === 'boolean') {
        values.push(raw ? 'TRUE' : 'FALSE');
      } else if (c.type === 'image' || c.type === 'file') {
        values.push(raw.name || raw.url || '');
      } else {
        values.push(raw);
      }
    }
    aoa.push(values);
  }
  return aoa;
}

function valueForFormula(col, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (col.type === 'number' || col.type === 'currency') return raw;
  if (col.type === 'fraction') return raw.d ? raw.n / raw.d : raw.n;
  if (col.type === 'boolean') return !!raw;
  return raw;
}

function cleanFormulaResult(v) {
  if (v === null || v === undefined) return '';
  if (v && v.error) return `#${String(v.error).replace(/^#/, '')}`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  return v;
}

async function exportTable(table, format) {
  const aoa = buildExportAoa(table);
  const safe = sanitizeName(table.name, 'table');
  if (format === 'docx') {
    const buf = await buildDocx(table, aoa, collectExportImages(table));
    const file = path.join(TABLES_SAVE_DIR, `${safe}.docx`);
    await fsp.writeFile(file, buf);
    return { file, filename: `${safe}.docx`, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  }
  const bookType = format === 'csv' ? 'csv' : 'xlsx';
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const buf = XLSX.write(wb, { type: 'buffer', bookType });
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  const file = path.join(TABLES_SAVE_DIR, `${safe}.${ext}`);
  await fsp.writeFile(file, buf);
  const mime = format === 'csv'
    ? 'text/csv'
    : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return { file, filename: `${safe}.${ext}`, mime };
}

/**
 * Read pixel dimensions + format from an image buffer (PNG / JPEG / GIF) so
 * embedded export images can be sized inside the Word document.
 */
function imageDims(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (!u8 || u8.length < 24) return null;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return {
      type: 'png', ext: 'png',
      width: ((u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]) >>> 0,
      height: ((u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]) >>> 0,
    };
  }
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { type: 'png', ext: 'gif', width: u8[6] | (u8[7] << 8), height: u8[8] | (u8[9] << 8) };
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i++; continue; }
      const marker = u8[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', ext: 'jpg', width: (u8[i + 7] << 8) | u8[i + 8], height: (u8[i + 5] << 8) | u8[i + 6] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Collect the uploaded images of a table (keyed "rowIdx:colIdx") so the DOCX
 * export can embed the real pictures instead of just their file names. The
 * cells keep their text fallback (the file name) in every other format.
 */
function collectExportImages(table) {
  const images = new Map();
  let ri = 0;
  for (const row of table.rows || []) {
    (table.columns || []).forEach((c, ci) => {
      if (c.type !== 'image') return;
      const raw = row.values[c.id];
      if (!raw || typeof raw !== 'object' || !raw.url) return;
      const mime = String(raw.mime || '');
      const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif)$/i.test(raw.name || raw.url);
      if (!isImage) return;
      let buf = null;
      if (typeof raw.url === 'string' && raw.url.startsWith('data:')) {
        buf = Buffer.from(String(raw.url).split(',')[1] || '', 'base64');
      } else if (typeof raw.url === 'string' && raw.url.startsWith('/uploads/')) {
        try { buf = fs.readFileSync(path.join(DATA_DIR, raw.url)); } catch { /* file missing — keep the name */ }
      }
      if (!buf || !buf.length) return;
      const dims = imageDims(buf);
      if (!dims) return;
      const scale = Math.min(1, 220 / (dims.width || 1));
      images.set(`${ri}:${ci}`, {
        data: buf, type: dims.type,
        transform: {
          width: Math.max(1, Math.round((dims.width || 1) * scale)),
          height: Math.max(1, Math.round((dims.height || 1) * scale)),
        },
      });
    });
    ri++;
  }
  return images;
}

async function buildDocx(table, aoa, images) {
  const cols = table.columns.length;
  const children = [
    new Paragraph({ text: table.name, heading: HeadingLevel.HEADING_1 }),
    ...(table.description ? [new Paragraph({ text: table.description, color: '666666' })] : []),
    new Paragraph({ text: `Exported ${new Date().toLocaleString()} — ${table.rows ? table.rows.length : 0} rows`, size: 18, color: '999999' }),
    new Paragraph({ text: '', spacing: { after: 200 } }),
  ];
  const widths = cols ? new Array(cols).fill(Math.floor(100 / cols)) : [];
  const rows = aoa.map((cells, ri) => new TableRow({
    children: cells.map((cell, ci) => {
      const img = images && images.get(`${ri}:${ci}`);
      return new TableCell({
        width: widths.length ? { size: widths[0], type: WidthType.PERCENTAGE } : undefined,
        shading: ri === 0 ? { fill: 'EDEAFB' } : undefined,
        children: img
          ? [new Paragraph({ children: [new ImageRun({ type: img.type, data: img.data, transformation: img.transform })] })]
          : [new Paragraph({
            children: [new TextRun({ text: String(cell == null ? '' : cell), bold: ri === 0 })],
          })],
      });
    }),
  }));
  children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ */
/* Chart image persistence                                            */
/* ------------------------------------------------------------------ */

async function saveChartImage({ name, format, data }) {
  const ext = format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png';
  const buf = Buffer.from(data, 'base64');
  if (!buf.length) throw new Error('No image data');
  const safe = sanitizeName(name, 'chart');
  const file = path.join(CHARTS_SAVE_DIR, `${safe}.${ext}`);
  await fsp.writeFile(file, buf);
  return { file, filename: `${safe}.${ext}`, savedAt: nowISO() };
}

/* ------------------------------------------------------------------ */
/* Row share tokens                                                   */
/* ------------------------------------------------------------------ */

async function createShare(owner, table, row) {
  const list = loadShares();
  const token = uid(16);
  list.push({ token, owner, tableId: table.id, rowId: row.id, createdAt: nowISO() });
  saveShares(list);
  return { token, url: `/share/${token}` };
}

function readShare(token) {
  const list = loadShares();
  const rec = list.find((s) => s.token === token);
  if (!rec) return null;
  return rec;
}

module.exports = {
  createImportJob, loadImportJob, cleanupStaleJobs, parseSpreadsheet,
  exportTable, buildExportAoa, saveChartImage, createShare, readShare,
  convertImportCell, detectType, MAX_IMPORT_ROWS,
};
