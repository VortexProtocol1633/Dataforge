/*
 * Captures the small screenshot gallery shown inside the Help modal
 * (dashboard, table workspace, formula-column editor, chart builder).
 *
 *   node scripts/capture-help.mjs
 *
 * Boots the static site like the verify suites (standalone/local mode so the
 * demo dataset is seeded automatically), logs in with the demo account and
 * walks the real UI. Requires Google Chrome. No backend needed.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const OUT_DIR = path.join(PUBLIC, 'assets', 'help');
const UI = 'http://127.0.0.1:5611/';
const DEBUG_PORT = 9346;

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
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

await new Promise((res) => staticSrv.listen(5611, '127.0.0.1', res));
console.log(`static server on ${UI}`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-cap-'))}`,
  '--window-size=1440,950', 'about:blank',
], { stdio: 'ignore' });

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
async function waitFor(expr, ms = 12000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(180);
  }
  return false;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

async function shot(name) {
  await sleep(700); // let animations / fonts settle
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  if (!r || !r.data) throw new Error(`No screenshot data for ${name}`);
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log(`  saved assets/help/${name}.png`);
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: UI + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  // force light theme for consistent shots
  await evalJS(`localStorage.setItem('df_theme','light')`);
  await send('Page.reload');
  await waitFor(`!!document.querySelector('#df-login-btn')`);

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  const onDash = await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`);
  if (!onDash) throw new Error('Did not reach the dashboard with demo tables');
  console.log('on dashboard with demo data');
  await shot('dashboard');

  // ---- table workspace (open the first demo table card) ----
  await evalJS(`(() => { const c = document.querySelector('.tcard'); if (c) c.click(); })()`);
  const inTable = await waitFor(`location.hash.startsWith('#/t/') && document.querySelectorAll('table.df tbody tr').length > 0`);
  if (!inTable) throw new Error('Table workspace did not open with rows');
  await shot('table');

  // ---- formula column editor ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Column')).click(); })()`);
  await waitFor(`!!document.querySelector('.typeopt')`);
  await evalJS(`(() => { [...document.querySelectorAll('.typeopt')].find(b => b.textContent.includes('Formula')).click(); })()`);
  const fxOpen = await waitFor(`!!document.querySelector('.fxarea') && !!document.querySelector('.fxref')`);
  if (!fxOpen) throw new Error('Formula editor + function browser did not open');
  await shot('column-formula');
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Cancel'); b && b.click(); })()`);
  await waitFor(`!document.querySelector('.overlay')`);

  // ---- chart builder from the table toolbar ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart')).click(); })()`);
  const built = await waitFor(`document.querySelectorAll('canvas').length > 0`);
  if (!built) throw new Error('Chart builder did not render a chart');
  await shot('chart-builder');
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Close'); b && b.click(); })()`);

  console.log('\nAll screenshots captured.');
} catch (e) {
  console.log('CAPTURE FAILED:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 4).join('\n'));
  process.exitCode = 1;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
}
