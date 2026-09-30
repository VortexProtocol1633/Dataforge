'use strict';
/**
 * DataForge server entry point.
 *
 *   npm start          -> http://localhost:3210
 *
 * Static front-end lives in /public (vanilla HTML/CSS/JS); vendored
 * Chart.js, SheetJS and pdf.js are served from /public/vendor so the app
 * keeps working without internet access.
 */
const fs = require('fs');
const path = require('path');
const fsp = require('fs/promises');
const { spawn } = require('child_process');
const express = require('express');
const { loginRoutes, requireAuth } = require('./auth');
const { store, chartStore, HttpError, TYPES } = require('./store');
const io = require('./io');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const FILES_DIR = path.join(ROOT, 'data', 'files');
const SAVES_TABLES = path.join(ROOT, 'Saves', 'Tables');
const SAVES_CHARTS = path.join(ROOT, 'Saves', 'Charts');

const PORT = process.env.PORT || 3210;
const app = express();

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

/* ------------------------------------------------------------------
 * CORS for local dev servers (VS Code “Live Server”, http-server, …):
 * the same front-end can be opened from another localhost port while the
 * REST API keeps running here. Localhost origins are allowed by default
 * (any port) so Live Server keeps working; for a real deployment set
 * DF_CORS_ORIGINS to an explicit comma-separated allowlist and only
 * those origins are accepted.
 * ------------------------------------------------------------------ */
const CORS_ALLOWLIST = (process.env.DF_CORS_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

function originAllowed(origin) {
  if (!origin) return false;
  if (CORS_ALLOWLIST.length) return CORS_ALLOWLIST.includes(origin);
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch (e) { return false; } // malformed / null origin (file://) → not allowed
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ----- static assets ----- */
// uploaded images / attachments for image & file columns
app.use('/uploads', express.static(FILES_DIR));
// main front-end
app.use(express.static(PUBLIC_DIR));

loginRoutes(app);

/* ================================================================== */
/* Tables API                                                         */
/* ================================================================== */

const tables = express.Router();

tables.get('/', async (req, res, next) => {
  try {
    const includeArchived = req.query.includeArchived === '1';
    const search = String(req.query.search || '').toLowerCase().trim();
    const kind = req.query.kind; // 'table' | 'linked'
    let list = await store.list(req.session.username, { includeArchived });
    if (search) {
      list = list.filter((t) =>
        (t.name || '').toLowerCase().includes(search) ||
        (t.description || '').toLowerCase().includes(search));
    }
    if (kind) list = list.filter((t) => t.kind === kind);
    res.json({ tables: list });
  } catch (e) { next(e); }
});

// POST /api/tables { name, description, columns?, rows? } — also used by importer
tables.post('/', async (req, res, next) => {
  try {
    const table = await store.create(req.session.username, req.body || {});
    res.status(201).json({ table });
  } catch (e) { next(e); }
});

// POST /api/tables/extract { sourceTableId, mode, rowIds, columnIds, name, description }
tables.post('/extract', async (req, res, next) => {
  try {
    const t = await store.extract(req.session.username, req.body || {});
    res.status(201).json({ table: t });
  } catch (e) { next(e); }
});

tables.get('/:id', async (req, res, next) => {
  try {
    const table = await store.get(req.session.username, req.params.id);
    res.json({ table });
  } catch (e) { next(e); }
});

tables.patch('/:id', async (req, res, next) => {
  try {
    const table = await store.updateMeta(req.session.username, req.params.id, req.body || {});
    res.json({ table });
  } catch (e) { next(e); }
});

tables.post('/:id/duplicate', async (req, res, next) => {
  try {
    const table = await store.duplicate(req.session.username, req.params.id);
    res.status(201).json({ table });
  } catch (e) { next(e); }
});

tables.post('/:id/archive', async (req, res, next) => {
  try {
    res.json(await store.setArchived(req.session.username, req.params.id, true));
  } catch (e) { next(e); }
});
tables.post('/:id/unarchive', async (req, res, next) => {
  try {
    res.json(await store.setArchived(req.session.username, req.params.id, false));
  } catch (e) { next(e); }
});
tables.delete('/:id', async (req, res, next) => {
  try {
    res.json(await store.remove(req.session.username, req.params.id));
  } catch (e) { next(e); }
});

tables.post('/:id/detach', async (req, res, next) => {
  try {
    const table = await store.detach(req.session.username, req.params.id);
    res.json({ table });
  } catch (e) { next(e); }
});

/* --- summaries --- */
tables.put('/:id/summaries', async (req, res, next) => {
  try {
    res.json(await store.summaries(req.session.username, req.params.id, req.body.summaries));
  } catch (e) { next(e); }
});

/* --- columns --- */
tables.post('/:id/columns', async (req, res, next) => {
  try {
    const col = await store.addColumn(req.session.username, req.params.id, req.body || {});
    res.status(201).json({ column: col });
  } catch (e) { next(e); }
});
tables.patch('/:id/columns/:colId', async (req, res, next) => {
  try {
    const col = await store.updateColumn(req.session.username, req.params.id, req.params.colId, req.body || {});
    res.json({ column: col });
  } catch (e) { next(e); }
});
tables.delete('/:id/columns/:colId', async (req, res, next) => {
  try {
    res.json(await store.removeColumn(req.session.username, req.params.id, req.params.colId));
  } catch (e) { next(e); }
});
tables.post('/:id/columns/reorder', async (req, res, next) => {
  try {
    res.json(await store.reorderColumns(req.session.username, req.params.id, req.body.orderedIds || []));
  } catch (e) { next(e); }
});

/* --- rows --- */
tables.post('/:id/rows', async (req, res, next) => {
  try {
    const row = await store.addRow(req.params.id, req.body.values || {}, { owner: req.session.username });
    res.status(201).json({ row });
  } catch (e) { next(e); }
});
tables.patch('/:id/rows/:rowId', async (req, res, next) => {
  try {
    const row = await store.updateRow(req.session.username, req.params.id, req.params.rowId, req.body.values || {});
    res.json({ row });
  } catch (e) { next(e); }
});
tables.delete('/:id/rows', async (req, res, next) => {
  try {
    res.json(await store.removeRows(req.session.username, req.params.id, req.body.rowIds || []));
  } catch (e) { next(e); }
});

/* --- row share --- */
tables.post('/:id/rows/:rowId/share', async (req, res, next) => {
  try {
    const table = await store.get(req.session.username, req.params.id);
    const row = (table.rows || []).find((r) => r.id === req.params.rowId);
    if (!row) throw new HttpError(404, 'Row not found');
    res.json(await io.createShare(req.session.username, table, row));
  } catch (e) { next(e); }
});

/* --- reveal a table's backend file in the OS file manager --- */
tables.post('/:id/open-location', async (req, res, next) => {
  try {
    // existence + ownership check (linked views store their own spec file)
    await store.get(req.session.username, req.params.id);
    const file = path.join(ROOT, 'data', 'tables', `${req.params.id}.json`);
    if (!fs.existsSync(file)) throw new HttpError(404, 'The table file does not exist on disk yet');
    // Open the OS file manager with the file selected (or reveal the folder).
    const platform = process.platform;
    if (platform === 'win32') {
      spawn('explorer', [`/select,${file}`], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'darwin') {
      spawn('open', ['-R', file], { detached: true, stdio: 'ignore' }).unref();
    } else if (platform === 'linux') {
      spawn('xdg-open', [path.dirname(file)], { detached: true, stdio: 'ignore' }).unref();
    } else {
      throw new HttpError(501, `Opening a file location is not supported on ${platform}`);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* --- files (image / attachment columns) --- */
tables.post('/:id/files', async (req, res, next) => {
  try {
    const file = await store.saveFile(req.session.username, req.params.id, req.body || {});
    res.status(201).json({ file });
  } catch (e) { next(e); }
});

/* --- export --- */
tables.get('/:id/export', async (req, res, next) => {
  try {
    const format = String(req.query.format || 'xlsx').toLowerCase();
    if (!['xlsx', 'csv', 'docx'].includes(format)) throw new HttpError(400, 'Unsupported format');
    const table = await store.get(req.session.username, req.params.id);
    const { file, filename, mime } = await io.exportTable(table, format);
    res.download(file, filename, { headers: { 'Content-Type': mime } });
  } catch (e) { next(e); }
});

/* ================================================================== */
/* Import API                                                         */
/* ================================================================== */

app.post('/api/import/parse', requireAuth, async (req, res, next) => {
  try {
    const { filename, data } = req.body || {};
    if (!filename || !data) throw new HttpError(400, 'filename and base64 data are required');
    const ext = path.extname(filename).toLowerCase();
    if (!['.xlsx', '.xls', '.csv', '.docx', '.pdf'].includes(ext)) {
      throw new HttpError(400, 'Supported formats: .xlsx, .xls, .csv, .docx and .pdf — see server/io.js for the parser guide');
    }
    const job = await io.createImportJob({ filename, data });
    res.json(job);
  } catch (e) { next(e); }
});

// POST /api/import/create { jobId, name, description, columns: [{index, name, type, subtype, options}] }
app.post('/api/import/create', requireAuth, async (req, res, next) => {
  try {
    const { jobId, name, description, columns } = req.body || {};
    if (!jobId || !Array.isArray(columns) || !columns.length) throw new HttpError(400, 'jobId and column mapping are required');
    const job = await io.loadImportJob(jobId);
    const byIndex = new Map(columns.map((c) => [c.index, c]));

    // 1. de-duplicate headers, honouring user renames + skips
    const defs = [];
    const taken = new Map();
    for (let i = 0; i < job.headers.length; i++) {
      const mapCol = byIndex.get(i);
      if (!mapCol || mapCol.skip === true) continue;
      const type = mapCol.type || 'text';
      const subtype = mapCol.subtype || (type === 'number' ? 'decimal' : type === 'text' ? 'single' : null);
      const base = (mapCol.name || job.headers[i] || `Column ${i + 1}`).trim();
      let colName = base;
      let n = 2;
      while (taken.has(colName.toLowerCase())) colName = `${base} (${n++})`;
      taken.set(colName.toLowerCase(), true);
      const options = { ...(mapCol.options || {}) };
      if (type === 'dropdown' && !options.list) {
        const seen = new Set();
        for (const rowArr of job.rows) {
          const v = rowArr[i];
          if (v !== null && v !== '' && v !== undefined) seen.add(String(v));
        }
        options.list = Array.from(seen).slice(0, 200);
      }
      defs.push({ index: i, def: { name: colName, type, subtype, options } });
    }
    if (!defs.length) throw new HttpError(400, 'Select at least one column to import');

    // 2. create the table shell, then map source column index -> stored column id
    const t = await store.create(req.session.username, { name, description, columns: defs.map((x) => x.def) });
    const colIdByIndex = new Map();
    defs.forEach((x, k) => colIdByIndex.set(x.index, t.columns[k].id));

    // 3. convert every cell and bulk-insert (invalid rows are skipped and counted)
    const payloads = [];
    for (const rowArr of job.rows) {
      const values = {};
      for (const { index, def } of defs) {
        const colId = colIdByIndex.get(index);
        const raw = rowArr[index];
        if (def.type === 'dropdown' && def.options.multi) {
          values[colId] = (raw === null || raw === '')
            ? null
            : String(raw).split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
        } else {
          values[colId] = io.convertImportCell(def.type, def.subtype, raw);
        }
      }
      payloads.push({ values });
    }
    const { added, skipped } = await store.bulkAdd(req.session.username, t.id, payloads);
    await fsp.rm(path.join(ROOT, 'data', 'tmp', `${jobId}.json`), { force: true });
    res.status(201).json({ table: await store.get(req.session.username, t.id), added, skipped });
  } catch (e) { next(e); }
});

/* ================================================================== */
/* Charts API                                                         */
/* ================================================================== */

const charts = express.Router();
charts.get('/', async (req, res, next) => {
  try { res.json({ charts: chartStore.list(req.session.username) }); } catch (e) { next(e); }
});
charts.post('/', async (req, res, next) => {
  try {
    const chart = chartStore.save(req.session.username, req.body || {});
    res.status(201).json({ chart });
  } catch (e) { next(e); }
});
charts.delete('/:id', async (req, res, next) => {
  try { res.json(chartStore.remove(req.session.username, req.params.id)); } catch (e) { next(e); }
});
// POST /api/charts/export { name, format: 'png'|'jpg', data: base64 }
charts.post('/export', async (req, res, next) => {
  try {
    res.json(await io.saveChartImage(req.body || {}));
  } catch (e) { next(e); }
});

/* ================================================================== */
/* Public share view (single read-only row, no auth)                  */
/* ================================================================== */
app.get('/api/share/:token', async (req, res, next) => {
  try {
    const rec = io.readShare(req.params.token);
    if (!rec) throw new HttpError(404, 'Share link not found or revoked');
    const table = await store.get(rec.owner, rec.tableId);
    const row = (table.rows || []).find((r) => r.id === rec.rowId);
    if (!row) throw new HttpError(404, 'The shared row no longer exists');
    res.json({
      token: rec.token,
      tableName: table.name,
      tableDescription: table.description || '',
      sharedAt: rec.createdAt,
      columns: table.columns,
      row,
    });
  } catch (e) { next(e); }
});

app.use('/api/tables', requireAuth, tables);
app.use('/api/charts', requireAuth, charts);

/* ================================================================== */
/* Misc                                                               */
/* ================================================================== */

app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// central error handler -> { error }
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

io.cleanupStaleJobs();
setInterval(io.cleanupStaleJobs, 30 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`DataForge running → http://localhost:${PORT}`);
  console.log(`  tables : data/tables/   uploads: data/files/   exports: Saves/Tables + Saves/Charts`);
  console.log(`  default login: admin / admin123`);
});
