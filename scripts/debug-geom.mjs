/* Temporary debug: measure chart builder geometry in backend mode. */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.PROBE_URL || 'http://localhost:3210/';
const DEBUG_PORT = 9353;
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-geom-'));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${USER_DIR}`,
  '--window-size=1440,900', 'about:blank',
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
  await send('Page.navigate', { url: APP + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`);

  // open a table then the chart builder from toolbar (table pre-selected flow)
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Sales log'); c.click(); })()`);
  await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`);
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal canvas')`);
  await sleep(800);
  const g1 = await evalJS(`(() => {
    const canvas = document.querySelector('.modal canvas');
    const box = canvas && canvas.closest('.chart-canvasbox');
    const tools = canvas && canvas.closest('.chart-tools');
    const cols = canvas && canvas.closest('.builder-cols');
    const panel = canvas && canvas.closest('.modal');
    return {
      canvas: canvas ? canvas.offsetWidth + 'x' + canvas.offsetHeight : 'none',
      box: box ? box.offsetWidth + 'x' + box.offsetHeight : 'none',
      tools: tools ? tools.offsetWidth + 'x' + tools.offsetHeight : 'none',
      cols: cols ? cols.offsetWidth + 'x' + cols.offsetHeight : 'none',
      panel: panel ? panel.offsetWidth + 'x' + panel.offsetHeight : 'none',
      colsCS: cols ? getComputedStyle(cols).display + ' / ' + getComputedStyle(cols).gridTemplateColumns : 'none',
      canvasStyleW: canvas ? getComputedStyle(canvas).width : 'none',
    };
  })()`);
  console.log('geometry (toolbar flow):', JSON.stringify(g1, null, 1));

  // try export via data URL evaluation
  const exp = await evalJS(`(async () => {
    const canvas = document.querySelector('.modal canvas');
    const chart = window.Chart.getChart(canvas);
    if (chart) chart.resize();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const off = document.createElement('canvas');
    off.width = 800; off.height = 500;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 800, 500);
    ctx.drawImage(canvas, 0, 0, 800, 500);
    const png = off.toDataURL('image/png');
    const jpg = off.toDataURL('image/jpeg', 0.92);
    return {
      pngLen: png.length, pngHead: png.slice(0, 30),
      jpgLen: jpg.length, jpgHead: jpg.slice(0, 30),
      chartW: chart ? chart.width : 'no chart', chartH: chart ? chart.height : 'no chart',
      canvasAttr: canvas.width + 'x' + canvas.height,
    };
  })()`);
  console.log('export eval:', JSON.stringify(exp, null, 1));

  // measure the chart-mini card preview presence for reference
  await evalJS(`location.hash = '#/'`);
  await waitFor(`!!document.querySelector('.tcard')`);
  const preview = await evalJS(`[...document.querySelectorAll('.tcard')].slice(0,2).map(c => ({ name: c.querySelector('h3').textContent, canvas: !!c.querySelector('canvas'), cls: c.className }))`);
  console.log('cards:', JSON.stringify(preview));
} catch (e) {
  console.log('CRASHED:', e.message);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}