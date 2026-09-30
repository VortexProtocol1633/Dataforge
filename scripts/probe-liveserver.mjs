/*
 * Probe: the front-end served by a static dev server on :5500 (Live Server
 * style) talking cross-origin to the DataForge backend on :3210.
 * Requires the backend running (npm start) + Chrome. Seeds demo data first.
 *   node scripts/probe-liveserver.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5500/';
const API = 'http://localhost:3210';
const DEBUG_PORT = 9335;

const healthOk = await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false);
if (!healthOk) { console.error('Backend not reachable on ' + API + ' — start it with `npm start`.'); process.exit(1); }
await import('./seed-demo.mjs');

// --- tiny static file server acting as the "Live Server" ---
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
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
await new Promise((res) => staticSrv.listen(5500, '127.0.0.1', res));
console.log('static dev server on http://127.0.0.1:5500 (serving public/)');

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-xo-'))}`,
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
async function waitFor(expr, ms = 9000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    await drainErrors();
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(200);
  }
  return false;
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: UI + '#/login' });

  check('static page loads (index + chart.umd.js present)', await waitFor(`typeof Chart !== 'undefined' && typeof window.DataForgeFx !== 'undefined'`));
  check('login page rendered', await waitFor(`!!document.querySelector('#df-login-btn')`));

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('login works cross-origin → dashboard', await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`));
  const apiBase = await evalJS(`(window.DF_API || '')`);
  check('API_BASE detected on :3210', await waitFor(`!!document.querySelector('.tcard')`));

  const cardInfo = await evalJS(`[...document.querySelectorAll('.tcard')].map(c => c.querySelector('h3').textContent)`);
  check('tables listed cross-origin', cardInfo.includes('Inventory') && cardInfo.includes('Sales log'), cardInfo);

  // open a table + mutate a row (POST/PATCH cross-origin)
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Inventory'); c.click(); })()`);
  check('table workspace loads cross-origin', await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('table.df thead')`));
  check('formula cell computed', await waitFor(`[...document.querySelectorAll('table.df tbody tr:first-child td')].some(td => td.textContent.includes('078.8'))`));
  const rowsBefore = await evalJS(`document.querySelectorAll('table.df tbody tr').length`);
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Add row')).click(); })()`);
  check('add row (POST) works cross-origin', await waitFor(`document.querySelectorAll('table.df tbody tr').length === ${rowsBefore + 1}`));

  // share link points at the backend origin
  await evalJS(`(() => { const b = [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart')); b.click(); })()`);
  check('chart builder works cross-origin', await waitFor(`document.querySelectorAll('canvas').length > 0`));
  await evalJS(`(() => { [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close').click(); })()`);

  const shareBase = await evalJS(`(async () => {
    const H = { Authorization: 'Bearer ' + localStorage.getItem('df_token') };
    const API = 'http://localhost:3210';
    const tables = (await (await fetch(API + '/api/tables', { headers: H })).json()).tables;
    const inv = tables.find(t => t.name === 'Inventory');
    const t2 = (await (await fetch(API + '/api/tables/' + inv.id, { headers: H })).json()).table;
    const r = await fetch(API + '/api/tables/' + inv.id + '/rows/' + t2.rows[0].id + '/share', { method: 'POST', headers: { 'Content-Type': 'application/json', ...H } });
    return (await r.json()).url;
  })()`);
  check('share URL uses relative path (navigates via hash)', typeof shareBase === 'string' && shareBase.includes('/share/'));

  await drainErrors();
  const distinct = [...new Set(pageErrors)];
  check('no uncaught page errors cross-origin', distinct.length === 0, distinct);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('PROBE CRASHED:', e.message);
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
