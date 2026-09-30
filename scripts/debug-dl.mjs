/* Temporary debug: does an anchor download click fire Browser.downloadWillBegin? */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const APP = process.env.PROBE_URL || 'http://localhost:3210/';
const DEBUG_PORT = 9354;
const DL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-dl2-'));
const USER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'df-dl2u-'));

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
  } else events.push(msg.method);
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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: APP + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);

  // 1) plain anchor data-url download
  events.length = 0;
  await evalJS(`(() => {
    const a = document.createElement('a');
    a.href = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    a.download = 'plain.png';
    document.body.appendChild(a); a.click(); a.remove();
  })()`);
  await sleep(1500);
  let files = fs.readdirSync(DL_DIR);
  console.log('after plain anchor click: events=', JSON.stringify(events), 'files=', JSON.stringify(files));

  // 2) blob URL download (like exportTable uses)
  events.length = 0;
  await evalJS(`(async () => {
    const blob = new Blob(['hello download'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'blob.txt';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  })()`);
  await sleep(1500);
  files = fs.readdirSync(DL_DIR);
  console.log('after blob click: events=', JSON.stringify(events), 'files=', JSON.stringify(files));

  // 3) login + check anchor click with .download on an existing img? skip.
} catch (e) {
  console.log('CRASHED:', e.message);
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  try { fs.rmSync(USER_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(DL_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}