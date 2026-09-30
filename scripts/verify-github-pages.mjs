/*
 * GitHub Pages compatibility check.
 *
 *   node scripts/verify-github-pages.mjs
 *
 * GitHub Pages differs from a local dev server in three ways that break static
 * sites in production:
 *   1. a project page is served from a SUBPATH (/<repo>/…), so any absolute
 *      /path reference 404s;
 *   2. the filesystem is case-SENSITIVE (Linux), so a mis-cased path 404s even
 *      though it works on Windows;
 *   3. the server sets real MIME types — a module served as octet-stream is
 *      refused by the browser.
 *
 * This serves the site the way Pages does (subpath + exact-case resolution +
 * Pages MIME types) and drives the real UI, failing on any 4xx/5xx or failed
 * request for a local URL.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = path.resolve('.');
const PUBLIC = path.join(ROOT, 'public');
const PORT = 5603;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PREFIX = '/Dataforge/public';
const DEBUG_PORT = 9363;
const EXPECTED_REDIRECT = 'https://VortexProtocol1633.github.io/Dataforge/public/index.html';

if (!fs.existsSync(CHROME)) {
  console.log(`SKIP: Chrome not found at ${CHROME}`);
  process.exit(0);
}

// GitHub Pages MIME types (verified against the live deployment).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Resolve a URL path against `root` with EXACT case (as Linux would). */
function resolveCaseSensitive(root, urlPath) {
  const parts = decodeURIComponent(urlPath).split('/').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (!fs.existsSync(cur) || !fs.statSync(cur).isDirectory()) return null;
    const real = fs.readdirSync(cur).find((n) => n === part); // exact match only
    if (!real) return null;
    cur = path.join(cur, real);
  }
  return cur;
}

const served = [];
const notFound = [];
const rootHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// The deployed stub points at the live URL; for the local run we retarget it.
const redirectLocal = rootHtml.replace(
  /url=https?:\/\/[^"]+/,
  `url=${ORIGIN}${PREFIX}/index.html`,
);

const srv = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'GET' && (url === '/Dataforge' || url === '/Dataforge/')) {
    res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(redirectLocal); return;
  }
  if (url === PREFIX || url.startsWith(PREFIX + '/')) {
    const rel = url.slice(PREFIX.length) || '/index.html';
    const file = resolveCaseSensitive(PUBLIC, rel === '/' ? '/index.html' : rel);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      served.push(rel);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res); return;
    }
    notFound.push(url);
    res.writeHead(404, { 'Content-Type': MIME['.txt'] }); res.end('404'); return;
  }
  // Anything outside the app subpath (e.g. the browser's automatic
  // /favicon.ico probe for the redirect stub) is not an app-asset failure.
  res.writeHead(404, { 'Content-Type': MIME['.txt'] }); res.end('404');
});
await new Promise((res) => srv.listen(PORT, '127.0.0.1', res));
console.log(`GitHub-Pages-style host: ${ORIGIN}/Dataforge/  →  ${PREFIX}/  (subpath, case-sensitive)`);

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 300) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static check: the deployed redirect target is the right subpath ----
check('root redirect targets the deployed subpath', rootHtml.includes(EXPECTED_REDIRECT), rootHtml.slice(0, 200));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-ghp-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

async function listTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('Chrome debug endpoint unavailable');
}
const page = (await listTargets()).find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
const pageErrors = [];
const badResponses = [];
const failedRequests = [];
const reqUrl = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    pageErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
  } else if (msg.method === 'Network.requestWillBeSent') {
    reqUrl.set(msg.params.requestId, msg.params.request.url);
  } else if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    if (r.url.startsWith(ORIGIN) && r.status >= 400) badResponses.push(`${r.status} ${r.url}`);
  } else if (msg.method === 'Network.loadingFailed') {
    const u = reqUrl.get(msg.params.requestId) || '';
    if (u.startsWith(ORIGIN)) failedRequests.push(`${msg.params.errorText} ${u}`);
  }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
async function evalJS(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}
async function waitFor(expr, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(150);
  }
  return false;
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  // start at the project root, exactly like a visitor hitting the Pages URL
  await send('Page.navigate', { url: `${ORIGIN}/Dataforge/` });

  check('project root redirects into the app', await waitFor(`location.pathname.startsWith('${PREFIX}/')`), await evalJS(`location.pathname`));
  check('login page renders under the subpath', await waitFor(`!!document.querySelector('#df-login-btn')`));
  check('served from the /Dataforge/public/ subpath', (await evalJS(`location.pathname`)).startsWith(PREFIX + '/'), await evalJS(`location.pathname`));
  check('app runs in browser mode (no backend on Pages)', await evalJS(`window.DF_API_MODE === 'local'`), await evalJS(`window.DF_API_MODE`));
  check('stylesheets + vendored scripts resolved', await evalJS(`!!document.querySelector('link[rel=stylesheet]') && typeof Chart !== 'undefined' && typeof window.DataForgeFx !== 'undefined'`));
  check('.mjs module loaded (demo data)', await evalJS(`(async () => { const m = await import('./js/demo-data.mjs'); return Array.isArray(m.DEMO_TABLES) && m.DEMO_TABLES.length > 0; })()`));

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('login works on the subpath', await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`));
  check('demo tables seeded on first visit', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Inventory')`));

  // the temporary-table feature must work here too
  const tempOk = await evalJS(`(async () => {
    const m = await import('./js/localstore.js');
    await m.localApi.create({ name: 'Pages Temp', ephemeral: true });
    const list = await m.localApi.list({ includeArchived: true });
    return list.some((t) => t.name === 'Pages Temp' && t.ephemeral);
  })()`);
  check('temporary tables work under the subpath', tempOk === true);

  check('no assets 404 (all local requests resolved)', notFound.length === 0, notFound);
  check('no failed/4xx-5xx local responses', badResponses.length === 0 && failedRequests.length === 0, [...badResponses, ...failedRequests]);
  check('files were actually served by the host', served.length > 10, served.length);
  check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)]);

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  try { ws.close(); } catch { /* ignore */ }
  chrome.kill();
  srv.close();
  process.exit(fail === 0 ? 0 : 1);
}
