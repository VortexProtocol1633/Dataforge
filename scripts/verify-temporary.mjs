/*
 * Temporary-table lifecycle check (browser-only mode).
 *
 *   node scripts/verify-temporary.mjs
 *
 * Proves the contract the feature promises:
 *   1. a table imported as temporary is stored only in this tab;
 *   2. it survives a reload of that tab;
 *   3. opening a SECOND tab does not wipe the first tab's temporary tables —
 *      and the second tab keeps its own, separate workspace;
 *   4. once its owning tab is gone, it is swept away on the next visit
 *      (while normal tables and the demo data are left untouched).
 *
 * Step 4 is simulated by ageing the tab's heartbeat and dropping its
 * sessionStorage id, which is exactly what closing a tab does.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5601/';
const DEBUG_PORT = 9361;

if (!fs.existsSync(CHROME)) {
  console.log(`SKIP: Chrome not found at ${CHROME}`);
  process.exit(0);
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const staticSrv = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, p);
  if (req.method !== 'GET' || !file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((res) => staticSrv.listen(5601, '127.0.0.1', res));
console.log(`static host on ${UI} (browser mode, no backend)`);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-temp-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? ' :: ' + String(extra).slice(0, 300) : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json(); } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error('Chrome debug endpoint unavailable');
}

/** Minimal CDP client over one websocket (a page or the browser). */
function connect(ws) {
  const client = { ws, pageErrors: [], _id: 0, _pending: new Map() };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) {
      const p = client._pending.get(msg.id);
      if (p) { client._pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
    } else if (msg.method === 'Runtime.exceptionThrown') {
      client.pageErrors.push((msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text).split('\n')[0]);
    }
  };
  client.send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++client._id;
    client._pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  client.evalJS = async (expression) => {
    const r = await client.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('Page threw: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  };
  client.waitFor = async (expr, ms = 10000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      try { if (await client.evalJS(expr)) return true; } catch { /* not ready */ }
      await sleep(150);
    }
    return false;
  };
  return client;
}

async function wsOpen(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return ws;
}

const firstPage = (await listTargets()).find((t) => t.type === 'page');
const tabA = connect(await wsOpen(firstPage.webSocketDebuggerUrl));

async function reload(client) {
  await client.send('Page.reload', { ignoreCache: true });
  await client.waitFor(`!!document.getElementById('app')`, 10000);
  await sleep(400);
}

const CSV_B64 = Buffer.from('Name,Qty\nWidget,3\nGadget,5\n').toString('base64');
const tempList = `(async () => { const m = await import('/js/localstore.js'); return (await m.localApi.list({ includeArchived: true })).map(t => ({ name: t.name, ephemeral: !!t.ephemeral })); })()`;
const tabSession = `sessionStorage.getItem('df_tab_session')`;

let tabB = null;
let browser = null;
try {
  await tabA.send('Page.enable'); await tabA.send('Runtime.enable');
  await tabA.send('Page.navigate', { url: UI + '#/login' });
  check('login page renders', await tabA.waitFor(`!!document.querySelector('#df-login-btn')`));
  check('browser mode active', await tabA.evalJS(`window.DF_API_MODE === 'local'`), await tabA.evalJS(`window.DF_API_MODE`));
  await tabA.evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  check('login lands on dashboard', await tabA.waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`));

  // ---- create one temporary import and one ordinary (kept) table ----
  const made = await tabA.evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const job = await m.localApi.importParse('temp.csv', ${JSON.stringify(CSV_B64)});
    const res = await m.localApi.importCreate({
      jobId: job.jobId, name: 'Temp Import',
      columns: job.columns.map((c) => ({ index: c.index, name: c.name, type: c.suggestedType || 'text' })),
      ephemeral: true,
    });
    const keep = await m.localApi.create({ name: 'Keep Me' });
    return { tempId: res.table.id, added: res.added, sessionId: sessionStorage.getItem('df_tab_session') };
  })()`);
  check('temporary import created with rows', made && made.added === 2, made);

  let list = await tabA.evalJS(tempList);
  check('temporary table is flagged ephemeral', list.some((t) => t.name === 'Temp Import' && t.ephemeral === true), list);
  check('ordinary table is not ephemeral', list.some((t) => t.name === 'Keep Me' && !t.ephemeral), list);

  // ---- survives a reload of the same tab ----
  await reload(tabA);
  const afterReload = await tabA.evalJS(tempList);
  check('temporary table survives a reload', afterReload.some((t) => t.name === 'Temp Import'), afterReload);
  check('same tab session id after reload', (await tabA.evalJS(tabSession)) === made.sessionId);

  // ---- the dashboard banner summarises this tab's temporary tables ----
  check('dashboard shows a temporary-tables banner', await tabA.waitFor(`[...document.querySelectorAll('.linked-banner')].some(b => b.textContent.includes('temporary table'))`));
  const bannerText = await tabA.evalJS(`([...document.querySelectorAll('.linked-banner')].find(b => b.textContent.includes('temporary table')) || {}).textContent || ''`);
  check('banner names the count and row total', /1 temporary table/.test(bannerText) && /2 rows/.test(bannerText), bannerText);

  // ---- a SECOND tab must not disturb the first tab's workspace ----
  const version = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)).json();
  browser = connect(await wsOpen(version.webSocketDebuggerUrl));
  const { targetId } = await browser.send('Target.createTarget', { url: UI });
  let newTarget = null;
  for (let i = 0; i < 40 && !newTarget; i++) { newTarget = (await listTargets()).find((t) => t.id === targetId); if (!newTarget) await sleep(250); }
  if (!newTarget) throw new Error('second tab did not open');
  tabB = connect(await wsOpen(newTarget.webSocketDebuggerUrl));
  await tabB.send('Page.enable'); await tabB.send('Runtime.enable');
  check('second tab loads on the dashboard (shared login)', await tabB.waitFor(`!!document.querySelector('.page-head h1')`));

  const idB = await tabB.evalJS(tabSession);
  check('second tab has its own session id', !!idB && idB !== made.sessionId, { a: made.sessionId, b: idB });

  // tab B must not delete it: assert the record itself is still in IndexedDB
  const survivedInB = await tabB.evalJS(`(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('dataforce_local', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    return await new Promise((res, rej) => { const r = db.transaction('tables').objectStore('tables').get(${JSON.stringify(made.tempId)}); r.onsuccess = () => res(!!r.result); r.onerror = () => rej(r.error); });
  })()`);
  check('first tab\'s temporary table is NOT deleted by the second tab', survivedInB === true);
  const inB = await tabB.evalJS(tempList);
  check('second tab does not surface the first tab\'s temporary table', !inB.some((t) => t.name === 'Temp Import'), inB);
  const stillInA = await tabA.evalJS(tempList);
  check('first tab still sees its temporary table', stillInA.some((t) => t.name === 'Temp Import'), stillInA);

  // a temporary table created in tab B stays independent of tab A
  await tabB.evalJS(`(async () => { const m = await import('/js/localstore.js'); await m.localApi.create({ name: 'B Only', ephemeral: true }); return true; })()`);
  check('tab B creates its own temporary table', (await tabB.evalJS(tempList)).some((t) => t.name === 'B Only'));
  check('tab A does not see tab B\'s temporary table', !(await tabA.evalJS(tempList)).some((t) => t.name === 'B Only'));

  await browser.send('Target.closeTarget', { targetId });
  try { tabB.ws.close(); } catch { /* ignore */ }
  tabB = null;

  // ---- tab A goes away: age its heartbeat, drop its session id, reload ----
  await tabA.evalJS(`(async () => {
    const sid = sessionStorage.getItem('df_tab_session');
    const db = await new Promise((res, rej) => { const r = indexedDB.open('dataforce_local', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ k: 'sess:' + sid, v: 0 }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    sessionStorage.clear();
    return true;
  })()`);
  await reload(tabA);

  const afterClose = await tabA.evalJS(tempList);
  check('leftover temporary table is swept away', !afterClose.some((t) => t.name === 'Temp Import'), afterClose);
  check('ordinary table is kept', afterClose.some((t) => t.name === 'Keep Me'), afterClose);
  check('demo tables are kept', afterClose.some((t) => t.name === 'Inventory'), afterClose);
  check('a fresh tab session id was issued', (await tabA.evalJS(tabSession)) !== made.sessionId);

  // ---- one-click clear from the dashboard banner ----
  await tabA.evalJS(`(async () => { const m = await import('/js/localstore.js'); await m.localApi.create({ name: 'Clear Me', ephemeral: true }); return true; })()`);
  await reload(tabA);
  check('banner offers a one-click clear', await tabA.waitFor(`[...document.querySelectorAll('.linked-banner button')].some(b => b.textContent.includes('Clear all now'))`));
  await tabA.evalJS(`(() => { [...document.querySelectorAll('.linked-banner button')].find(b => b.textContent.includes('Clear all now')).click(); })()`);
  check('clear asks for confirmation first', await tabA.waitFor(`[...document.querySelectorAll('.modal button')].some(b => b.textContent.includes('Remove'))`));
  await tabA.evalJS(`(() => { [...document.querySelectorAll('.modal button')].find(b => b.textContent.includes('Remove')).click(); })()`);
  check('one-click clear removes the temporary tables', await tabA.waitFor(`[...document.querySelectorAll('.tcard h3')].every(h => h.textContent !== 'Clear Me') && !document.querySelector('.linked-banner')`));

  const errors = [...new Set([...tabA.pageErrors, ...(tabB ? tabB.pageErrors : [])])];
  check('no uncaught page errors', errors.length === 0, errors);

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  try { if (browser) await browser.send('Browser.close'); } catch { /* ignore */ }
  try { tabA.ws.close(); } catch { /* ignore */ }
  try { if (tabB) tabB.ws.close(); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  process.exit(fail === 0 ? 0 : 1);
}
