/*
 * One-off check: the page is served by a static host (Live Server style),
 * WITHOUT any ?df_api= override and with no backend anywhere. It must run in
 * browser (IndexedDB) mode from the very first page load and let the user
 * create a table through the UI.
 *
 *   node scripts/verify-static-host.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5598/';
const DEBUG_PORT = 9338;

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

await new Promise((res) => staticSrv.listen(5598, '127.0.0.1', res));
console.log(`static server on ${UI} (no df_api override, no backend anywhere)`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-static-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
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
const pageErrors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  } else if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    pageErrors.push(msg.params.args.map((x) => x.value || x.description || '').join(' ').split('\n')[0]);
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

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: UI + '#/login' });

  check('login page renders', await waitFor(`!!document.querySelector('#df-login-btn')`));
  check('browser layer active from first load (no backend attempt)', await evalJS(`window.DF_API_MODE === 'local'`), await evalJS(`window.DF_API_MODE`));
  check('no assets 404 (css/js loaded)', await evalJS(`!!document.querySelector('link[rel=stylesheet]') && getComputedStyle(document.body).backgroundImage !== 'none'`));

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('login lands on dashboard', await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`));

  // ---- demo data is auto-seeded on first run (browser mode) ----
  check('demo tables auto-seeded (Inventory + Sales log)', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Inventory') && [...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Sales log')`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Sales log'); c.click(); })()`);
  check('Sales log opens with 6 rows and computed Amount (12 × 89.9 = 1,078.8)', await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length === 6 && [...document.querySelectorAll('table.df tbody tr')[0].querySelectorAll('td')].some(td => td.textContent.includes('1,078.8'))`));
  check('demo tables ship with a summary row', await waitFor(`!!document.querySelector('table.df tfoot')`));
  await evalJS(`location.hash = '#/charts'`);
  check('demo charts listed (Sales over time + Sales by region)', await waitFor(`document.querySelectorAll('.chartmini').length >= 2 && [...document.querySelectorAll('.chartmini h4')].some(h => h.textContent === 'Sales by region')`));
  await evalJS(`location.hash = '#/'`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`);

  // create a table through the UI (the "how data is created" flow)
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New table')).click(); })()`);
  check('new-table modal opens', await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.toLowerCase().includes('create'))`));
  await evalJS(`(() => {
    const name = document.querySelector('.modal input[type=text]');
    if (name) { name.value = 'Live Server Demo'; name.dispatchEvent(new Event('input', { bubbles: true })); }
    [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Create table')).click();
  })()`);
  check('creation navigates into the new table workspace', await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.tw-head')`));
  await evalJS(`location.hash = '#/'`);
  check('new table card listed on dashboard', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Live Server Demo')`));

  const stored = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const list = await m.localApi.list({});
    return list.some(t => t.name === 'Live Server Demo');
  })()`);
  check('table persisted in IndexedDB (browser-side creation)', stored === true);

  check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)]);

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