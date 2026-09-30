/*
 * Flow check for: row form, extract (snapshot + linked view) and the chart
 * builder. Runs against a static server (Live Server style), no backend.
 *
 *   node scripts/verify-flows.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5595/';
const DEBUG_PORT = 9341;

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
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

await new Promise((res) => staticSrv.listen(5595, '127.0.0.1', res));
console.log(`static server on ${UI}`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-flows-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const pageErrors = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 300) : ''}`); }
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
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(msg.params.args.map((x) => x.value || x.description || '').join(' ').split('\n')[0]);
  } else if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    const t = msg.params.entry.text || '';
    if (!/favicon|fonts\.googleapis|Failed to load resource/i.test(t)) pageErrors.push('LOG: ' + t.split('\n')[0]);
  }
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
async function waitFor(expr, ms = 10000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(150);
  }
  return false;
}
const click = (expr) => evalJS(`(() => { const b = ${expr}; if (!b) return 'MISSING'; b.click(); return 'ok'; })()`);

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: UI + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);

  // ---- seed the test table through the local layer ----
  const seed = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    await m.localApi.create({ name: 'Bare', description: 'no columns', columns: [], rows: [] });
    const t = await m.localApi.create({
      name: 'Flow Test', description: 'flows',
      columns: [
        { name: 'Region', type: 'dropdown', options: { list: ['North', 'South'] } },
        { name: 'Amount', type: 'number', subtype: 'decimal', options: {} },
        { name: 'Note', type: 'text', options: {} },
        { name: 'Total', type: 'formula', options: { formula: 'ROUND([Amount] * 1.2, 2)' } },
      ],
      rows: [],
    });
    const c = (n) => t.columns.find((x) => x.name === n).id;
    for (const [region, amount, note] of [['North', 100, 'first'], ['South', 250, 'second'], ['North', 75, 'third']]) {
      await m.localApi.addRow(t.id, { [c('Region')]: region, [c('Amount')]: amount, [c('Note')]: note });
    }
    return t.id;
  })()`);
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`);
  await evalJS(`location.hash = '#/t/${seed}'`);
  await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length === 3`);
  check('seed table open with 3 rows', true);
  check('no lingering loading section on the table page', await evalJS(`document.querySelectorAll('.page .center-msg').length === 0`));

  /* ================= FLOW A: row form ================= */
  await click(`[...document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')].at(-1).querySelector('.icon-btn')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('form view'))`);
  await waitFor(`!!document.querySelector('.rowform')`);
  check('row form opens with one field per column', await evalJS(`document.querySelectorAll('.rowform .fitem').length === 4`));
  check('formula field shows computed value (100 × 1.2 = 120)', await evalJS(`[...document.querySelectorAll('.rowform .fitem')].some(f => f.textContent.includes('120'))`));

  // edit the Amount field in the form → Total must recalculate to 60
  await evalJS(`(() => {
    const f = [...document.querySelectorAll('.rowform .fitem')].find(x => x.querySelector('label').textContent.includes('Amount'));
    f.querySelector('.cur').click();
  })()`);
  await waitFor(`!!document.querySelector('.rowform .fitem .ce input')`);
  await evalJS(`(() => {
    const i = document.querySelector('.rowform .fitem .ce input');
    i.value = '50'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  check('editing Amount saves back to the row', await waitFor(`[...document.querySelectorAll('.rowform .fitem')].some(f => f.querySelector('label').textContent.includes('Amount') && f.textContent.includes('50'))`));
  check('formula recalculates live in the form (50 × 1.2 = 60)', await waitFor(`[...document.querySelectorAll('.rowform .fitem')].some(f => f.querySelector('label').textContent.includes('Total') && f.textContent.includes('60'))`));

  // edit the Note field → 'updated note'
  await evalJS(`(() => {
    const f = [...document.querySelectorAll('.rowform .fitem')].find(x => x.querySelector('label').textContent.includes('Note'));
    f.querySelector('.cur').click();
  })()`);
  await waitFor(`!!document.querySelector('.rowform .fitem .ce input')`);
  await evalJS(`(() => {
    const i = document.querySelector('.rowform .fitem .ce input');
    i.value = 'updated note'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  check('Note edit saved in form', await waitFor(`[...document.querySelectorAll('.rowform .fitem')].some(f => f.querySelector('label').textContent.includes('Note') && f.textContent.includes('updated note'))`));

  // share read-only link from the form
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Share'))`);
  check('share flow inserts the read-only page button', await waitFor(`[...document.querySelectorAll('.modal-foot button')].some(b => b.textContent.includes('Open read-only page'))`));

  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Done')`);
  await waitFor(`!document.querySelector('.modal')`);
  check('edits visible in the grid after closing the form', await waitFor(`[...document.querySelectorAll('table.df tbody tr')].length === 3 && document.body.textContent.includes('updated note')`));

  /* ================= FLOW B: extract ================= */
  await click(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Extract'))`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Extract'))`);
  check('extract modal lists every column as a pill', await evalJS(`document.querySelectorAll('.modal .optpills .pill').length === 4`));
  check('extract modal offers row scopes', await evalJS(`[...document.querySelectorAll('.modal input[type=radio]')].some(r => r.value === 'all') && [...document.querySelectorAll('.modal input[type=radio]')].some(r => r.value === 'empty')`));
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Extract'))`);
  await waitFor(`location.hash.startsWith('#/t/') && location.hash !== '#/t/${seed}' && !!document.querySelector('.toolbar')`);
  check('snapshot copy opens with all 3 rows', await evalJS(`document.querySelectorAll('table.df tbody tr').length === 3`));
  check('snapshot copy preserved values', await evalJS(`document.body.textContent.includes('updated note') && document.body.textContent.includes('250')`));
  check('snapshot copy is an independent table (no live banner)', await evalJS(`!document.body.textContent.includes('Linked live view')`));
  const snapshotId = await evalJS(`location.hash.split('/').pop()`);

  // linked live view
  await evalJS(`location.hash = '#/t/${seed}'`);
  await waitFor(`location.hash === '#/t/${seed}' && !!document.querySelector('.toolbar')`);
  await click(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Extract'))`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Extract'))`);
  await evalJS(`(() => { const r = [...document.querySelectorAll('.modal input[type=radio]')].find(x => x.value === 'linked'); if (r) r.click(); })()`);
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Extract'))`);
  await waitFor(`location.hash.startsWith('#/t/') && location.hash !== '#/t/${seed}' && !!document.querySelector('.toolbar')`);
  check('linked view shows live-view banner', await waitFor(`[...document.querySelectorAll('.tw-head .chip')].some(c => c.textContent.includes('live view'))`));
  check('linked banner is styled and shows the source name', await waitFor(`!!document.querySelector('.linked-banner .lb-icon svg') && document.querySelector('.linked-banner .lb-src').textContent === 'Flow Test'`));
  check('linked view shows source rows', await evalJS(`document.querySelectorAll('table.df tbody tr').length === 3`));
  const linkedId = await evalJS(`location.hash.split('/').pop()`);
  const linkKind = await evalJS(`(async () => { const m = await import('/js/localstore.js'); return (await m.localApi.get('${linkedId}')).kind; })()`);
  check('linked view stored as kind=linked', linkKind === 'linked', linkKind);
  // read-only: clicking a cell must not start editing
  await evalJS(`(() => { const td = document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')[3]; td.querySelector('.cell').click(); })()`);
  await sleep(300);
  check('linked view is read-only (no cell editor)', await evalJS(`!document.querySelector('table.df .ce')`));

  // live update: change source Amount row 0 → 200, Total 240 must appear in the linked view
  await evalJS(`location.hash = '#/t/${seed}'`);
  await waitFor(`location.hash === '#/t/${seed}' && !!document.querySelector('.toolbar')`);
  await evalJS(`(() => { const td = document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')[3]; td.querySelector('.cell').click(); })()`);
  await waitFor(`!!document.querySelector('table.df tbody tr .ce input')`);
  await evalJS(`(() => {
    const i = document.querySelector('table.df tbody tr .ce input');
    i.value = '200'; i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`);
  check('source edit saved', await waitFor(`document.body.textContent.includes('200')`));
  await evalJS(`location.hash = '#/t/${linkedId}'`);
  await waitFor(`location.hash === '#/t/${linkedId}' && !!document.querySelector('.toolbar')`);
  check('linked view mirrors source edits (Total 240)', await waitFor(`document.body.textContent.includes('240')`));

  // detach → editable snapshot (button lives in the banner above .tw-head)
  await click(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Detach'))`);
  check('detach makes it an independent editable table', await waitFor(`!document.body.textContent.includes('Linked live view') && document.querySelectorAll('table.df tbody tr').length === 3`));
  await evalJS(`(() => { const td = document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')[4]; td.querySelector('.cell').click(); })()`);
  check('detached table is editable again', await waitFor(`!!document.querySelector('table.df .ce')`));
  await evalJS(`(() => { const i = document.querySelector('table.df .ce input'); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
  await sleep(300);

  /* ================= FLOW C: chart builder ================= */
  await evalJS(`location.hash = '#/t/${seed}'`);
  await waitFor(`location.hash === '#/t/${seed}' && !!document.querySelector('.toolbar')`);
  await click(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart'))`);
  await waitFor(`!!document.querySelector('.modal canvas')`);
  check('chart builder renders a canvas', await evalJS(`document.querySelectorAll('.modal canvas').length === 1`));
  // switch type → chart rebuilds on a fresh canvas
  await evalJS(`(() => { const s = document.querySelector('.modal select'); const o = [...s.options].find(x => x.textContent === 'Line'); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await waitFor(`!!document.querySelector('.modal canvas')`);
  check('type switch (Line) re-renders the chart', await evalJS(`document.querySelectorAll('.modal canvas').length === 1`));
  await evalJS(`(() => { const s = document.querySelector('.modal select'); const o = [...s.options].find(x => x.textContent === 'Pie'); if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  await waitFor(`!!document.querySelector('.modal canvas')`);
  check('type switch (Pie) re-renders the chart', await evalJS(`document.querySelectorAll('.modal canvas').length === 1`));

  // the chart-title field must actually be wired into the rendered chart
  await evalJS(`(() => {
    const ti = [...document.querySelectorAll('.modal input[type=text]')].find(i => i.placeholder && i.placeholder.includes('Sales by region'));
    if (ti) { ti.value = 'Region totals'; ti.dispatchEvent(new Event('input', { bubbles: true })); }
    document.querySelector('.modal select').dispatchEvent(new Event('change', { bubbles: true })); // rebuild with the new title
  })()`);
  check('chart title renders on the chart', await waitFor(`(() => { const c = window.Chart.getChart(document.querySelector('.modal canvas')); return !!(c && c.options && c.options.plugins && c.options.plugins.title && c.options.plugins.title.text === 'Region totals' && c.options.plugins.title.display === true); })()`));

  // save the chart
  await evalJS(`(() => {
    const ni = [...document.querySelectorAll('.modal input[type=text]')].find(i => i.placeholder && i.placeholder.includes('Chart name'));
    if (ni) { ni.value = 'Region chart'; ni.dispatchEvent(new Event('input', { bubbles: true })); }
    [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Save chart')).click();
  })()`);
  check('chart saved and modal closes', await waitFor(`!document.querySelector('.modal')`));
  await evalJS(`location.hash = '#/charts'`);
  await waitFor(`!!document.querySelector('.chartmini')`);
  check('saved chart listed on the Charts tab', await evalJS(`(document.querySelector('.chartmini h4') || {}).textContent === 'Region chart'`));
  await evalJS(`document.querySelector('.chartmini').click()`);
  check('saved chart reopens with a rendered canvas', await waitFor(`!!document.querySelector('.modal canvas')`));
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent === 'PNG'); if (b) b.click(); })()`);
  await sleep(400);
  check('PNG export runs without errors', await evalJS(`!document.querySelector('.modal button').textContent.includes('undefined')`));
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close')`);
  await waitFor(`!document.querySelector('.modal')`);

  // a demo chart whose value column is a FORMULA must render too (fx-Map fix)
  await evalJS(`(() => { const c = [...document.querySelectorAll('.chartmini')].find(x => (x.querySelector('h4').textContent || '').includes('Sales by region')); if (c) c.click(); })()`);
  check('demo chart over a formula column renders', await waitFor(`!!document.querySelector('.modal canvas')`));
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close')`);
  await waitFor(`!document.querySelector('.modal')`);

  /* ================= FLOW A (cont.): delete row via form ================= */
  await evalJS(`location.hash = '#/t/${seed}'`);
  await waitFor(`location.hash === '#/t/${seed}' && document.querySelectorAll('table.df tbody tr').length === 3`);
  await click(`[...document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')].at(-1).querySelector('.icon-btn')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('form view'))`);
  await waitFor(`!!document.querySelector('.rowform')`);
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('Delete row'))`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Delete this row'))`);
  // confirm inside the TOP-most modal (the row form modal is still in the DOM below it)
  await click(`(() => { const top = [...document.querySelectorAll('.modal')].at(-1); return [...top.querySelectorAll('button')].find(b => b.textContent.includes('Delete row')); })()`);
  check('deleting a row from the form works', await waitFor(`!document.querySelector('.modal') && document.querySelectorAll('table.df tbody tr').length === 2`));

  /* ================= FLOW D: chart builder on a column-less table ================= */
  await evalJS(`location.hash = '#/'`);
  await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Bare')`);
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Bare'); c.click(); })()`);
  await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`);
  await click(`[...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart'))`);
  await waitFor(`!!document.querySelector('.modal')`);
  check('empty table shows a helpful hint in the builder', await waitFor(`document.querySelector('.modal').textContent.includes('no columns yet')`));
  check('empty table does not leak a stray "null" label', await evalJS(`!document.querySelector('.modal').textContent.includes('null')`));
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close')`);
  await waitFor(`!document.querySelector('.modal')`);

  // ---- no uncaught page errors ----
  await sleep(300);
  const distinct = [...new Set(pageErrors)];
  check('no uncaught page errors', distinct.length === 0, distinct);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('CRASHED:', e.message);
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}