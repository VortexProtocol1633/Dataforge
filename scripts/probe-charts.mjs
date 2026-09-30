/* Temporary probe: chart creation + PNG/JPG download against a running backend (:3210). */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.PROBE_URL || 'http://localhost:3210/';
const DEBUG_PORT = 9351;
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-dl-'));
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-probe-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${USER_DIR}`,
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
const downloads = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
  } else {
    events.push(msg);
    if (msg.method === 'Browser.downloadWillBegin') downloads.push(msg.params.suggestedFilename);
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
async function waitDownloads(n, ms = 8000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const files = fs.readdirSync(DL_DIR).filter((f) => !f.endsWith('.crdownload'));
      if (files.length >= n) return files;
    } catch { /* ignore */ }
    await sleep(150);
  }
  try { return fs.readdirSync(DL_DIR).filter((f) => !f.endsWith('.crdownload')); } catch { return []; }
}

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
  await send('Page.navigate', { url: APP + '#/login' });
  check('login page renders', await waitFor(`!!document.querySelector('#df-login-btn')`));
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('dashboard after login', await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`));
  const mode = await evalJS(`window.DF_API_MODE`);
  console.log('  info: api mode =', mode);

  // ---- pre-existing saved charts on the charts tab ----
  await evalJS(`location.hash = '#/charts'`);
  check('charts tab lists saved charts', await waitFor(`document.querySelectorAll('.chartmini').length > 0`));
  const chartNames = await evalJS(`[...document.querySelectorAll('.chartmini h4')].map(h => h.textContent)`);
  console.log('  info: saved charts =', chartNames);

  // ---- table cards must contain a chart preview (expected feature) ----
  await evalJS(`location.hash = '#/'`);
  await waitFor(`!!document.querySelector('.tcard')`);
  const cardChartCount = await evalJS(`document.querySelectorAll('.tcard canvas').length`);
  check('table cards render a mini chart preview', cardChartCount > 0, 'cards with canvas = ' + cardChartCount);

  // ---- create a NEW chart from the charts tab ----
  await evalJS(`location.hash = '#/charts'`);
  await waitFor(`[...document.querySelectorAll('.page-head button')].some(b => b.textContent.includes('New chart'))`);
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New chart')).click(); })()`);
  check('builder opens table-less', await waitFor(`[...document.querySelectorAll('.modal select option')].some(o => o.textContent === 'Sales log')`));
  await evalJS(`(() => { const sel = document.querySelector('.modal select'); if (!sel) return; const o = [...sel.options].find(x => x.textContent === 'Sales log'); if (o) { sel.value = o.value; sel.dispatchEvent(new Event('change', { bubbles: true })); } })()`);
  check('chart renders after picking table', await waitFor(`document.querySelectorAll('.modal canvas').length > 0`));
  const canvasW = await evalJS(`(function(){ const c = document.querySelector('.modal canvas'); return c ? c.offsetWidth + 'x' + c.offsetHeight : 'none'; })()`);
  console.log('  info: modal canvas size =', canvasW);

  // ---- name it, save it ----
  await evalJS(`(() => {
    const ni = [...document.querySelectorAll('.modal input[type=text]')].find(i => i.placeholder && i.placeholder.includes('Chart name'));
    if (ni) { ni.value = 'Probe Chart'; ni.dispatchEvent(new Event('input', { bubbles: true })); }
    [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Save chart')).click();
  })()`);
  check('new chart saved + modal closes', await waitFor(`!document.querySelector('.modal')`));
  await evalJS(`location.hash = '#/charts'`);
  check('new chart appears in list', await waitFor(`[...document.querySelectorAll('.chartmini h4')].some(h => h.textContent === 'Probe Chart')`));

  // ---- download PNG ----
  await evalJS(`(() => { const c = [...document.querySelectorAll('.chartmini')].find(x => (x.querySelector('h4').textContent || '').includes('Sales by region')); if (c) c.click(); })()`);
  check('saved chart reopens', await waitFor(`!!document.querySelector('.modal canvas')`));
  const modalsInfo = await evalJS(`[...document.querySelectorAll('.modal')].map((m, i) => ({
    i,
    title: (m.querySelector('h3') || {}).textContent,
    buttons: [...m.querySelectorAll('button')].map(b => String(b.textContent).trim()),
    canvas: m.querySelectorAll('canvas').length,
    builderCols: !!m.querySelector('.builder-cols'),
    bodyText: m.querySelector('.modal-body') ? m.querySelector('.modal-body').textContent.slice(0, 120) : '',
  }))`);
  console.log('  info: modals =', JSON.stringify(modalsInfo, null, 1).slice(0, 1400));
  await evalJS(`(() => {
    window.__dl = [];
    window.__clk = [];
    window.__rej = '';
    const origA = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { window.__dl.push({ href: String(this.href||'').slice(0,50), dl: this.download, tag: this.tagName }); return origA.call(this); };
    const origB = HTMLButtonElement.prototype.click;
    HTMLButtonElement.prototype.click = function () { window.__clk.push(String(this.textContent||'').trim()); return origB.call(this); };
    window.addEventListener('unhandledrejection', (e) => { window.__rej = (e.reason && e.reason.stack) || String(e.reason); });
    const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent === 'PNG');
    if (b) b.click(); else window.__clk.push('NO PNG BUTTON');
  })()`);
  await sleep(2500);
  console.log('  info: button clicks =', JSON.stringify(await evalJS(`window.__clk`)).slice(0, 300));
  console.log('  info: anchor clicks =', JSON.stringify(await evalJS(`window.__dl`)).slice(0, 400));
  console.log('  info: unhandled rejection =', String(await evalJS(`window.__rej`)).slice(0, 500));
  console.log('  info: download events after PNG click =', JSON.stringify(downloads));
  const toasts = await evalJS(`[...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | ')`);
  console.log('  info: toasts =', toasts.slice(0, 300));
  const pngFiles = await waitDownloads(1);
  check('PNG download produced a file', pngFiles.length > 0, pngFiles);
  const pngPath = pngFiles.length ? path.join(DL_DIR, pngFiles[0]) : null;
  const pngOk = pngPath ? fs.readFileSync(pngPath).subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && fs.statSync(pngPath).size > 1000 : false;
  check('PNG file is a valid non-empty PNG', pngOk, pngPath ? 'size=' + fs.statSync(pngPath).size : 'no file');

  // ---- download JPG ----
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal button')].find(x => x.textContent === 'JPG'); if (b) b.click(); })()`);
  const jpgFiles = await waitDownloads(2);
  const jpgName = jpgFiles.length > 1 ? jpgFiles.find((f) => /\.jpg$/i.test(f)) : (jpgFiles[0] || '');
  check('JPG download produced a file', jpgFiles.length > 1, jpgFiles.join(','));
  const jpgPath = jpgName ? path.join(DL_DIR, jpgName) : null;
  const jpgOk = jpgPath ? fs.readFileSync(jpgPath).subarray(0, 3).toString('hex') === 'ffd8ff' && fs.statSync(jpgPath).size > 1000 : false;
  check('JPG file is a valid non-empty JPG', jpgOk, jpgPath ? 'size=' + (jpgPath ? fs.statSync(jpgPath).size : 0) : 'no file');
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal-foot button')].find(x => x.textContent === 'Close'); b && b.click(); })()`);

  await drainErrors();
  const distinct = [...new Set(pageErrors)];
  check('no uncaught page errors', distinct.length === 0, distinct);

  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('PROBE CRASHED:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 5).join('\n'));
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}