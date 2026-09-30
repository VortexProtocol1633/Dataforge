/* Temporary verification for the 9 requested changes:
 * themes, logo, sorting, share-page passport, docx image embed, import limit.
 * node scripts/verify-new.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PUBLIC = path.resolve('public');
const UI = 'http://127.0.0.1:5599/';
const DEBUG_PORT = 9345;

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
await new Promise((res) => staticSrv.listen(5599, '127.0.0.1', res));

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), 'df-new-'))}`,
  '--window-size=1440,900', 'about:blank',
], { stdio: 'ignore' });

let pass = 0, fail = 0;
const pageErrors = [];
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
const click = (expr) => evalJS(`(() => { const b = ${expr}; if (!b) return 'MISSING'; b.click(); return 'ok'; })()`);

try {
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: UI + '#/login' });
  await waitFor(`!!document.querySelector('#df-login-btn')`);

  // ---------- seed: a sortable table + an image table ----------
  const ids = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = await m.localApi.create({
      name: 'Sort Test', description: '',
      columns: [
        { name: 'Name', type: 'text', options: {} },
        { name: 'Qty', type: 'number', subtype: 'decimal', options: {} },
        { name: 'Rating', type: 'fraction', options: {} },
        { name: 'Total', type: 'formula', options: { formula: 'ROUND([Qty] * 2, 1)' } },
        { name: 'Photo', type: 'image', options: {} },
      ],
      rows: [],
    });
    const c = (n) => t.columns.find((x) => x.name === n).id;
    for (const [name, qty, frac] of [['beta', 3, '1/2'], ['alpha', 10, '2/3'], ['gamma', 1, '1/3']]) {
      await m.localApi.addRow(t.id, { [c('Name')]: name, [c('Qty')]: qty, [c('Rating')]: frac });
    }
    // image table with one real 1x1 png
    const img = await m.localApi.create({
      name: 'Share Img', description: '',
      columns: [
        { name: 'Photo', type: 'image', options: {} },
        { name: 'Name', type: 'text', options: {} },
      ],
      rows: [],
    });
    const ic = (n) => img.columns.find((x) => x.name === n).id;
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const file = await m.localApi.saveFile(img.id, { filename: 'pixel.png', data: PNG, mime: 'image/png' });
    await m.localApi.addRow(img.id, { [ic('Photo')]: file, [ic('Name')]: 'first' });
    return { sort: t.id, img: img.id };
  })()`);

  await evalJS(`(() => { document.querySelector('#df-user').value = 'admin'; document.querySelector('#df-pass').value = 'admin123'; document.querySelector('#df-login-btn').click(); })()`);
  await waitFor(`location.hash === '#/' && !!document.querySelector('.page-head h1')`);

  /* ============ 1. themes ============ */
  await click(`document.querySelector('.topbar .theme-btn')`);
  await waitFor(`!!document.querySelector('.themepick')`);
  check('theme picker lists 9 themes', await evalJS(`document.querySelectorAll('.theme-opt').length === 9`));
  const themeNames = await evalJS(`[...document.querySelectorAll('.theme-opt .nm')].map(x => x.textContent)`);
  check('new themes present', ['Stealth Matte Charcoal', 'Prism Pastel', 'Arcade Odyssey'].every((n) => themeNames.includes(n)), themeNames);
  await click(`[...document.querySelectorAll('.theme-opt')].find(x => x.querySelector('.nm').textContent === 'Stealth Matte Charcoal')`);
  check('stealth theme applies + persists', await waitFor(`document.documentElement.getAttribute('data-theme') === 'stealth' && localStorage.getItem('df_theme') === 'stealth'`));
  await click(`document.querySelector('.topbar .theme-btn')`);
  await waitFor(`!!document.querySelector('.themepick')`);
  await click(`[...document.querySelectorAll('.theme-opt')].find(x => x.querySelector('.nm').textContent === 'Prism Pastel')`);
  check('prism theme applies', await waitFor(`document.documentElement.getAttribute('data-theme') === 'prism'`));
  await click(`document.querySelector('.topbar .theme-btn')`);
  await waitFor(`!!document.querySelector('.themepick')`);
  await click(`[...document.querySelectorAll('.theme-opt')].find(x => x.querySelector('.nm').textContent === 'Arcade Odyssey')`);
  check('arcade theme applies', await waitFor(`document.documentElement.getAttribute('data-theme') === 'arcade'`));
  await click(`document.querySelector('.topbar .theme-btn')`);
  await waitFor(`!!document.querySelector('.themepick')`);
  await click(`[...document.querySelectorAll('.theme-opt')].find(x => x.querySelector('.nm').textContent === 'Midnight Indigo')`);
  await waitFor(`document.documentElement.getAttribute('data-theme') === 'dark'`);

  /* ============ 2. logo: inline, theme-aware svg ============ */
  check('topbar brand uses inline theme-aware svg', await evalJS(`(() => {
    const svg = document.querySelector('.brand > svg');
    if (!svg) return false;
    const stops = [...svg.querySelectorAll('stop')];
    return stops.length >= 3 && stops.every((s) => (s.getAttribute('style') || '').includes('var(--'));
  })()`));

  /* ============ 3. column sorting ============ */
  await evalJS(`location.hash = '#/t/${ids.sort}'`);
  await waitFor(`location.hash === '#/t/${ids.sort}' && document.querySelectorAll('table.df tbody tr').length === 3`);
  // td: 0=check,1=#,2=Name,3=Qty,4=Rating,5=Total,6=Photo,7=menu
  const cellExpr = (ri, ci) => `document.querySelectorAll('table.df tbody tr')[${ri}].querySelectorAll('td')[${ci}].textContent.trim()`;
  // Qty ascending
  await click(`[...document.querySelectorAll('table.df thead th')][3].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Sort ascending'))`);
  check('number column sorts ascending (Qty 1 first)', await waitFor(`${cellExpr(0, 3)} === '1'`));
  check('ascending first row is gamma', await evalJS(`${cellExpr(0, 2)} === 'gamma'`));
  check('sort indicator arrow shown', await evalJS(`!!document.querySelector('table.df thead th .sortind') && document.querySelector('table.df thead th .sortind').textContent === '↑'`));
  // Qty descending
  await click(`[...document.querySelectorAll('table.df thead th')][3].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Sort descending'))`);
  check('number column sorts descending (Qty 10 first)', await waitFor(`${cellExpr(0, 3)} === '10'`));
  check('sort indicator flips to ↓', await evalJS(`document.querySelector('table.df thead th .sortind').textContent === '↓'`));
  // text A->Z
  await click(`[...document.querySelectorAll('table.df thead th')][2].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Sort ascending'))`);
  check('text column sorts A→Z (alpha first)', await waitFor(`${cellExpr(0, 2)} === 'alpha'`));
  // formula column sorts numerically
  await click(`[...document.querySelectorAll('table.df thead th')][5].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Sort descending'))`);
  check('formula column sorts descending (Total 20 first)', await waitFor(`${cellExpr(0, 5)} === '20'`));
  // image column has NO sort option
  await click(`[...document.querySelectorAll('table.df thead th')][6].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  check('image column offers no sort option', await evalJS(`![...document.querySelectorAll('.menu button')].some(b => b.textContent.includes('Sort'))`));
  await evalJS(`document.querySelector('.menu').remove(); document.querySelectorAll('.overlay').forEach(o => o.remove());`);
  // clear sort
  await click(`[...document.querySelectorAll('table.df thead th')][5].querySelector('.colmenu')`);
  await waitFor(`!!document.querySelector('.menu')`);
  await click(`[...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Clear sort'))`);
  check('clear sort restores original order', await waitFor(`${cellExpr(0, 2)} === 'beta'`));

  /* ============ 4. share page matches form view (passport images) ============ */
  const token = await evalJS(`(async () => { const m = await import('/js/localstore.js'); return (await m.localApi.shareRow('${ids.img}', (await m.localApi.get('${ids.img}')).rows[0].id)).token; })()`);
  await evalJS(`location.hash = '#/share/' + ${JSON.stringify(token)}`);
  await waitFor(`!!document.querySelector('.share-page .rowform')`);
  check('share page shows passport photo frame', await evalJS(`!!document.querySelector('.share-page .pp-frame img')`));
  check('share page hides image column from the fields grid', await evalJS(`document.querySelectorAll('.share-page .rowform .fitem:not(.passport)').length === 1`));
  check('share page shows the non-image field with its label', await evalJS(`[...document.querySelectorAll('.share-page .fitem:not(.passport) label')].some(l => l.textContent.includes('Name'))`));

  /* ============ 5. browser docx export embeds the image ============ */
  const docxInfo = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const { blob } = await m.localApi.exportData('${ids.img}', 'docx');
    const buf = new Uint8Array(await blob.arrayBuffer());
    let text = '';
    for (let i = 0; i < buf.length; i += 50000) text += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + 50000, buf.length)));
    return {
      media: text.includes('word/media/image1.png'),
      drawing: text.includes('r:embed='),
      pic: text.includes('<pic:pic>'),
      rels: text.includes('word/_rels/document.xml.rels'),
      contentTypes: text.includes('image/png'),
    };
  })()`);
  check('browser docx contains embedded media part', docxInfo.media, docxInfo);
  check('browser docx drawing references the image', docxInfo.drawing && docxInfo.pic, docxInfo);
  check('browser docx adds media rels + content types', docxInfo.rels && docxInfo.contentTypes, docxInfo);

  /* ============ 6. import limit ============ */
  check('browser import rejects >10000 rows with the new message', await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const NL = String.fromCharCode(10);
    const csv = 'a,b' + NL + Array.from({ length: 10001 }, (_, i) => 'x' + i + ',' + i).join(NL);
    try { await m.localApi.importParse('big.csv', btoa(csv)); return 'no-throw'; }
    catch (e) { return String(e.message || e); }
  })()`).then((v) => v.includes('10000')));
  check('browser import accepts the user\'s 8807-row file', await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const NL = String.fromCharCode(10);
    const csv = 'a,b' + NL + Array.from({ length: 8807 }, (_, i) => 'x' + i + ',' + i).join(NL);
    try { const job = await m.localApi.importParse('user.csv', btoa(csv)); return job && job.totalRows === 8807; }
    catch (e) { return String(e.message || e); }
  })()`));
  const io = require('../server/io.js');
  check('server import limit raised to 10000', io.MAX_IMPORT_ROWS === 10000, io.MAX_IMPORT_ROWS);

  /* ============ 7. archiving never deletes + formula header icon ============ */
  const archId = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = await m.localApi.create({ name: 'Archive Me', columns: [{ name: 'N', type: 'number', options: {} }, { name: 'Fx', type: 'formula', options: { formula: '1+1' } }], rows: [] });
    return t.id;
  })()`);
  await evalJS(`location.hash = '#/t/${archId}'`);
  await waitFor(`location.hash === '#/t/${archId}' && !!document.querySelector('.tw-head')`);
  check('formula column header shows the fx icon', await evalJS(`(() => {
    const th = [...document.querySelectorAll('table.df thead th')].find(t => t.textContent.includes('Fx'));
    return !!th && [...th.querySelectorAll('svg text')].some(t => t.getAttribute('fill') === 'currentColor');
  })()`));
  await evalJS(`(() => { [...document.querySelectorAll('.tw-head .btn')].find(b => b.title === 'Archive').click(); })()`);
  check('archiving lands on the dashboard Archived tab', await waitFor(`location.hash.includes('archived=1') && !!document.querySelector('.seg')`));
  check('archived table is listed on the Archived tab (not deleted)', await waitFor(`[...document.querySelectorAll('.tcard h3')].some(h => h.textContent === 'Archive Me')`));
  check('archived flag persisted (archived=true in storage)', await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = (await m.localApi.list({ includeArchived: true })).find(x => x.name === 'Archive Me');
    return !!(t && t.archived === true);
  })()`));
  await evalJS(`(() => { const c = [...document.querySelectorAll('.tcard')].find(x => x.querySelector('h3').textContent === 'Archive Me'); c.querySelector('.actions .icon-btn').click(); })()`);
  await waitFor(`!!document.querySelector('.menu')`);
  await evalJS(`(() => { [...document.querySelectorAll('.menu button')].find(b => b.textContent.includes('Unarchive')).click(); })()`);
  await new Promise((r) => setTimeout(r, 400));
  check('unarchive flips the flag back to false', await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = (await m.localApi.list({ includeArchived: true })).find(x => x.name === 'Archive Me');
    return !!(t && t.archived === false);
  })()`));

  /* ============ 8. per-chart zoom inside the figure box ============ */
  const zoomTid = await evalJS(`(async () => {
    const m = await import('/js/localstore.js');
    const t = await m.localApi.create({
      name: 'Zoom Data', columns: [{ name: 'Day', type: 'text', options: {} }, { name: 'Units', type: 'number', options: {} }], rows: [],
    });
    const c = (n) => t.columns.find((x) => x.name === n).id;
    for (let i = 1; i <= 15; i++) await m.localApi.addRow(t.id, { [c('Day')]: 'day ' + i, [c('Units')]: i % 7 });
    return t.id;
  })()`);
  await evalJS(`location.hash = '#/t/${zoomTid}'`);
  await waitFor(`location.hash === '#/t/${zoomTid}' && !!document.querySelector('.toolbar')`);
  await evalJS(`(() => { [...document.querySelectorAll('.toolbar button')].find(b => b.textContent.includes('Chart')).click(); })()`);
  await waitFor(`!!document.querySelector('.modal canvas')`);
  check('zoom controls appear for cartesian charts', await waitFor(`!!document.querySelector('.chart-zoom')`));
  const zoomed = await evalJS(`(async () => {
    const c = window.Chart.getChart(document.querySelector('.modal canvas'));
    const fullSpan = c.scales.x.max - c.scales.x.min;
    document.querySelector('.chart-zoom button[aria-label="Zoom in the chart"]').click();
    await new Promise(r => setTimeout(r, 150));
    const o = c.options.scales.x;
    const narrowed = (c.scales.x.max - c.scales.x.min) < fullSpan - 0.5;
    return { min: o.min, max: o.max, narrowed };
  })()`);
  check('zoom in sets a narrower axis window', typeof zoomed.min === 'number' && typeof zoomed.max === 'number' && zoomed.min > -0.1 && zoomed.narrowed, zoomed);
  const zoomedOut = await evalJS(`(async () => {
    const c = window.Chart.getChart(document.querySelector('.modal canvas'));
    const zoomedSpan = c.scales.x.max - c.scales.x.min;
    document.querySelector('.chart-zoom button[aria-label="Zoom out the chart"]').click();
    await new Promise(r => setTimeout(r, 150));
    return (c.scales.x.max - c.scales.x.min) > zoomedSpan;
  })()`);
  check('zoom out widens the window again', zoomedOut);
  check('zoom reset restores the full window', await evalJS(`(async () => {
    const c = window.Chart.getChart(document.querySelector('.modal canvas'));
    document.querySelector('.chart-zoom button[aria-label="Reset chart zoom"]').click();
    await new Promise(r => setTimeout(r, 150));
    return !c.options.scales.x.min && !c.options.scales.x.max;
  })()`));
  await evalJS(`(() => { [...document.querySelectorAll('.modal button')].find(b => b.textContent === 'Close').click(); })()`);
  await waitFor(`!document.querySelector('.modal')`);

  check('no uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)]);
  console.log(`\n${pass} passed, ${fail} failed`);
} catch (e) {
  console.log('CRASHED:', e.message);
  console.log((e.stack || '').split('\n').slice(0, 3).join('\n'));
  fail++;
} finally {
  try { await send('Browser.close'); } catch { /* ignore */ }
  chrome.kill();
  staticSrv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}