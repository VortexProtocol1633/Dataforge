/*
 * Regression check for UI fixes:
 *   - modal close buttons render a real X icon instead of raw SVG source text
 *   - the import modal's upload icon renders as an icon, not a text blob
 *   - confirmDialog() resolves TRUE when the confirm button is clicked, so
 *     deleting tables actually happens (previously every confirmation
 *     resolved false because closing the modal fired onClose first)
 *
 *   node scripts/verify-ui.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5597/';
const DEBUG_PORT = 9339;

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

await new Promise((res) => staticSrv.listen(5597, '127.0.0.1', res));
console.log(`static server on ${UI}`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-ui-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const pageErrors = [];
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 300) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (expr) => evalJS(`(() => { const b = ${expr}; if (!b) return 'MISSING'; b.click(); return 'ok'; })()`);

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

// Whole-DOM leak scan: raw '<svg' text nodes (printed markup) and SVG strings
// inside title attributes (broken native tooltips).
const LEAK_SCAN = `(() => {
  const hits = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (/<svg/i.test(n.textContent)) hits.push('text:' + n.textContent.trim().slice(0, 40));
  }
  for (const el of document.querySelectorAll('[title]')) {
    const t = el.getAttribute('title') || '';
    if (/<svg/i.test(t)) hits.push('title:' + t.slice(0, 40));
  }
  return hits;
})()`;
async function checkNoLeak(label) {
  const hits = await evalJS(LEAK_SCAN);
  check('no raw-SVG leak: ' + label, Array.isArray(hits) && hits.length === 0, hits);
}

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: UI + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);
  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`);

  // ---- 0. whole-DOM leak scan on the dashboard (top bar, cards, charts tab) ----
  await checkNoLeak('dashboard + top bar');

  // ---- 1. create-table modal: close button must render an SVG icon ----
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New table')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  check('create-table modal close button has a real svg', await evalJS(`!!document.querySelector('.modal .icon-btn svg')`));
  await checkNoLeak('create-table modal');
  await evalJS(`(() => { [...document.querySelectorAll('.modal input[type=text]')][0].value = 'UI Test Table'; [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Create table')).click(); })()`);
  await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`);

  // ---- Help panel ----
  await click(`[...document.querySelectorAll('.topbar button')].find(b => b.textContent.includes('Help'))`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent === 'Help')`);
  check('help modal opens with topic list + content', await evalJS(`document.querySelectorAll('.help-topic-btn').length >= 10 && !!document.querySelector('.help-pane h3')`));
  check('help opens on the topic matching the current view (table workspace)', await evalJS(`(document.querySelector('.help-topic-btn.active span') || {}).textContent === 'Work with a table'`));
  await checkNoLeak('help modal');
  await evalJS(`(() => { const i = document.querySelector('.help-side input'); i.value = 'chart'; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  check('help search narrows topics', await evalJS(`document.querySelectorAll('.help-topic-btn').length < 10 && [...document.querySelectorAll('.help-topic-btn span')].some(s => s.textContent.toLowerCase().includes('chart'))`));
  await evalJS(`(() => { const i = document.querySelector('.help-side input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); [...document.querySelectorAll('.help-topic-btn')].find(b => b.textContent.includes('Upload files')).click(); })()`);
  check('clicking a topic shows its steps', await waitFor(`document.querySelector('.help-pane h3').textContent.includes('Upload files') && document.querySelectorAll('.help-steps li').length > 0`));
  await click(`[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close')`);
  await waitFor(`!document.querySelector('.modal')`);

  // add a column + a row so the table has real content
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Column')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal h3') && document.querySelector('.modal h3').textContent.includes('Add a column')`);
  check('add-column modal close button renders svg', await evalJS(`!!document.querySelector('.modal .icon-btn svg')`));
  await evalJS(`(() => {
    const i = document.querySelector('.colcfg input[type=text]');
    i.value = 'Amount'; i.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Add column').click();
  })()`);
  await waitFor(`!!document.querySelector('table.df thead') && !document.querySelector('.modal')`);
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Add row')).click(); })()`);
  await waitFor(`document.querySelectorAll('table.df tbody tr').length >= 1`);

  // ---- 2. import modal: upload icon must be an icon, modal has no raw text ----
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.title && b.title.includes('Import')).click(); })()`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Import'))`);
  check('import modal shows an svg upload icon (not text)', await evalJS(`!!document.querySelector('.modal .glass svg')`));
  await checkNoLeak('import modal');
  await evalJS(`(() => { [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent === 'Close').click(); })()`);
  await waitFor(`!document.querySelector('.modal')`);

  // ---- 3. delete the table from the table view (confirm must resolve true) ----
  await evalJS(`(() => { [...document.querySelectorAll('.tw-head .btn')].find(b => b.title === 'Delete table').click(); })()`);
  await waitFor(`[...document.querySelectorAll('.modal h3')].some(h => h.textContent.includes('Delete'))`);
  check('delete confirm close button renders svg', await evalJS(`!!document.querySelector('.modal .icon-btn svg')`));
  await checkNoLeak('delete confirm');
  await evalJS(`(() => { [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Delete table')).click(); })()`);
  check('confirming delete leaves the table view', await waitFor(`location.hash === '#/' && (!!document.querySelector('.cardgrid') || !!document.querySelector('.empty')) && [...document.querySelectorAll('.tcard h3')].every(h => h.textContent !== 'UI Test Table')`));
  check('table actually gone from IndexedDB', await evalJS(`(async () => { const m = await import('/js/localstore.js'); const list = await m.localApi.list({ includeArchived: true }); return !list.some(t => t.name === 'UI Test Table'); })()`));

  // ---- 4. dashboard card-menu delete also works (same confirmDialog) ----
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New table')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  await evalJS(`(() => { [...document.querySelectorAll('.modal input[type=text]')][0].value = 'Card Delete Test'; [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Create table')).click(); })()`);
  await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`);
  await evalJS(`location.hash = '#/'`);
  await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Card Delete Test')`);
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Card Delete Test'); c.querySelector('.actions .icon-btn').click(); })()`);
  await waitFor(`!!document.querySelector('.menu')`);
  await evalJS(`(() => { [...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Delete table')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  await evalJS(`(() => { [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Delete').click(); })()`);
  check('card-menu delete removes the table', await waitFor(`[...document.querySelectorAll('.tcard h3')].every(h => h.textContent !== 'Card Delete Test')`));

  // ---- 5. cancel must still resolve false (no accidental deletes) ----
  await evalJS(`(() => { [...document.querySelectorAll('.page-head button')].find(b => b.textContent.includes('New table')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  await evalJS(`(() => { [...document.querySelectorAll('.modal input[type=text]')][0].value = 'Keep Me'; [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Create table')).click(); })()`);
  await waitFor(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`);
  await evalJS(`(() => { [...document.querySelectorAll('.tw-head .btn')].find(b => b.title === 'Delete table').click(); })()`);
  await waitFor(`!!document.querySelector('.modal')`);
  await evalJS(`(() => { [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Cancel').click(); })()`);
  await sleep(400);
  check('cancelling keeps the table', await evalJS(`location.hash.startsWith('#/t/') && !!document.querySelector('.toolbar')`));
  await checkNoLeak('table view after cancel');

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