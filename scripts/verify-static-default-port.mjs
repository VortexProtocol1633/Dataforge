/*
 * Regression check: a static host served on the DEFAULT port — so
 * `location.port === ''`, exactly like GitHub Pages over HTTPS — must still
 * let a user log in. The front-end initially guesses "remote", the API calls
 * 404 on the static host, and the data layer must transparently fall back to
 * browser (IndexedDB) mode instead of failing the login.
 *
 *   node scripts/verify-static-default-port.mjs
 *
 * Binds port 80, which is free on most dev machines but needs privileges on
 * Linux/macOS; when it (or Chrome) is unavailable the script skips cleanly.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1/';
const PORT = 80;
const DEBUG_PORT = 9360;

if (!fs.existsSync(CHROME)) {
  console.log(`SKIP: Chrome not found at ${CHROME}`);
  process.exit(0);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json' };
const staticSrv = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  // Only GET of a real file is served; everything else (e.g. POST /api/…) 404s,
  // which is what a plain static host does.
  if (req.method !== 'GET' || !file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

const bound = await new Promise((resolve) => {
  staticSrv.once('error', (e) => resolve(e));
  staticSrv.listen(PORT, '127.0.0.1', () => resolve(null));
});
if (bound) {
  console.log(`SKIP: cannot bind port ${PORT} (${bound.code}) — run as root or on a free port`);
  process.exit(0);
}
console.log(`static server on ${UI} (default port => location.port === '', no backend)`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-defport-'))}`,
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
  check('served on the default port (location.port === "")', await evalJS(`location.port === ''`), await evalJS(`location.port`));
  check('initial guess is remote (the bug scenario)', await evalJS(`window.DF_API_MODE === 'remote'`), await evalJS(`window.DF_API_MODE`));

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('login succeeds and lands on dashboard', await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`));
  check('data layer fell back to browser (IndexedDB) mode', await evalJS(`window.DF_API_MODE === 'local'`), await evalJS(`window.DF_API_MODE`));
  check('demo tables available after login', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Inventory')`));
  check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)]);

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  process.exit(fail === 0 ? 0 : 1);
}
