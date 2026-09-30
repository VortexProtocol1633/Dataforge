/*
 * E2E for the STANDALONE mode: the front-end is served by a static dev server
 * (Live Server style) and the DataForge backend is NOT reachable — every api
 * call must transparently fall back to the IndexedDB local layer.
 *
 * Covers the flows the other suites miss:
 *   - standalone login + local dashboard
 *   - charts tab: auto-generated starter charts replace the removed "New chart"
 *   - Area chart type is gone from the builder
 *   - boolean cell toggle cycle (empty → Yes → No → Yes)
 *   - duplicating a linked (live) view must keep its rows/columns/values
 *   - CSV import through the real file picker (client-side parsing)
 *   - no uncaught page errors
 *
 * Needs Google Chrome. No backend required.
 *   node scripts/e2e-flows.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5599/';       // static server port
const DEAD_API = 'http://localhost:3999';  // nothing listens here → local mode
const DEBUG_PORT = 9337;

// ---- tiny static file server (stand-in for Live Server) ----
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };
const staticSrv = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// ---- sample CSV for the import flow ----
const csvFile = path.join(os.tmpdir(), `df-import-${Date.now()}.csv`);
fs.writeFileSync(csvFile, 'Product,Price,Stock\nWidget,9.99,40\nGadget,19.5,15\nSprocket,4,120\n');

await new Promise((res) => staticSrv.listen(5599, '127.0.0.1', res));
console.log(`static dev server on ${UI} (API pointed at dead ${DEAD_API} → local mode)`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-local-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const pageErrors = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 400) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('Chrome debug endpoint unavailable');
}
const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const events = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  } else events.push(msg);
};
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function drainErrors() {
  while (events.length) {
    const ev = events.shift();
    if (ev.method === 'Runtime.exceptionThrown') {
      const d = ev.params.exceptionDetails;
      pageErrors.push('EXC: ' + (d.exception?.description || d.text).split('\n')[0]);
    }
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') {
      const t = ev.params.entry.text || '';
      if (!/favicon|fonts\.googleapis|Failed to load resource/i.test(t)) pageErrors.push('LOG: ' + t.split('\n')[0]);
    }
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') {
      const a = ev.params.args.map((x) => x.value || x.description || '').join(' ').split('\n')[0];
      pageErrors.push('CONSOLE: ' + a);
    }
  }
}
async function waitFor(expr, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await drainErrors();
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(180);
  }
  return false;
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: UI + '?df_api=' + DEAD_API + '#/login' });

  // ---- 1. standalone login + dashboard ----
  check('login page renders', await waitFor(`!!document.querySelector('#df-login-btn')`));
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('standalone login lands on dashboard', await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`));
  check('api facade switched to LOCAL mode', await waitFor(`window.DF_API_MODE === 'local'`), await evalJS(`window.DF_API_MODE`));

  // ---- seed local demo data through the local layer itself ----
  const seed = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = await m.localApi.create({
      name: 'Inventory', description: 'local demo',
      columns: [
        { name: 'Item', type: 'text', options: {} },
        { name: 'Price', type: 'currency', options: { symbol: '$' } },
        { name: 'Qty', type: 'number', subtype: 'integer', options: {} },
        { name: 'Total', type: 'formula', options: { formula: 'ROUND([Price] * [Qty], 2)' } },
        { name: 'In stock', type: 'boolean', options: {} },
      ],
      rows: [],
    });
    const cid = (n) => t.columns.find((c) => c.name === n).id;
    await m.localApi.addRow(t.id, { [cid('Item')]: 'Office chair', [cid('Price')]: 89.9, [cid('Qty')]: 12 });
    await m.localApi.addRow(t.id, { [cid('Item')]: 'Desk lamp', [cid('Price')]: 18.5, [cid('Qty')]: 60, [cid('In stock')]: true });
    const c2 = await m.localApi.create({ name: 'Sales', description: '', columns: [
      { name: 'Region', type: 'dropdown', options: { list: ['North', 'South'] } },
      { name: 'Amount', type: 'number', subtype: 'decimal', options: {} },
    ], rows: [] });
    const rid = (n) => c2.columns.find((c) => c.name === n).id;
    await m.localApi.addRow(c2.id, { [rid('Region')]: 'North', [rid('Amount')]: 1200 });
    await m.localApi.addRow(c2.id, { [rid('Region')]: 'South', [rid('Amount')]: 640 });
    return { inv: t.id, sales: c2.id };
  })()`);
  check('local seed created 2 tables', !!seed && !!seed.inv && !!seed.sales);

  // reload → local tables must persist in IndexedDB across page loads
  await evalJS(`location.reload()`);
  check('seeded tables listed on dashboard after reload', await waitFor(
    `[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Inventory') && [...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Sales')`));

  // ---- 2. charts tab: starter charts are auto-saved; "New chart" is gone ----
  await evalJS(`location.hash = '#/charts'`);
  check('charts tab renders', await waitFor(`[...document.querySelectorAll('.page-head button')].some(b => b.textContent.includes('Go to tables'))`));
  check('no "New chart" button remains', await waitFor(`![...document.querySelectorAll('.page-head button')].some(b => b.textContent.includes('New chart'))`));
  // both seeded tables gained a starter chart the moment their first row landed
  check('starter charts auto-saved per table', await waitFor(
    `[...document.querySelectorAll('.chartmini h4')].some(h => h.textContent === 'Inventory overview') && [...document.querySelectorAll('.chartmini h4')].some(h => h.textContent === 'Sales overview')`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.chartmini')].find(x => x.querySelector('h4').textContent === 'Inventory overview'); if (c) c.click(); })()`);
  check('starter chart opens in the builder', await waitFor(`document.querySelectorAll('canvas').length > 0`));
  const noArea = await evalJS(`![...document.querySelectorAll('.modal select option')].some(o => o.textContent === 'Area')`);
  check('Area chart type is removed', !!noArea);
  await sleep(400);
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Close'); b && b.click(); })()`);
  check('chart modal closes', await waitFor(`!document.querySelector('.modal')`));

  // ---- 3. open Inventory: boolean toggle cycle on an EMPTY cell ----
  await evalJS(`location.hash = '#/'`);
  check('back on tables tab', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Inventory')`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Inventory'); c.click(); })()`);
  check('Inventory workspace loads', await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length === 2`));
  const boolPos = await evalJS(`[...document.querySelectorAll('table.df thead th')].map(t => t.textContent.trim()).findIndex(h => h.includes('In stock'))`);
  check('boolean column located', boolPos >= 0, boolPos);
  const cellSel = (r) => `document.querySelectorAll('table.df tbody tr')[${r}].querySelectorAll('td')[${boolPos}]`;
  // row 0 'Office chair' has an EMPTY boolean → click should set Yes
  await evalJS(`(() => { const td = ${cellSel(0)}; if (td) td.querySelector('.cell').click(); })()`);
  check('empty boolean cell → Yes', await waitFor(`!!(${cellSel(0)}).querySelector('.toggle.on')`));
  // click the Yes toggle → No
  await evalJS(`(() => { const el = (${cellSel(0)}).querySelector('.toggle'); el && el.click(); })()`);
  check('Yes → No', await waitFor(`!!(${cellSel(0)}).querySelector('.toggle') && !(${cellSel(0)}).querySelector('.toggle.on')`));
  // click the No toggle → Yes again
  await evalJS(`(() => { const el = (${cellSel(0)}).querySelector('.toggle'); el && el.click(); })()`);
  check('No → Yes', await waitFor(`!!(${cellSel(0)}).querySelector('.toggle.on')`));
  const storedBool = await evalJS(`(async () => { const m = await import('/js/localstore.js'); const id = location.hash.split('/').pop(); const t = await m.localApi.get(id); const col = t.columns.find(c => c.name === 'In stock'); return t.rows[0].values[col.id]; })()`);
  check('boolean value persisted as true', storedBool === true, storedBool);

  // ---- 4. duplicate a linked (live) view keeps data ----
  const invId = await evalJS(`location.hash.split('/').pop()`);
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Extract')).click(); })()`);
  check('extract modal opens', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Extract'))`));
  await evalJS(`(() => { const r = [...document.querySelectorAll('.modal input[type=radio]')].find(x => x.value === 'linked'); if (r) r.click(); })()`);
  await sleep(300);
  await evalJS(`(() => { const ovs = [...document.querySelectorAll('.overlay')]; const md = ovs[ovs.length - 1].querySelector('.modal'); const b = [...md.querySelectorAll('.modal-foot button')].find(x => /Extract/.test(x.textContent)); b && b.click(); })()`);
  check('linked view created + opened', await waitFor(
    `location.hash.startsWith('#/t/') && location.hash !== '#/t/${invId}' && !document.querySelector('.overlay')`));
  const linkState = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const id = location.hash.split('/').pop();
    const t = await m.localApi.get(id);
    return { kind: t.kind, rows: (t.rows || []).length, cols: (t.columns || []).length };
  })()`);
  check('linked view is live with source rows', linkState && linkState.kind === 'linked' && linkState.rows === 2 && linkState.cols === 5, JSON.stringify(linkState));
  check('read-only banner shows live view', await waitFor(`[...document.querySelectorAll('.tw-head .chip')].some(c => c.textContent.includes('live view'))`));

  await evalJS(`location.hash = '#/'`);
  check('back on dashboard (linked card present)', await waitFor(`[...document.querySelectorAll('.tcard')].some(c => c.textContent.includes('live view'))`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.textContent.includes('live view')); if (!c) return; c.querySelector('.actions .icon-btn').click(); })()`);
  check('linked card menu opens', await waitFor(`!!document.querySelector('.menu')`));
  await evalJS(`(() => { const b = [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('Duplicate')); b && b.click(); })()`);
  check('dashboard shows the duplicated card', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => (h.textContent || '').includes('(copy)'))`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => (x.querySelector('h3').textContent || '').includes('(copy)')); c.click(); })()`);
  check('copy opens with its rows', await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length === 2`));
  await sleep(300);
  const dupCheck = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const id = location.hash.split('/').pop();
    const t = await m.localApi.get(id);
    return {
      kind: t.kind,
      rows: (t.rows || []).length,
      cols: (t.columns || []).length,
      firstCell: t.rows[0] && t.columns[0] ? String(t.rows[0].values[t.columns[0].id]) : null,
      renderedItem: document.body.textContent.includes('Office chair'),
    };
  })()`);
  check('copy is an independent table with values intact', dupCheck && dupCheck.kind === 'table' && dupCheck.rows === 2 && dupCheck.cols === 5 && dupCheck.firstCell === 'Office chair', JSON.stringify(dupCheck));

  // ---- 5. CSV import through the real file input (client-side parsing) ----
  await evalJS(`location.hash = '#/'`);
  await waitFor(`!!document.querySelector('.tcard')`);
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('Import')).click(); })()`);
  check('import modal opens', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Import'))`));
  const doc = await send('DOM.getDocument');
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.modal input[type=file]' });
  check('file input found', !!q.nodeId);
  await send('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [csvFile] });
  check('csv parsed → mapping screen', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Review import'))`));
  await sleep(300);
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent.includes('Create table')); b && b.click(); })()`);
  // dashboard import reloads to the dashboard — the new table appears as a card
  check('imported table card appears on dashboard', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => (h.textContent || '').includes('df-import-'))`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => (x.querySelector('h3').textContent || '').includes('df-import-')); if (!c) return; c.click(); })()`);
  check('imported table opens with parsed rows', await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length === 3`));
  const importOk = await evalJS(`document.body.textContent.includes('Widget') && document.body.textContent.includes('Sprocket')`);
  check('imported CSV values present', importOk);

  // ---- 6. client-side exports round-trip (csv / xlsx / docx) ----
  const exp = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const id = location.hash.split('/').pop();
    const out = {};
    const csv = await m.localApi.exportData(id, 'csv');
    out.csvSize = csv.blob.size;
    out.csvOk = csv.filename.endsWith('.csv') && (await csv.blob.text()).includes('Widget');
    const xlsx = await m.localApi.exportData(id, 'xlsx');
    out.xlsxName = xlsx.filename;
    const wb = XLSX.read(await xlsx.blob.arrayBuffer(), { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    out.xlsxRows = rows.length;
    out.xlsxOk = rows.length === 4 && rows[0][0] === 'Product';
    const docx = await m.localApi.exportData(id, 'docx');
    out.docxName = docx.filename;
    const u8 = new Uint8Array(await docx.blob.arrayBuffer());
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65558); i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    let docXml = '';
    for (let n = 0; n < count; n++) {
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
      if (name === 'word/document.xml') {
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const size = dv.getUint32(localOff + 24, true); // stored → uncompressed == compressed
        docXml = new TextDecoder().decode(u8.subarray(start, start + size));
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    out.docxOk = docx.filename.endsWith('.docx') && docXml.includes('Widget') && docXml.includes('<w:tbl>');
    return out;
  })()`);
  check('csv export round-trips', !!exp && exp.csvSize > 0 && exp.csvOk, JSON.stringify(exp));
  check('xlsx export round-trips', !!exp && exp.xlsxName.endsWith('.xlsx') && exp.xlsxOk, JSON.stringify(exp));
  check('docx export round-trips (valid zip + document.xml)', !!exp && exp.docxName.endsWith('.docx') && exp.docxOk, JSON.stringify(exp));

  // ---- no uncaught page errors across the whole run ----
  await drainErrors();
  const distinct = [...new Set(pageErrors)];
  check('no uncaught page errors', distinct.length === 0, distinct);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('E2E CRASHED:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 4).join('\n'));
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  try { fs.rmSync(csvFile, { force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
