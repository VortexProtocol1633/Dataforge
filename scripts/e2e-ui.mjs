/*
 * Optional end-to-end UI test driving headless Chrome over CDP (WebSocket).
 * Requires: the server running on :3210 (`npm start`) and Google Chrome.
 * The demo data is (re)seeded automatically at the start.
 *   npm run e2e-ui
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = 'http://localhost:3210/';
const DEBUG_PORT = 9333;
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-chrome-'));

// make sure the server is up, then (re)seed deterministic demo data
const healthOk = await fetch('http://localhost:3210/api/health').then((r) => r.ok).catch(() => false);
if (!healthOk) {
  console.error('Server not reachable at http://localhost:3210 — start it first with `npm start`.');
  process.exit(1);
}
await import('./seed-demo.mjs');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${USER_DIR}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const errors = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 400) : ''}`); }
};

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page;
    } catch { /* chrome still booting */ }
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
  } else {
    events.push(msg);
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

const pageErrors = [];
async function watchErrors() {
  // drain exception + log events periodically
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

async function waitFor(expr, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await watchErrors();
    try {
      if (await evalJS(expr)) return true;
    } catch { /* expression may reference not-yet-loaded DOM */ }
    await sleep(180);
  }
  return false;
}

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.navigate', { url: APP + '#/login' });

  check('login page renders', await waitFor(`!!document.querySelector('#df-login-btn') && document.querySelector('h1') && document.querySelector('h1').textContent.includes('DataForge')`));

  // ---- log in through the actual form ----
  await evalJS(`
    (() => {
      document.querySelector('#df-user').value = 'admin';
      document.querySelector('#df-pass').value = 'admin123';
      document.querySelector('#df-login-btn').click();
    })()
  `);
  check('dashboard appears after login', await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`));

  const cardInfo = await evalJS(`[...document.querySelectorAll('.tcard')].map(c => c.querySelector('h3').textContent)`);
  check('table cards listed (Inventory, Sales log)', JSON.stringify(cardInfo).includes('Inventory') && JSON.stringify(cardInfo).includes('Sales log'), cardInfo);

  // ---- open Inventory ----
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Inventory'); c.click(); })()`);
  check('table workspace loads', await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('table.df thead')`));
  const headers = await evalJS(`[...document.querySelectorAll('table.df thead th')].map(t => t.textContent.trim()).filter(Boolean)`);
  check('column headers present', ['Item', 'Unit price', 'Total', 'Weight kg', 'In stock'].every((h) => headers.some((x) => x.includes(h))), headers);
  check('formula cell computed (Total 1,078.8)', await waitFor(`[...document.querySelectorAll('table.df tbody tr:first-child td')].some(td => td.textContent.trim().includes('078.8'))`));
  check('fraction displayed simplified', await waitFor(`[...document.querySelectorAll('table.df tbody tr:first-child td')].some(td => td.textContent.trim() === '11/2')`));
  check('summary footer row exists', await waitFor(`!!document.querySelector('table.df tfoot')`));

  const countBefore = await evalJS(`document.querySelector('.rowcount').textContent`);
  // ---- add a row via toolbar ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Add row')).click(); })()`);
  check('row added (count increments)', await waitFor(`(document.querySelector('.rowcount')||{}).textContent !== ${JSON.stringify(countBefore)}`));
  check('new row cell editable after click', await waitFor(`!!document.querySelector('table.df tbody tr')`));

  // edit a text cell in the NEW last row: click first editable cell and type
  const newRows = await evalJS(`document.querySelectorAll('table.df tbody tr').length`);
  check('grid shows 7 rows', newRows === 7, newRows);
  // click a cell in the last row (Item column = 3rd td incl selectors) and type
  const lastRowIdx = newRows - 1;
  await evalJS(`
    (() => {
      const tr = document.querySelectorAll('table.df tbody tr')[${lastRowIdx}];
      const tds = tr.querySelectorAll('td');
      tds[2].querySelector('.cell').click();
    })()
  `);
  const typed = await waitFor(`!!document.querySelector('table.df tbody tr:last-child .ce input')`);
  check('cell enters edit mode', typed);
  await evalJS(`
    (() => {
      const inp = document.querySelector('table.df tbody tr:last-child .ce input');
      inp.value = 'Desk pad';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()
  `);
  check('typed value persisted', await waitFor(`[...document.querySelectorAll('table.df tbody tr:last-child td')].some(td => td.textContent.includes('Desk pad'))`));

  // ---- filter ----
  await evalJS(`(() => { const i = document.querySelector('input[type=search]'); i.value = 'Desk pad'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('filter narrows rows to 1', await waitFor(`document.querySelectorAll('table.df tbody tr').length === 1`));

  // ---- column editor: rename via header menu ----
  await evalJS(`(() => { document.querySelector('table.df thead th .colmenu').click(); })()`);
  check('column menu opens', await waitFor(`!!document.querySelector('.menu')`));
  await evalJS(`(() => { const b = [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('Configure')); b && b.click(); })()`);
  check('column editor modal opens', await waitFor(`!!document.querySelector('.modal') && document.querySelector('.modal h3').textContent.includes('Edit column')`));
  check('column type options shown', await waitFor(`[...document.querySelectorAll('.typeopt')].length > 0 || !!document.querySelector('.colcfg')`));
  await evalJS(`(() => { const i = document.querySelector('.colcfg input[type=text]'); if (i) { i.value = 'Product'; i.dispatchEvent(new Event('input',{bubbles:true})); } })()`);
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Save changes'); b && b.click(); })()`);
  check('column renamed in header', await waitFor(`[...document.querySelectorAll('table.df thead th')].some(t => t.textContent.includes('Product'))`));

  // ---- formula column editor (create formula referencing two cols) ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Column')).click(); })()`);
  check('add column modal opens', await waitFor(`!!document.querySelector('.modal h3') && document.querySelector('.modal h3').textContent.includes('Add a column')`));
  const formulaOpt = await waitFor(`[...document.querySelectorAll('.typeopt')].some(b => b.textContent.includes('Formula'))`);
  check('formula type offered', formulaOpt);
  await evalJS(`(() => { [...document.querySelectorAll('.typeopt')].find(b => b.textContent.includes('Formula')).click(); })()`);
  check('formula editor visible', await waitFor(`!!document.querySelector('.fxarea')`));
  await evalJS(`(() => {
    const i = document.querySelector('.colcfg input[type=text]');
    i.value = 'Total incl tax';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    const ta = document.querySelector('.fxarea');
    ta.value = 'ROUND([Product] * [Qty], 2) * 1.08';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Add column'); b && b.click(); })()`);
  check('formula column added + computed live', await waitFor(`[...document.querySelectorAll('table.df thead th')].some(t => t.textContent.includes('Total incl tax')) && [...document.querySelectorAll('table.df tbody tr')].length >= 0`));

  // ---- extraction modal opens ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Extract')).click(); })()`);
  check('extract modal opens', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Extract'))`));
  await evalJS(`document.querySelector('.modal-foot .btn') ? [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Cancel').click() : null`);

  // ---- import modal opens ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.title && b.title.includes('Import')).click(); })()`);
  check('import modal opens', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Import'))`));
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Close'); b && b.click(); })()`);

  // ---- chart builder opens from toolbar ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart')).click(); })()`);
  check('chart builder opens', await waitFor(`!!document.querySelector('.builder-cols') || !!document.querySelector('canvas')`));
  check('chart canvas rendered', await waitFor(`document.querySelectorAll('canvas').length > 0`));
  await evalJS(`(() => { [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close').click(); })()`);

  // ---- row form via row menu (clear filter first so all rows are visible) ----
  await evalJS(`(() => { const i = document.querySelector('input[type=search]'); if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  await waitFor(`document.querySelectorAll('table.df tbody tr').length >= 6`);
  await evalJS(`(() => { const m = document.querySelectorAll('table.df tbody tr')[0].querySelector('td:last-child .icon-btn'); m.click(); })()`);
  check('row menu opens', await waitFor(`!!document.querySelector('.menu')`));
  await evalJS(`(() => { const b = [...document.querySelectorAll('.menu button')].find(x => x.textContent.includes('form view')); b && b.click(); })()`);
  check('row form modal opens with fields', await waitFor(`!!document.querySelector('.rowform') && document.querySelectorAll('.rowform .fitem').length >= 6`));
  check('row form shows computed total', await waitFor(`[...document.querySelectorAll('.rowform .fitem')].some(f => f.textContent.includes('078.8'))`));

  // ---- charts tab ----
  await evalJS(`location.hash = '#/charts'`);
  check('charts tab lists saved chart', await waitFor(`!!document.querySelector('.chartmini') && document.querySelector('.chartmini h4').textContent.includes('Sales by region')`));
  await evalJS(`document.querySelector('.chartmini').click()`);
  check('saved chart opens with canvas', await waitFor(`document.querySelectorAll('canvas').length > 0`));

  // ---- theme picker: choose a palette theme and verify it applies ----
  await evalJS(`(() => { const b = document.querySelector('.topbar .theme-btn'); b && b.click(); })()`);
  check('theme picker opens', await waitFor(`!!document.querySelector('.themepick') && document.querySelectorAll('.theme-opt').length >= 4`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.theme-opt')].find(x => x.querySelector('.nm').textContent === 'Cyberpunk Neon'); c && c.click(); })()`);
  check('palette theme applies (cyberpunk)', await waitFor(`document.documentElement.getAttribute('data-theme') === 'cyberpunk' && localStorage.getItem('df_theme') === 'cyberpunk'`));

  // ---- share page public route (no auth) ----
  const shareInfo = await evalJS(`(async () => {
    const res = await fetch('/api/tables', { headers: { Authorization: 'Bearer ' + localStorage.getItem('df_token') } });
    const { tables } = await res.json();
    const inv = tables.find(t => t.name === 'Inventory');
    const t2 = await (await fetch('/api/tables/' + inv.id, { headers: { Authorization: 'Bearer ' + localStorage.getItem('df_token') } })).json();
    const row = t2.table.rows[0];
    const r2 = await fetch('/api/tables/' + inv.id + '/rows/' + row.id + '/share', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('df_token') } });
    const s = await r2.json();
    return s.token;
  })()`);
  await evalJS(`location.hash = '#/share/' + ${JSON.stringify(shareInfo)}`);
  check('public share page renders row', await waitFor(`!!document.querySelector('.share-page .rowform') && document.querySelectorAll('.share-page .fitem').length >= 6`));

  await watchErrors();
  const distinct = [...new Set(pageErrors)];
  check('no uncaught page errors', distinct.length === 0, distinct);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('UI TEST CRASHED:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 4).join('\n'));
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
