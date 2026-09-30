/* Temporary diagnostics for the Help modal layout — deletes itself after run. */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5613/';
const DEBUG_PORT = 9348;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const staticSrv = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('nope'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => staticSrv.listen(5613, '127.0.0.1', r));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-aud2-'))}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      const p = l.find((t) => t.type === 'page');
      if (p) return p;
    } catch { /* boot */ }
    await sleep(250);
  }
  throw new Error('no debug target');
}
const target = await getTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
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
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await evalJS(expr)) return true; } catch { /* not ready */ }
    await sleep(150);
  }
  return false;
}
let pass = 0, fail = 0;
function check(n, ok, extra) {
  if (ok) { pass++; console.log('  ok  ' + n); }
  else { fail++; console.log('FAIL  ' + n + (extra ? ' :: ' + String(extra).slice(0, 400) : '')); }
}
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: UI + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  await evalJS(`localStorage.setItem('df_theme','light')`);
  await send('Page.reload');
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`);
  await evalJS(`(() => { [...document.querySelectorAll('.topbar .navbtn')].find(b => b.textContent.includes('Help')).click(); })()`);
  await waitFor(`!!document.querySelector('.help-layout')`);
  const boxes = await evalJS(`(() => {
    const sel = (s) => { const el = document.querySelector(s); return el ? { ch: el.clientHeight, sh: el.scrollHeight, cw: el.clientWidth, sw: el.scrollWidth } : null; };
    return { vh: window.innerHeight, modal: sel('.modal'), body: sel('.modal-body'), layout: sel('.help-layout'), side: sel('.help-side'), topics: sel('.help-topics'), pane: sel('.help-pane'), head: sel('.modal-head'), foot: sel('.modal-foot') };
  })()`);
  console.log('BOXES', JSON.stringify(boxes, null, 1));

  // verify screenshots on every topic that has them
  const shotsTopics = ['The dashboard', 'Work with a table', 'Formula columns', 'Create a chart'];
  for (const label of shotsTopics) {
    await evalJS(`(() => { [...document.querySelectorAll('.help-topic-btn')].find(b => b.textContent.includes(${JSON.stringify(label)})).click(); })()`);
    await waitFor(`document.querySelectorAll('.help-shot img').length > 0`);
    await sleep(700);
    const imgs = await evalJS(`[...document.querySelectorAll('.help-shot img')].map(i => ({ src: i.getAttribute('src'), loaded: i.naturalWidth > 0 }))`);
    check(`${label}: screenshots load`, imgs.every((i) => i.loaded), JSON.stringify(imgs));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('AUDIT2 CRASHED:', e.message);
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  try { fs.rmSync('scripts/audit-help.mjs', { force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}