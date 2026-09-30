/* Temporary debug: open chart builder table-less, inspect select options, pick table, dump errors. */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.PROBE_URL || 'http://localhost:3210/';
const DEBUG_PORT = 9352;
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-debug-'));

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
  const out = [];
  while (events.length) {
    const ev = events.shift();
    if (ev.method === 'Runtime.exceptionThrown') out.push('EXC: ' + (ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text).split('\n')[0]);
    if (ev.method === 'Log.entryAdded' && ev.params.entry.level === 'error') out.push('LOG: ' + ev.params.entry.text.split('\n')[0]);
    if (ev.method === 'Runtime.consoleAPICalled' && ev.params.type === 'error') out.push('CONSOLE: ' + ev.params.args.map((x) => x.value || x.description || '').join(' ').split('\n')[0]);
  }
  return out;
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: APP + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.tcard')`);
  console.log('mode =', await evalJS(`window.DF_API_MODE`));

  await evalJS(`location.hash = '#/charts'`);
  await waitFor(`[...document.querySelectorAll('.page-head button')].some(b => b.textContent.includes('New chart'))`);
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New chart')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  await sleep(1200); // let loadTables complete
  const selects = await evalJS(`[...document.querySelectorAll('.modal select')].map((s, i) => ({ i, opts: [...s.options].map(o => o.textContent), len: s.options.length }))`);
  console.log('selects:', JSON.stringify(selects, null, 1));
  const html = await evalJS(`document.querySelector('.modal').innerHTML.slice(0, 600)`);
  console.log('modal html head:', html);

  // pick the table if present
  const picked = await evalJS(`(() => {
    const sel = document.querySelector('.modal select');
    if (!sel) return 'NO SELECT';
    const o = [...sel.options].find(x => x.textContent === 'Sales log');
    if (!o) return 'OPTION MISSING: ' + [...sel.options].map(x => x.textContent).join(',');
    sel.value = o.value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return 'PICKED ' + o.value;
  })()`);
  console.log('pick result:', picked);
  await sleep(1500);
  console.log('canvas count:', await evalJS(`document.querySelectorAll('.modal canvas').length`));
  console.log('body text head:', (await evalJS(`document.querySelector('.modal').textContent.slice(0, 300)`)));
  const errs = await drainErrors();
  console.log('errors:', errs.length ? errs.join('\n') : '(none)');
} catch (e) {
  console.log('CRASHED:', e.message);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}