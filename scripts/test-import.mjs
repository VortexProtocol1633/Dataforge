/*
 * Import-pipeline verification: builds real .docx / .pdf samples on the fly,
 * uploads them through /api/import/parse + /api/import/create and asserts the
 * extracted tables. Run with the server up:  npm run test:import
 * Optional:  RUN_OCR=1 npm run test:import   also exercises the scanned-PDF
 * OCR fallback (needs network on first run to fetch the eng traineddata).
 */
import { Document, Packer, Table, TableRow, TableCell, Paragraph, TextRun, HeadingLevel, WidthType } from 'docx';

const BASE = 'http://localhost:3210';
let TOK = null;
const r = async (m, p, b) => {
  const res = await fetch(BASE + p, { method: m, headers: { 'Content-Type': 'application/json', ...(TOK ? { Authorization: `Bearer ${TOK}` } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${m} ${p} ${res.status} ${JSON.stringify(j)}`);
  return j;
};
TOK = (await r('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).token;

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
};

const created = [];

/* ================= 1. .docx with a real table ================= */
const docxTable = new Document({ sections: [{ children: [
  new Paragraph({ text: 'Team roster', heading: HeadingLevel.HEADING_1 }),
  new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ children: ['Name', 'Role', 'Joined'].map((t) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })] })) }),
      ...['Ada Lovelace|Analyst|2023-04-01', 'Alan Turing|Engineer|2022-11-15', 'Grace Hopper|Lead|2021-06-30']
        .map((line) => line.split('|'))
        .map((cells) => new TableRow({ children: cells.map((t) => new TableCell({ children: [new Paragraph(t)] })) })),
    ],
  }),
] }] });
const docxBuf = await Packer.toBuffer(docxTable);
const docxB64 = docxBuf.toString('base64');

const j1 = await r('POST', '/api/import/parse', { filename: 'roster.docx', data: docxB64 });
check('docx parse: table detected', j1.totalRows === 3, { headers: j1.headers, totalRows: j1.totalRows });
check('docx parse: headers extracted', JSON.stringify(j1.headers) === JSON.stringify(['Name', 'Role', 'Joined']), j1.headers);
check('docx parse: Joined suggested as date', j1.columns.find((c) => c.name === 'Joined').suggestedType === 'date', j1.columns);
const c1 = await r('POST', '/api/import/create', {
  jobId: j1.jobId, name: 'Imported roster',
  columns: j1.columns.map((c) => ({ index: c.index, name: c.name, type: c.suggestedType, subtype: c.suggestedSubtype })),
});
created.push(c1.table.id);
check('docx create: 3 rows stored', c1.table.rows.length === 3);
const roleCol = c1.table.columns.find((c) => c.name === 'Role');
const roles = c1.table.rows.map((row) => row.values[roleCol.id]);
check('docx create: row text intact', JSON.stringify(roles) === JSON.stringify(['Analyst', 'Engineer', 'Lead']), roles);

/* ================= 2. .docx with no tables -> paragraphs ================= */
const docxText = new Document({ sections: [{ children: [
  new Paragraph('First paragraph of notes.'),
  new Paragraph('Second paragraph with some details.'),
  new Paragraph('Third one.'),
] }] });
const txtB64 = (await Packer.toBuffer(docxText)).toString('base64');
const j2 = await r('POST', '/api/import/parse', { filename: 'notes.docx', data: txtB64 });
check('docx no-table: single Text column', j2.headers.length === 1 && j2.headers[0] === 'Text', j2.headers);
check('docx no-table: paragraphs become rows', j2.totalRows === 3, j2.totalRows);
const c2 = await r('POST', '/api/import/create', { jobId: j2.jobId, name: 'Imported notes', columns: j2.columns.map((x) => ({ index: x.index, name: x.name, type: 'text' })) });
created.push(c2.table.id);

/* ================= 3. text PDF with a simple table ================= */
/** Minimal single-page PDF writer (Helvetica, one text run per Tm). */
function buildPdf(lines) {
  // lines: { x, y, text } in PDF points (origin bottom-left)
  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>');
  let stream = 'BT /F1 11 Tf 0 0 0 rg\n';
  for (const l of lines) {
    const safe = l.text.replace(/[()\\]/g, (m) => '\\' + m);
    stream += `1 0 0 1 ${l.x} ${l.y} Tm (${safe}) Tj\n`;
  }
  stream += 'ET';
  objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const parts = ['%PDF-1.4\n'];
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(parts.join(''), 'latin1'));
    parts.push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }
  const xrefStart = Buffer.byteLength(parts.join(''), 'latin1');
  parts.push(`xref\n0 ${objects.length + 1}\n`);
  parts.push('0000000000 65535 f \n');
  for (const o of offsets) parts.push(String(o).padStart(10, '0') + ' 00000 n \n'); // 20-byte entries
  parts.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  return Buffer.from(parts.join(''), 'latin1');
}
const pdfLines = [
  { x: 60, y: 700, text: 'Product' }, { x: 220, y: 700, text: 'Qty' }, { x: 330, y: 700, text: 'Price' },
  { x: 60, y: 660, text: 'Widget' }, { x: 220, y: 660, text: '12' }, { x: 330, y: 660, text: '4.5' },
  { x: 60, y: 630, text: 'Gadget' }, { x: 220, y: 630, text: '7' }, { x: 330, y: 630, text: '19.99' },
  { x: 60, y: 600, text: 'Gizmo' }, { x: 220, y: 600, text: '3' }, { x: 330, y: 600, text: '50' },
];
const pdfB64 = buildPdf(pdfLines).toString('base64');
const j3 = await r('POST', '/api/import/parse', { filename: 'catalog.pdf', data: pdfB64 });
check('pdf parse: table detected (3 cols × 3 rows)', j3.headers.length === 3 && j3.totalRows === 3, { headers: j3.headers, rows: j3.totalRows });
check('pdf parse: Qty suggested number', j3.columns.find((c) => c.name === 'Qty')?.suggestedType === 'number', j3.columns);
const c3 = await r('POST', '/api/import/create', {
  jobId: j3.jobId, name: 'Imported catalog',
  columns: j3.columns.map((c) => ({ index: c.index, name: c.name, type: c.suggestedType, subtype: c.suggestedSubtype })),
});
created.push(c3.table.id);
check('pdf create: rows stored', c3.table.rows.length === 3);

/* ----- 3b. paragraph-only PDF (no aligned columns) -> single Text column ----- */
const paraPdf = buildPdf([
  { x: 60, y: 700, text: 'This is a plain paragraph of text without' },
  { x: 60, y: 685, text: 'any table structure or aligned columns.' },
  { x: 60, y: 655, text: 'Second paragraph, also just prose.' },
]);
const j3b = await r('POST', '/api/import/parse', { filename: 'notes.pdf', data: paraPdf.toString('base64') });
check('pdf paragraph: single Text column', j3b.headers.length === 1 && j3b.headers[0] === 'Text', j3b.headers);
check('pdf paragraph: lines become rows', j3b.totalRows >= 2, j3b.totalRows);

/* ================= 4. optional: scanned PDF -> OCR fallback ================= */
if (process.env.RUN_OCR === '1') {
  console.log('  … OCR run: embeds a rendered image inside a PDF and imports it (needs network for the eng traineddata on first run)…');
  const { createCanvas } = await import('@napi-rs/canvas');
  const { deflateSync } = await import('node:zlib'); // zlib-wrapped (0x78 header) — pdfjs FlateDecode requires it
  const canvas = createCanvas(900, 300);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 900, 300);
  ctx.fillStyle = '#000000'; ctx.font = 'bold 52px sans-serif';
  ctx.fillText('Widget order 45 units', 50, 120);
  ctx.fillText('total 129.50 dollars', 50, 220);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data; // RGBA rows
  const rgb = Buffer.alloc(rgba.length - rgba.length / 4);
  for (let i = 0, j = 0; i < rgba.length; i += 4) { rgb[j++] = rgba[i]; rgb[j++] = rgba[i + 1]; rgb[j++] = rgba[i + 2]; }
  const raw = deflateSync(rgb);
  // ---- assemble a one-page PDF containing that image, byte-accurately ----
  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  const pushStr = (s) => chunks.push(Buffer.from(s, 'latin1'));
  const obj = (num, parts) => {
    offsets[num - 1] = chunks.reduce((a, b) => a + b.length, 0);
    pushStr(`${num} 0 obj\n`);
    for (const p of parts) (typeof p === 'string' ? pushStr(p) : chunks.push(p));
    pushStr('\nendobj\n');
  };
  const content = 'q 900 0 0 300 0 0 cm /Im0 Do Q';
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>']);
  obj(3, ['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 900 300] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>']);
  obj(4, [`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n`, content, '\nendstream']);
  obj(5, [`<< /Type /XObject /Subtype /Image /Width 900 /Height 300 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${raw.length} >>\nstream\n`, raw, '\nendstream']);
  const xrefStart = chunks.reduce((a, b) => a + b.length, 0);
  pushStr(`xref\n0 6\n0000000000 65535 f \n`);
  for (const o of offsets) pushStr(String(o).padStart(10, '0') + ' 00000 n \n');
  pushStr(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);
  const pdfBytes = Buffer.concat(chunks);
  const j4 = await r('POST', '/api/import/parse', { filename: 'scan.pdf', data: pdfBytes.toString('base64') });
  const ocr = j4.sheetName || '';
  const text = j4.headers.concat(...(j4.preview || []).map((row) => row)).join(' ');
  check('scanned PDF took the OCR path', /ocr/i.test(ocr), ocr);
  check('OCR recovered readable rows', j4.totalRows >= 2 && /\d/.test(text), { text: text.slice(0, 200), rows: j4.totalRows });
} else {
  console.log('  – skip OCR e2e (set RUN_OCR=1 to exercise the scanned-PDF fallback)');
}

/* cleanup */
for (const id of created) { try { await r('DELETE', `/api/tables/${id}`); } catch { /* ignore */ } }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
