/**
 * localstore.js — client-side data layer.
 *
 * When the Node backend is unreachable (e.g. the page is served only by a
 * static server such as VS Code's Live Server), the api facade falls back to
 * this module so the app keeps working fully standalone in the browser:
 *
 *   - users / auth        (single seeded admin account, demo-grade)
 *   - tables / columns / rows / summaries / linked views / files
 *   - saved chart configs
 *   - row share tokens
 *   - file imports (.xlsx/.xls/.csv/.docx/.pdf text layer) and exports
 *     (.xlsx/.csv/.docx), evaluated client-side with the shared formula engine
 *
 * Everything is persisted in IndexedDB. The table document shape and the
 * REST-response shapes mirror server/store.js + server/io.js so the UI code
 * is identical in both modes.
 */

import { uid } from './util.js';
import { coerceClient, validateClient } from './types.js';
import compute from './compute-shim.js';
import { DEMO_TABLES, DEMO_CHARTS } from './demo-data.mjs';

const OWNER = 'admin'; // single local owner

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                       */
/* ------------------------------------------------------------------ */

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
const nowISO = () => new Date().toISOString();
const newId = (prefix, len) => prefix + uid(len);
const clone = (x) => JSON.parse(JSON.stringify(x));

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, perms: u.perms || {}, createdAt: u.createdAt };
}

const TYPES = [
  'text', 'number', 'fraction', 'date', 'time', 'datetime', 'dropdown',
  'image', 'file', 'boolean', 'currency', 'formula',
];

/** Table-card colour palette (hex) + the icon set a user can pin to a table. */
const TABLE_COLORS = ['#6366f1', '#8b5cf6', '#2dd4bf', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#a855f7'];
const TABLE_ICONS = ['table', 'layers', 'grid', 'list', 'chart', 'file', 'image', 'calendar', 'clock', 'link', 'zap', 'dollar'];
const HEX_RE = /^#[0-9a-f]{6}$/i;
const pickColor = () => TABLE_COLORS[Math.floor(Math.random() * TABLE_COLORS.length)];

/** Build the starter chart config for a table the first time it holds data. */
function starterChartConfig(t) {
  if (!t || t.kind === 'linked' || !t.columns || !t.rows || t.rows.length === 0 || t.columns.length < 2) return null;
  const y = t.columns.find((c) => ['number', 'currency', 'formula'].includes(c.type));
  if (!y) return null;
  const x = t.columns.find((c) => c.id !== y.id && ['dropdown', 'text', 'date', 'time'].includes(c.type))
    || t.columns.find((c) => c.id !== y.id)
    || y;
  return {
    tableId: t.id,
    type: 'bar',
    xColumn: x.id,
    yColumns: [y.id],
    yColumn: y.id,
    aggregate: y.type === 'number' || y.type === 'currency' || y.type === 'formula' ? 'sum' : 'count',
    stacked: false,
    showLegend: true,
  };
}

/** Auto-save one starter chart per table (only when it has none yet). */
async function maybeStarterChart(db, t) {
  const cfg = starterChartConfig(t);
  if (!cfg) return;
  const charts = await dbGetAll(db, 'charts');
  if (charts.some((c) => c.config && c.config.tableId === t.id)) return;
  const now = nowISO();
  await dbPut(db, 'charts', {
    id: newId('ch', 9),
    owner: t.ownerId || OWNER,
    name: `${t.name} overview`.slice(0, 120),
    config: cfg,
    createdAt: now,
    updatedAt: now,
  });
}

/* ------------------------------------------------------------------ */
/* IndexedDB plumbing                                                 */
/* ------------------------------------------------------------------ */

const DB_NAME = 'dataforce_local';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const [name, key] of [['tables', 'id'], ['charts', 'id'], ['shares', 'token'], ['users', 'username'], ['files', 'url'], ['meta', 'k']]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key });
      }
    };
    req.onsuccess = () => {
      seedAdmin(req.result)
        .then(() => seedDemo(req.result))
        .then(() => resolve(req.result), reject);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
  return dbPromise;
}

function reqTo(res, rej) {
  return (e) => { if (e.target.error) rej(e.target.error); else res(e.target.result); };
}
const dbGet = (db, store, key) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).get(key); r.onsuccess = reqTo(res, rej); r.onerror = rej; });
const dbGetAll = (db, store) => new Promise((res, rej) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = reqTo(res, rej); r.onerror = rej; });
const dbPut = (db, store, val) => new Promise((res, rej) => { const r = db.transaction(store, 'readwrite').objectStore(store).put(val); r.onsuccess = reqTo(res, rej); r.onerror = rej; });
const dbDel = (db, store, key) => new Promise((res, rej) => { const r = db.transaction(store, 'readwrite').objectStore(store).delete(key); r.onsuccess = reqTo(res, rej); r.onerror = rej; });

async function seedAdmin(db) {
  const existing = await dbGet(db, 'users', 'admin').catch(() => null);
  if (!existing) {
    await dbPut(db, 'users', {
      id: 'user_local',
      username: 'admin',
      password: 'admin123',
      role: 'admin',
      perms: { tables: 'admin', charts: 'admin', users: 'admin' },
      createdAt: nowISO(),
    });
  }
}

const DEMO_FLAG = 'demo_seeded_v1';

/**
 * Seed the demo dataset (see ./demo-data.js) once, on a fresh database —
 * this is what makes the Live Server / standalone site open with sample
 * tables and charts ready to explore. Never re-seeds after the user has
 * added or removed tables; localApi.seedDemo() recreates it on demand.
 *
 * IMPORTANT: this runs inside openDB()'s resolution chain, so it must only
 * touch the `db` handle it is given — calling localApi.* here (or anything
 * that awaits openDB()) would deadlock on the still-pending promise.
 */
async function seedDemo(db) {
  const flag = await dbGet(db, 'meta', DEMO_FLAG).catch(() => null);
  if (flag) return { seeded: false };
  const existing = await dbGetAll(db, 'tables');
  if (existing.length) {
    // A database that already has tables is not a first run — never retry.
    await dbPut(db, 'meta', { k: DEMO_FLAG, v: 1 });
    return { seeded: false };
  }
  const ids = {};
  const DEMO_TABLE_COLORS = ['#6366f1', '#2dd4bf'];
  let demoColorIdx = 0;
  for (const def of DEMO_TABLES) {
    const t = {
      id: newId('tbl', 10),
      ownerId: OWNER,
      name: def.name,
      description: def.description || '',
      kind: 'table',
      color: DEMO_TABLE_COLORS[demoColorIdx++ % DEMO_TABLE_COLORS.length],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      archived: false,
      columns: [],
      rows: [],
      summaries: [],
    };
    for (const cdef of def.columns) t.columns.push(buildColumn(cdef));
    const colId = (n) => t.columns.find((c) => c.name === n).id;
    for (const rw of def.rows || []) {
      const values = {};
      for (const k in rw) values[colId(k)] = rw[k];
      t.rows.push(makeRow(t, values, { enforce: false }));
    }
    if (def.summaries && def.summaries.length) {
      t.summaries = def.summaries.map((s) => ({ columnId: colId(s.column), func: s.func }));
    }
    await dbPut(db, 'tables', t);
    ids[def.name] = t.id;
  }
  for (const c of DEMO_CHARTS) {
    const table = await dbGet(db, 'tables', ids[c.table]);
    const colId = (n) => table.columns.find((x) => x.name === n).id;
    const now = nowISO();
    await dbPut(db, 'charts', {
      id: newId('ch', 9),
      owner: OWNER,
      name: c.name,
      config: {
        tableId: ids[c.table],
        type: c.type,
        xColumn: colId(c.xColumn),
        yColumns: (c.yColumns || []).map(colId),
        aggregate: c.aggregate,
        title: c.title,
        stacked: c.stacked,
        showLegend: c.showLegend,
      },
      createdAt: now,
      updatedAt: now,
    });
  }
  await dbPut(db, 'meta', { k: DEMO_FLAG, v: 1 });
  return { seeded: true, ids };
}

/* ------------------------------------------------------------------ */
/* Auth (local, demo-grade)                                           */
/* ------------------------------------------------------------------ */

const SESSION_KEY = 'df_local_session';

async function login(username, password) {
  const db = await openDB();
  const u = await dbGet(db, 'users', String(username || '').toLowerCase().trim());
  if (!u || u.password !== String(password || '')) throw httpErr(401, 'Invalid username or password');
  const token = 'tok_' + uid(24);
  await dbPut(db, 'meta', { k: SESSION_KEY, token });
  return { token, user: publicUser(u) };
}

async function logout() {
  const db = await openDB();
  await dbDel(db, 'meta', SESSION_KEY);
  return { ok: true };
}

async function me() {
  const db = await openDB();
  const rec = await dbGet(db, 'meta', SESSION_KEY);
  const token = (() => { try { return localStorage.getItem('df_token'); } catch { return null; } })();
  if (!rec || !token || rec.token !== token) throw httpErr(401, 'Not authenticated');
  const u = await dbGet(db, 'users', OWNER);
  return { user: publicUser(u) };
}

/* ------------------------------------------------------------------ */
/* Table document helpers                                             */
/* ------------------------------------------------------------------ */

function buildColumn(def) {
  if (!def || typeof def.name !== 'string' || !def.name.trim()) throw httpErr(400, 'Column name is required');
  if (!TYPES.includes(def.type)) throw httpErr(400, `Unknown column type "${def.type}"`);
  const col = {
    id: newId('col', 9),
    name: def.name.trim(),
    type: def.type,
    subtype: def.subtype || (def.type === 'number' ? 'decimal' : def.type === 'text' ? 'single' : null),
    options: { ...(def.options || {}) },
  };
  if (col.type === 'formula') {
    col.options.formula = String(col.options.formula || '').trim();
    if (!col.options.formula) throw httpErr(400, 'Formula column requires an expression');
  }
  if (col.type === 'dropdown') {
    col.options.list = Array.isArray(col.options.list) ? col.options.list.map(String).slice(0, 500) : [];
    col.options.multi = !!col.options.multi;
  }
  return col;
}

function constraintError(col, v) {
  const opts = col.options || {};
  if ((col.type === 'number' || col.type === 'currency') && v != null) {
    if (opts.min != null && opts.min !== '' && v < Number(opts.min)) return `Value ${v} is below the minimum ${opts.min}`;
    if (opts.max != null && opts.max !== '' && v > Number(opts.max)) return `Value ${v} is above the maximum ${opts.max}`;
  }
  if (col.type === 'text' && v != null) {
    if (opts.min != null && opts.min !== '' && v.length < Number(opts.min)) return `Text is shorter than the minimum ${opts.min}`;
    if (opts.max != null && opts.max !== '' && v.length > Number(opts.max)) return `Text is longer than the maximum ${opts.max}`;
    if (opts.regex) {
      try { if (!new RegExp(opts.regex).test(String(v))) return 'Text does not match the required pattern'; } catch { /* ignore */ }
    }
  }
  if (col.type === 'dropdown' && Array.isArray(opts.list) && opts.list.length && v != null) {
    const list = opts.list.map(String);
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) if (!list.includes(String(x))) return `"${x}" is not one of the allowed options`;
  }
  return null;
}

function summarize(t) {
  return {
    id: t.id, name: t.name, description: t.description || '',
    createdAt: t.createdAt, updatedAt: t.updatedAt, archived: !!t.archived,
    kind: t.kind || 'table', color: t.color || null, icon: t.icon || null, columnCount: (t.columns || []).length,
    rowCount: (t.rows || []).length,
    columns: (t.columns || []).map((c) => ({ id: c.id, name: c.name, type: c.type, subtype: c.subtype })),
  };
}

/* ------------------------------------------------------------------ */
/* Tables CRUD                                                        */
/* ------------------------------------------------------------------ */

const localApi = {
  /* ---------- auth ---------- */
  login, logout, me,

  /* ---------- tables ---------- */
  async list({ includeArchived = false, search = '', kind } = {}) {
    const db = await openDB();
    let owned = (await dbGetAll(db, 'tables')).filter((t) => t.ownerId === OWNER);
    const q = String(search || '').toLowerCase();
    owned = owned.filter((t) => !q || (t.name || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    if (kind) owned = owned.filter((t) => (t.kind || 'table') === kind);
    if (!includeArchived) owned = owned.filter((t) => !t.archived);
    owned.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return owned.map(summarize);
  },  async create({ name, description = '', columns = [], rows = [], color, icon } = {}) {
    if (!name || !String(name).trim()) throw httpErr(400, 'Table name is required');
    const db = await openDB();
    const table = {
      id: newId('tbl', 10),
      ownerId: OWNER,
      name: String(name).trim().slice(0, 120),
      description: String(description || '').slice(0, 500),
      kind: 'table',
      color: (typeof color === 'string' && HEX_RE.test(color)) ? color.toLowerCase() : pickColor(),
      icon: TABLE_ICONS.includes(icon) ? icon : null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      archived: false,
      columns: [],
      rows: [],
      summaries: [],
    };
    for (const cdef of columns) {
      const col = buildColumn(cdef);
      if (table.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
        throw httpErr(400, `Duplicate column name "${col.name}"`);
      }
      table.columns.push(col);
    }
    for (const rowValues of rows) {
      table.rows.push(makeRow(table, rowValues, { enforce: false }));
    }
    await dbPut(db, 'tables', table);
    // A table created with rows already (imports/extracts/API) gets its
    // starter chart immediately; empty shells chart when the first row lands.
    if ((table.rows || []).length > 0) await maybeStarterChart(db, table);
    return clone(table);
  },

  async get(id) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t) throw httpErr(404, 'Table not found');
    if (t.ownerId !== OWNER) throw httpErr(403, 'You do not have access to this table');
    if (t.kind === 'linked' && t.link) {
      const src = await dbGet(db, 'tables', t.link.sourceTableId);
      if (!src) {
        return { ...t, columns: [], rows: [], linkError: 'Source table no longer exists.' };
      }
      const colIds = new Set(t.link.columnIds || []);
      const rowIds = new Set(t.link.rowIds || []);
      return {
        ...t,
        columns: clone(src.columns.filter((c) => colIds.has(c.id))),
        rows: clone(src.rows.filter((r) => rowIds.has(r.id))),
        linked: true,
        sourceTableId: t.link.sourceTableId,
      };
    }
    return clone(t);
  },

  async updateMeta(id, { name, description, color, icon } = {}) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    if (name !== undefined) {
      if (!String(name).trim()) throw httpErr(400, 'Table name cannot be empty');
      t.name = String(name).trim().slice(0, 120);
    }
    if (description !== undefined) t.description = String(description).slice(0, 500);
    if (color !== undefined) t.color = (typeof color === 'string' && HEX_RE.test(color)) ? color.toLowerCase() : null;
    if (icon !== undefined) t.icon = TABLE_ICONS.includes(icon) ? icon : null;
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return this.get(id);
  },

  async duplicate(id) {
    const db = await openDB();
    const raw = await dbGet(db, 'tables', id);
    if (!raw || raw.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    // Linked views own no data — duplicate their live content.
    const t = raw.kind === 'linked' && raw.link
      ? await this.get(id)
      : raw;
        const copy = clone(t);
    copy.id = newId('tbl', 10);
    copy.ownerId = OWNER;
    copy.name = `${t.name} (copy)`.slice(0, 120);
    copy.color = pickColor(); // duplicate stands out from its source on the dashboard
    copy.createdAt = nowISO();
    copy.updatedAt = nowISO();
    copy.archived = false;
    copy.kind = 'table';
    copy.link = undefined;
    delete copy.linked;
    delete copy.sourceTableId;
    // Regenerate column ids AND remap row values onto the new ids.
    const colMap = new Map(t.columns.map((c) => [c.id, newId('col', 9)]));
    copy.columns = t.columns.map((c) => ({ ...c, id: colMap.get(c.id) }));
    copy.rows = t.rows.map((r) => {
      const values = {};
      for (const [oldId, newId2] of colMap) {
        if (r.values[oldId] !== undefined) values[newId2] = clone(r.values[oldId]);
      }
      return { ...r, id: newId('row', 10), values };
    });
    await dbPut(db, 'tables', copy);
    return clone(copy);
  },

  async setArchived(id, archived) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    t.archived = !!archived;
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return { ok: true };
  },

  async remove(id) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    await dbDel(db, 'tables', id);
    // drop the table's stored files and any chart configs pointing at it
    const files = await dbGetAll(db, 'files');
    for (const f of files.filter((x) => x.tableId === id)) await dbDel(db, 'files', f.url);
    const charts = await dbGetAll(db, 'charts');
    for (const c of charts.filter((x) => x.config && x.config.tableId === id)) await dbDel(db, 'charts', c.id);
    return { ok: true };
  },

  /* ---------- columns ---------- */
  async addColumn(id, def) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const col = buildColumn(def);
    if (t.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
      throw httpErr(400, `A column named "${col.name}" already exists`);
    }
    t.columns.push(col);
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return clone(col);
  },

  async updateColumn(id, colId, patch) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const col = t.columns.find((c) => c.id === colId);
    if (!col) throw httpErr(404, 'Column not found');
    const merged = {
      ...col,
      ...patch,
      name: patch.name !== undefined ? String(patch.name).trim() : col.name,
      subtype: patch.subtype !== undefined ? patch.subtype : col.subtype,
      options: { ...col.options, ...(patch.options || {}) },
    };
    if (!merged.name) throw httpErr(400, 'Column name cannot be empty');
    if (merged.type === 'dropdown') merged.options.list = Array.isArray(merged.options.list) ? merged.options.list.map(String) : [];
    if (merged.type === 'formula') merged.options.formula = String(merged.options.formula || '').trim();
    if (t.columns.some((c) => c.id !== colId && c.name.toLowerCase() === merged.name.toLowerCase())) {
      throw httpErr(400, `A column named "${merged.name}" already exists`);
    }
    Object.assign(col, merged);
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return clone(col);
  },

  async removeColumn(id, colId) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const idx = t.columns.findIndex((c) => c.id === colId);
    if (idx === -1) throw httpErr(404, 'Column not found');
    t.columns.splice(idx, 1);
    for (const row of t.rows) delete row.values[colId];
    t.summaries = t.summaries.filter((s) => s.columnId !== colId);
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return { ok: true };
  },

  async reorderColumns(id, orderedIds) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    if (orderedIds.length !== t.columns.length || new Set(orderedIds).size !== t.columns.length) {
      throw httpErr(400, 'Column id list must contain every column exactly once');
    }
    const byId = new Map(t.columns.map((c) => [c.id, c]));
    t.columns = orderedIds.map((cid) => byId.get(cid)).filter(Boolean);
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return { ok: true };
  },

  /* ---------- rows ---------- */
  async addRow(id, values) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const wasEmpty = t.rows.length === 0;
    const row = makeRow(t, values || {}, { enforce: false });
    t.rows.push(row);
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    // First row in a previously empty table → auto-save its starter chart.
    if (wasEmpty) await maybeStarterChart(db, t);
    return clone(row);
  },

  async updateRow(id, rowId, values) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const row = t.rows.find((r) => r.id === rowId);
    if (!row) throw httpErr(404, 'Row not found');
    for (const col of t.columns) {
      if (col.type === 'formula') continue;
      if (!(col.id in (values || {}))) continue;
      const raw = values[col.id];
      const v = coerceClient(col, raw);
      if (v === null && col.options.required && col.type !== 'boolean') {
        throw httpErr(400, `"${col.name}" is required`);
      }
      const err = constraintError(col, v);
      if (err) throw httpErr(400, err);
      row.values[col.id] = v;
    }
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return clone(row);
  },

  async deleteRows(id, rowIds) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const set = new Set(rowIds || []);
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => !set.has(r.id));
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return { ok: true, removed: before - t.rows.length };
  },

  /* ---------- extraction / linked views ---------- */
  async extract({ name, description = '', sourceTableId, mode = 'copy', rowIds = null, columnIds = null } = {}) {
    const db = await openDB();
    const src = await dbGet(db, 'tables', sourceTableId);
    if (!src || src.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    // linked sources contribute their live (resolved) shape
    const source = src.kind === 'linked' && src.link ? await this.get(sourceTableId) : src;
    const rowSet = rowIds ? new Set(rowIds) : null;
    const colSet = columnIds ? new Set(columnIds) : null;
    const cols = colSet ? source.columns.filter((c) => colSet.has(c.id)) : source.columns;
    const rows = rowSet ? source.rows.filter((r) => rowSet.has(r.id)) : source.rows;
    if (!cols.length) throw httpErr(400, 'No columns selected');
        const base = {
      id: newId('tbl', 10),
      ownerId: OWNER,
      name: String(name || `${source.name} ${mode === 'linked' ? 'view' : 'extract'}`).trim().slice(0, 120),
      description: String(description || '').slice(0, 500),
      color: TABLE_COLORS[Math.floor(Math.random() * TABLE_COLORS.length)],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      archived: false,
      summaries: [],
    };
    let out;
    if (mode === 'linked') {
      out = {
        ...base,
        kind: 'linked',
        columns: [],
        rows: [],
        link: { sourceTableId, rowIds: rows.map((r) => r.id), columnIds: cols.map((c) => c.id) },
      };
      await dbPut(db, 'tables', out);
      return this.get(out.id);
    }
    out = {
      ...base,
      kind: 'table',
      columns: clone(cols),
      rows: rows.map((r) => {
        const values = {};
        for (const c of cols) {
          if (c.type === 'formula') continue;
          if (r.values[c.id] !== undefined) values[c.id] = clone(r.values[c.id]);
        }
        return { id: newId('row', 10), createdAt: r.createdAt, values };
      }),
    };
    await dbPut(db, 'tables', out);
    if ((out.rows || []).length > 0) await maybeStarterChart(db, out);
    return clone(out);
  },

  async detach(id) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    if (t.kind !== 'linked' || !t.link) return clone(t);
    const resolved = await this.get(id);
        const copy = {
      id: t.id, ownerId: OWNER, name: t.name, description: t.description,
      kind: 'table', color: t.color || TABLE_COLORS[Math.floor(Math.random() * TABLE_COLORS.length)],
      createdAt: t.createdAt, updatedAt: nowISO(), archived: false,
      columns: clone(resolved.columns),
      rows: resolved.rows.map((r) => ({ id: newId('row', 10), createdAt: r.createdAt, values: clone(r.values) })),
      summaries: [],
    };
    await dbPut(db, 'tables', copy);
    return clone(copy);
  },

  async putSummaries(id, summaryList) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', id);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    const valid = ['sum', 'avg', 'min', 'max', 'count', 'counta'];
    t.summaries = (Array.isArray(summaryList) ? summaryList : [])
      .filter((s) => s && valid.includes(s.func) && t.columns.some((c) => c.id === s.columnId))
      .map((s) => ({ columnId: s.columnId, func: s.func }));
    t.updatedAt = nowISO();
    await dbPut(db, 'tables', t);
    return { ok: true };
  },

  /* ---------- uploaded files ---------- */
  async saveFile(tableId, { filename, data, mime = 'application/octet-stream' }) {
    const db = await openDB();
    const t = await dbGet(db, 'tables', tableId);
    if (!t || t.ownerId !== OWNER) throw httpErr(403, 'Forbidden');
    if (!data) throw httpErr(400, 'No file data supplied');
    const size = Math.floor(BufferBytes(data));
    if (size > 20 * 1024 * 1024) throw httpErr(413, 'File exceeds the 20 MB limit');
    const url = `data:${mime};base64,${data}`;
    await dbPut(db, 'files', { url, tableId, name: String(filename || 'file'), size, mime });
    return { url, name: String(filename || 'file'), size, mime };
  },

  /* ---------- row shares ---------- */
  async shareRow(id, rowId) {
    const db = await openDB();
    const t = await this.get(id);
    const row = (t.rows || []).find((r) => r.id === rowId);
    if (!row) throw httpErr(404, 'Row not found');
    const token = uid(16);
    await dbPut(db, 'shares', { token, owner: OWNER, tableId: id, rowId, createdAt: nowISO() });
    return { token, url: `/share/${token}` };
  },

  async getShare(token) {
    const db = await openDB();
    const rec = await dbGet(db, 'shares', token);
    if (!rec) throw httpErr(404, 'Share link not found or revoked');
    const table = await this.get(rec.tableId);
    const row = (table.rows || []).find((r) => r.id === rec.rowId);
    if (!row) throw httpErr(404, 'The shared row no longer exists');
    return {
      token: rec.token,
      tableName: table.name,
      tableDescription: table.description || '',
      sharedAt: rec.createdAt,
      columns: table.columns,
      row,
    };
  },

  /* ---------- saved charts ---------- */
  async listCharts() {
    const db = await openDB();
    return (await dbGetAll(db, 'charts'))
      .filter((c) => c.owner === OWNER)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },
  async saveChart({ id, name, config }) {
    const db = await openDB();
    const charts = await dbGetAll(db, 'charts');
    const now = nowISO();
    if (id) {
      const c = charts.find((x) => x.id === id && x.owner === OWNER);
      if (!c) throw httpErr(404, 'Chart not found');
      c.name = String(name || c.name).slice(0, 120);
      c.config = config;
      c.updatedAt = now;
      await dbPut(db, 'charts', c);
      return clone(c);
    }
    const c = { id: newId('ch', 9), owner: OWNER, name: String(name || 'Untitled chart').slice(0, 120), config, createdAt: now, updatedAt: now };
    await dbPut(db, 'charts', c);
    return clone(c);
  },
  async deleteChart(id) {
    const db = await openDB();
    await dbDel(db, 'charts', id);
    return { ok: true };
  },
  async saveChartImage({ name, format, data }) {
    // The client already downloaded the PNG/JPG — nothing to persist locally.
    return { file: 'local', filename: `${name}.${format === 'jpg' || format === 'jpeg' ? 'jpg' : 'png'}`, savedAt: nowISO() };
  },

  /* ---------- demo dataset (browser mode) ---------- */
  seedDemo: async () => seedDemo(await openDB()),
};

/* ------------------------------------------------------------------ */
/* Row building (mirrors server/store.js makeRow semantics)            */
/* ------------------------------------------------------------------ */

function makeRow(table, values, { enforce }) {
  const row = { id: newId('row', 10), createdAt: nowISO(), values: {} };
  for (const col of table.columns || []) {
    if (col.type === 'formula') continue;
    const has = values && values[col.id] !== undefined;
    const raw = has ? values[col.id] : col.options.defaultValue;
    const v = coerceClient(col, raw);
    if (enforce) {
      if (v === null && col.options.required && col.type !== 'boolean') throw httpErr(400, `"${col.name}" is required`);
      const err = constraintError(col, v);
      if (err) throw httpErr(400, err);
    }
    row.values[col.id] = v;
  }
  return row;
}

/* ================================================================== */
/* Imports — client-side parsing (mirrors server/io.js)               */
/* ================================================================== */

const MAX_IMPORT_ROWS = 10000;
const PREVIEW_ROWS = 50;
const importJobs = new Map(); // jobId -> { headers, rows, columns, fileName, sheetName }

function BufferBytes(base64) {
  // approximate decoded byte count without allocating
  const pad = (base64.match(/=+$/) || [''])[0].length;
  return base64.length * 0.75 - pad;
}

function base64ToBytes(base64) {
  const bin = atob(base64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/* ----- generic grid normalisation (shared by every parser) ----- */
function aoaToGrid(aoa) {
  if (!aoa || !aoa.length) throw new Error('The file appears to be empty');
  const headerIdx = aoa.findIndex((r) => r.some((c) => c !== null && c !== '' && String(c).trim() !== ''));
  if (headerIdx === -1) throw new Error('The file appears to be empty');
  const headerRow = aoa[headerIdx];
  const width = Math.max(headerRow.length, ...aoa.slice(headerIdx + 1).map((r) => r.length), 1);
  const padRow = Array.from({ length: width }, (_, i) => (headerRow[i] == null ? '' : headerRow[i]));
  const headers = padRow.map((hd, i) => uniqueHeader(String(hd).trim() || `Column ${i + 1}`, i, padRow));
  const rows = aoa.slice(headerIdx + 1)
    .filter((r) => r.some((c) => c !== null && c !== '' && String(c).trim() !== ''))
    .map((r) => headers.map((_, i) => normalizeCell(r[i])));
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new Error(`This file has ${rows.length} data rows — the importer accepts up to ${MAX_IMPORT_ROWS}. Please split the file.`);
  }
  return { headers, rows };
}

function uniqueHeader(base, idx, headerRow) {
  let name = base;
  let n = 2;
  while (headerRow.some((hd, i) => i !== idx && String(hd == null ? '' : hd).trim() === name)) {
    name = `${base} (${n++})`;
  }
  return name;
}

function normalizeCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (v.t !== undefined && v.v !== undefined) return v.v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  if (typeof v === 'number' && !isFinite(v)) return '';
  return v;
}

/* ----- type detection (same heuristics as the server) ----- */
function detectType(headerName, values) {
  const n = values.length;
  if (!n) return { type: 'text', subtype: 'single' };
  const s = values.map((v) => String(v).trim());
  const count = (pred) => s.filter(pred).length;
  const numeric = count((x) => x !== '' && isFinite(Number(String(x).replace(/[$€£₦¥₹,\s]/g, ''))));
  const truthy = new Set(['true', 'yes', 'y', '1', 'on', '✓', 'x']);
  const falsy = new Set(['false', 'no', 'n', '0', 'off', '']);
  const boolLike = count((x) => truthy.has(x.toLowerCase()) || falsy.has(x.toLowerCase()));
  const distinct = new Set(s.map((x) => x.toLowerCase()));
  const fracRe = /^-?(\d+\s+)?\d+\/\d+$/;
  const fractions = count((x) => fracRe.test(x));
  const timeRe = /^(\d{1,2}):(\d{2})(:(\d{2}))?$/;
  const times = count((x) => timeRe.test(x));
  const dateRe = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
  const shortDateRe = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/;
  const dates = count((x) => dateRe.test(x) || shortDateRe.test(x));
  const dtRe = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})/;
  const datetimes = count((x) => dtRe.test(x));
  const currency = /[$€£₦¥₹]/;
  const nums = values.map((v) => (typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.]/g, ''))));
  const serialish = nums.length && nums.every((v) => !isNaN(v) && v >= 20000 && v <= 70000);
  const dateyHeader = /date|added|since|created|when|dob|birth|due|start|end|day|updated/i.test(headerName);
  if (serialish && (dateyHeader || nums.length >= n * 0.8)) return { type: 'date', subtype: null };
  if (datetimes >= n * 0.8 && datetimes > 0) return { type: 'datetime', subtype: null };
  if (dates >= n * 0.8 && dates > 0) return { type: 'date', subtype: null };
  if (times >= n * 0.8 && times > 0) return { type: 'time', subtype: null };
  if (fractions >= n * 0.8 && fractions > 0) return { type: 'fraction', subtype: null };
  if (numeric >= n * 0.85 && numeric > 0) {
    const allInt = count((x) => Number.isInteger(Number(String(x).replace(/,/g, ''))));
    const hasCurrency = currency.test(headerName) || s.some((x) => currency.test(x));
    if (hasCurrency) return { type: 'currency', subtype: null };
    return { type: 'number', subtype: allInt >= n * 0.85 ? 'integer' : 'decimal' };
  }
  if (boolLike >= n * 0.8 && distinct.size <= 4 && boolLike > 0) return { type: 'boolean', subtype: null };
  if (distinct.size <= 15 && distinct.size >= 2 && n >= 5) return { type: 'dropdown', subtype: null };
  return { type: 'text', subtype: 'single' };
}

function buildColumnInfo(headers, rows) {
  return headers.map((name, i) => {
    const values = rows.map((r) => r[i]).filter((v) => v !== null && v !== '');
    const det = detectType(name, values);
    return {
      index: i,
      name,
      suggestedType: det.type,
      suggestedSubtype: det.subtype || null,
      stats: { nonEmpty: values.length, distinct: new Set(values.map((v) => String(v))).size, total: rows.length },
    };
  });
}

/* ----- ZIP reader (DecompressionStream) ----- */
async function unzipEntries(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  let eocd = -1;
  const min = Math.max(0, u8.length - 65558);
  for (let i = u8.length - 22; i >= min; i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Not a valid ZIP archive');
  const count = u16(eocd + 10);
  let off = u32(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (u32(off) !== 0x02014b50) break;
    const method = u16(off + 10);
    const compSize = u32(off + 20);
    const nameLen = u16(off + 28);
    const extraLen = u16(off + 30);
    const commentLen = u16(off + 32);
    const localOff = u32(off + 42);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, localOff, method, compSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = new Map();
  for (const e of entries) {
    const nameLen = u16(e.localOff + 26);
    const extraLen = u16(e.localOff + 28);
    const start = e.localOff + 30 + nameLen + extraLen;
    const chunk = u8.subarray(start, start + e.compSize);
    if (e.method === 0) {
      out.set(e.name, new TextDecoder().decode(chunk));
    } else {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([chunk]).stream().pipeThrough(ds);
      out.set(e.name, new TextDecoder().decode(await new Response(stream).arrayBuffer()));
    }
  }
  return out;
}

/* ----- .docx ----- */
function decodeXml(x) {
  return String(x)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function docxCellText(tcXml) {
  const paragraphs = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(tcXml)) !== null) {
    const p = m[0];
    let text = '';
    const inner = p.replace(/<w:tab[^>]*\/>/g, '\t');
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:br[^>]*\/>/g;
    let t;
    while ((t = tRe.exec(inner)) !== null) text += t[0].startsWith('<w:br') ? '\n' : t[1];
    paragraphs.push(decodeXml(text).replace(/\u0000/g, ''));
  }
  return paragraphs.filter((p2, i) => !(p2 === '' && i === 0)).join('\n').trimEnd();
}

function docxTablesToAoa(xml) {
  const tables = [];
  const tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tbl;
  while ((tbl = tblRe.exec(xml)) !== null) {
    const aoa = [];
    const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let tr;
    while ((tr = trRe.exec(tbl[0])) !== null) {
      const cells = [];
      const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let tc;
      while ((tc = tcRe.exec(tr[0])) !== null) cells.push(docxCellText(tc[0]));
      aoa.push(cells);
    }
    if (aoa.length) tables.push(aoa);
  }
  return tables;
}

function docxParagraphs(xml) {
  const paras = [];
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const text = docxCellText(m[0]);
    if (text.trim()) paras.push(text.trim());
  }
  return paras;
}

async function parseDocx({ filename, data }) {
  const zip = await unzipEntries(base64ToBytes(data));
  const xml = zip.get('word/document.xml');
  if (!xml) throw new Error('“document.xml” was not found in this .docx — is it a valid Word document?');
  const tables = docxTablesToAoa(xml).map((aoa) => aoaToGrid(aoa));
  if (tables.length) {
    tables.sort((a, b) => b.rows.length - a.rows.length || b.headers.length - a.headers.length);
    return { sheetName: 'Document', ...tables[0] };
  }
  const paras = docxParagraphs(xml);
  if (!paras.length) throw new Error(`No tables or text found in "${filename}".`);
  return { sheetName: 'Document', headers: ['Text'], rows: paras.map((p) => [p]).slice(0, MAX_IMPORT_ROWS) };
}

/* ----- .csv ----- */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c !== '')) rows.push(row); }
  return rows;
}

/* ----- .xlsx / .xls ----- */
function parseSpreadsheet({ filename, data }) {
  if (typeof XLSX === 'undefined') throw new Error('Spreadsheet support not loaded — reload the page');
  let wb;
  try {
    wb = XLSX.read(data, { type: 'base64', cellDates: false });
  } catch (e) {
    throw new Error(`Could not parse "${filename}": ${e.message}`);
  }
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error('The file contains no sheets');
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  return { sheetName, ...aoaToGrid(aoa) };
}

/* ----- .pdf (text layer only; OCR needs the backend) ----- */
async function parsePdf({ filename, data }) {
  const u8 = base64ToBytes(data);
  let pdfjs;
  try {
    pdfjs = await import('../vendor/pdfjs/pdf.js');
  } catch (e) {
    throw new Error('PDF support failed to load — try again or use the backend for PDF imports');
  }
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.js', import.meta.url).href;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: u8, verbosity: 0 }).promise;
  } catch (e) {
    throw new Error(`Could not open "${filename}" as a PDF: ${e.message}`);
  }
  try {
    if (doc.numPages > 200) throw new Error('This PDF has more than 200 pages — please split it before importing.');
    let totalChars = 0;
    const allLines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = (content.items || []).filter((it) => it.str && it.str.trim());
      const lines = [];
      for (const it of items) {
        const y = it.transform[5];
        const x = it.transform[4];
        const w = typeof it.width === 'number' ? it.width : 0;
        const line = lines.find((l) => Math.abs(l.y - y) <= 2.5);
        totalChars += it.str.length;
        if (line) { line.items.push({ x, w, text: it.str }); line.chars += it.str.length; }
        else lines.push({ y, items: [{ x, w, text: it.str }], chars: it.str.length });
      }
      for (const l of lines) l.items.sort((a, b) => a.x - b.x);
      lines.sort((a, b) => b.y - a.y);
      if (allLines.length && lines.length) allLines.push({ items: [{ x: -1, w: 0, text: '' }], pageBreak: true });
      allLines.push(...lines);
      try { page.cleanup(); } catch { /* ignore */ }
    }
    if (totalChars < 20) {
      throw new Error('This PDF appears to be scanned (no text layer). OCR is only available when the DataForge backend is running — start it with `npm start` and import from there.');
    }
    return { sheetName: doc.numPages === 1 ? 'Page 1' : `PDF (${doc.numPages} pages)`, ...pdfLinesToGrid(allLines.filter((l) => !l.pageBreak)) };
  } finally {
    try { await doc.destroy(); } catch { /* ignore */ }
  }
}

function pdfLinesToGrid(lines) {
  const withWords = lines.filter((l) => l.items && l.items.length);
  if (!withWords.length) throw new Error('No readable text was found in this document.');
  const midpoints = [];
  for (const l of withWords) for (const it of l.items) midpoints.push(it.x + (it.w || 0) / 2);
  midpoints.sort((a, b) => a - b);
  const clusters = [];
  for (const m of midpoints) {
    const last = clusters[clusters.length - 1];
    if (last && m - last.sum / last.n <= 8) { last.sum += m; last.n++; }
    else clusters.push({ sum: m, n: 1 });
  }
  const centers = clusters.filter((c) => c.n >= Math.max(2, withWords.length * 0.25)).map((c) => c.sum / c.n);
  const merged = centers.length ? [centers[0]] : [];
  for (const c of centers.slice(1)) if (c - merged[merged.length - 1] > 14) merged.push(c);

  const toCells = (line) => {
    if (!merged.length) return [line.items.map((it) => it.text).join(' ')];
    const cells = merged.map(() => []);
    for (const it of line.items) {
      const mid = it.x + (it.w || 0) / 2;
      let best = 0;
      let bestD = Infinity;
      merged.forEach((c, i) => { const d = Math.abs(mid - c); if (d < bestD) { bestD = d; best = i; } });
      cells[best].push(it.text);
    }
    return cells.map((c) => c.join(' ').trim());
  };
  const celled = withWords.map((l) => toCells(l));
  const filled = celled.filter((c) => c.filter((x) => x).length >= 2);
  if (merged.length > 1 && filled.length >= Math.max(2, celled.length * 0.35)) {
    const width = merged.length;
    const aoa = celled
      .map((row) => Array.from({ length: width }, (_, i) => (row[i] === undefined ? '' : row[i])))
      .filter((r) => r.some((x) => x !== ''));
    return aoaToGrid(aoa);
  }
  const rows = celled.map((c) => c.join(' ').trim()).filter(Boolean)
    .slice(0, MAX_IMPORT_ROWS).map((t) => [t]);
  return { headers: ['Text'], rows };
}

/* ----- import job orchestration ----- */
async function importParse(filename, data) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  let parsed;
  if (['xlsx', 'xls', 'csv'].includes(ext)) parsed = ext === 'csv' ? aoaToGrid(parseCsv(atob(data))) : parseSpreadsheet({ filename, data });
  else if (ext === 'docx') parsed = await parseDocx({ filename, data });
  else if (ext === 'pdf') parsed = await parsePdf({ filename, data });
  else throw new Error(`Unsupported file type “.${ext}”. Supported: .xlsx .xls .csv .docx .pdf`);
  const jobId = newId('job', 10);
  const columns = buildColumnInfo(parsed.headers, parsed.rows);
  importJobs.set(jobId, { jobId, fileName: filename, sheetName: parsed.sheetName || 'Sheet 1', headers: parsed.headers, columns, rows: parsed.rows });
  return {
    jobId, fileName: filename, sheetName: parsed.sheetName || 'Sheet 1',
    totalRows: parsed.rows.length, columns, headers: parsed.headers,
    preview: parsed.rows.slice(0, PREVIEW_ROWS),
  };
}

function convertImportCell(type, subtype, raw) {
  if (raw === null || raw === '' || raw === undefined) return null;
  if (type === 'number' || type === 'currency') {
    if (typeof raw === 'number') return subtype === 'integer' ? Math.round(raw) : raw;
    const s = String(raw).replace(/[$€£₦¥₹,\s]/g, '');
    const n = Number(s);
    return Number.isFinite(n) ? (subtype === 'integer' ? Math.round(n) : n) : null;
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    return ['true', '1', 'yes', 'y', 'on', '✓', 'x'].includes(String(raw).trim().toLowerCase());
  }
  if (type === 'date') {
    if (raw instanceof Date) return raw.toISOString().slice(0, 10);
    if (typeof raw === 'number') return excelSerialToDate(raw);
    const d = parseDateString(String(raw));
    return d || null;
  }
  if (type === 'datetime') {
    if (raw instanceof Date) return raw.toISOString().slice(0, 16).replace('T', ' ');
    if (typeof raw === 'number') return excelSerialToDate(raw).slice(0, 16);
    const s = String(raw).replace('T', ' ');
    return s.length >= 16 ? s.slice(0, 16) : null;
  }
  if (type === 'time') {
    if (typeof raw === 'number') {
      const mins = Math.round((raw % 1) * 1440);
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    }
    const m = String(raw).match(/(\d{1,2}):(\d{2})/);
    return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
  }
  if (type === 'fraction') {
    const p = (() => { try { return coerceClient({ type: 'fraction' }, raw); } catch { return null; } })();
    return p && p.n != null ? p : null;
  }
  if (type === 'dropdown') return String(raw);
  return String(raw);
}

function excelSerialToDate(serial) {
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const d = new Date(ms);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDateString(s) {
  const p = (x) => String(x).padStart(2, '0');
  let m;
  if ((m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) return `${m[1]}-${p(+m[2])}-${p(+m[3])}`;
  if ((m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/))) {
    const a = +m[1]; const b = +m[2]; const y = +m[3];
    const year = y < 50 ? 2000 + y : y < 100 ? 1900 + y : y;
    if (a > 12) return `${year}-${p(b)}-${p(a)}`;
    return `${year}-${p(a)}-${p(b)}`;
  }
  if ((m = s.match(/^(\w+)\s+(\d{1,2}),?\s+(\d{4})/))) {
    const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    const mo = months[String(m[1]).slice(0, 3).toLowerCase()];
    return mo ? `${m[3]}-${p(mo)}-${p(+m[2])}` : null;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function importCreate({ jobId, name, description = '', columns }) {
  const job = importJobs.get(jobId);
  if (!job) throw httpErr(400, 'Import session expired — please upload the file again');
  if (!Array.isArray(columns) || !columns.length) throw httpErr(400, 'jobId and column mapping are required');
  importJobs.delete(jobId);

  // 1. de-duplicate headers honouring renames + skips
  const byIndex = new Map(columns.map((c) => [c.index, c]));
  const defs = [];
  const taken = new Map();
  for (let i = 0; i < job.headers.length; i++) {
    const mapCol = byIndex.get(i);
    if (!mapCol || mapCol.skip === true) continue;
    const type = mapCol.type || 'text';
    const subtype = mapCol.subtype || (type === 'number' ? 'decimal' : type === 'text' ? 'single' : null);
    const base = (mapCol.name || job.headers[i] || `Column ${i + 1}`).trim();
    let colName = base;
    let n2 = 2;
    while (taken.has(colName.toLowerCase())) colName = `${base} (${n2++})`;
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
  if (!defs.length) throw httpErr(400, 'Select at least one column to import');

  // 2. create the table shell, then map source column index -> stored column id
  const t = await localApi.create({ name, description, columns: defs.map((x) => x.def) });
  const colIdByIndex = new Map();
  defs.forEach((x, k) => colIdByIndex.set(x.index, t.columns[k].id));

  // 3. convert every cell and bulk-insert (invalid rows are skipped and counted)
  const db = await openDB();
  const stored = await dbGet(db, 'tables', t.id);
  let added = 0;
  let skipped = 0;
  for (const rowArr of job.rows) {
    const values = {};
    let fail = false;
    for (const { index, def } of defs) {
      const colId = colIdByIndex.get(index);
      const raw = rowArr[index];
      const converted = (def.type === 'dropdown' && def.options.multi)
        ? ((raw === null || raw === '') ? null : String(raw).split(/[,;|]/).map((s) => s.trim()).filter(Boolean))
        : convertImportCell(def.type, def.subtype, raw);
      const col = stored.columns.find((c) => c.id === colId);
      if (converted === null && col.options.required && col.type !== 'boolean') { fail = true; break; }
      const err = constraintError(col, converted);
      if (err) { fail = true; break; }
      values[colId] = converted;
    }
    if (fail) { skipped++; continue; }
    stored.rows.push({ id: newId('row', 10), createdAt: nowISO(), values });
    added++;
  }
  stored.updatedAt = nowISO();
  await dbPut(db, 'tables', stored);
  if (added > 0) await maybeStarterChart(db, stored);
  return { table: await localApi.get(t.id), added, skipped };
}

/* ================================================================== */
/* Exports — .xlsx / .csv / .docx                                     */
/* ================================================================== */

function sanitizeName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w\s\-.)(]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned || fallback;
}

/** Build array-of-arrays with computed columns evaluated (same as server). */
function buildExportAoa(table) {
  const header = table.columns.map((c) => c.name);
  const aoa = [header];
  const fxList = compute.compileFormulas(table);
  for (const row of table.rows || []) {
    const res = compute.evalRowWith(fxList, table, row);
    const values = [];
    for (const c of table.columns) {
      const raw = row.values[c.id];
      if (c.type === 'formula') {
        const r = res[c.id];
        values.push(r && r.err ? `#${r.err}` : cleanFx(r && r.v));
      } else if (raw === null || raw === undefined || raw === '') {
        values.push('');
      } else if (c.type === 'fraction') {
        values.push(raw.d === 1 ? `${raw.n}` : `${raw.n}/${raw.d}`);
      } else if (c.type === 'dropdown' && Array.isArray(raw)) {
        values.push(raw.join(', '));
      } else if (c.type === 'boolean') {
        values.push(raw ? 'TRUE' : 'FALSE');
      } else if (c.type === 'image' || c.type === 'file') {
        values.push(raw.name || raw.url || '');
      } else {
        values.push(raw);
      }
    }
    aoa.push(values);
  }
  return aoa;
}

function cleanFx(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  return String(v);
}

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportData(id, format) {
  const table = await localApi.get(id);
  const aoa = buildExportAoa(table);
  const safe = sanitizeName(table.name, 'table');
  if (format === 'csv') {
    const csv = aoa.map((r) => r.map(csvEscape).join(',')).join('\r\n');
    return { blob: new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename: `${safe}.csv` };
  }
  if (format === 'docx') {
    return { blob: await buildDocxBlob(table, aoa, collectDocxImages(table)), filename: `${safe}.docx` };
  }
  if (typeof XLSX === 'undefined') throw new Error('Spreadsheet export is not available — reload the page');
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Data');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return {
    blob: new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    filename: `${safe}.xlsx`,
  };
}

/* ----- minimal .docx writer (stored, uncompressed ZIP) ----- */
function crc32(u8) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < u8.length; i++) crc = table[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  let totalSize = 0;
  for (const name of Object.keys(files)) {
    const nameBuf = enc.encode(name);
    const val = files[name];
    const data = val instanceof Uint8Array ? val : enc.encode(val);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30 + nameBuf.length + data.length));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);           // version needed
    local.setUint16(8, 0, true);            // method: store
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size
    local.setUint32(22, data.length, true); // uncompressed size
    local.setUint16(26, nameBuf.length, true);
    new Uint8Array(local.buffer, 30, nameBuf.length).set(nameBuf);
    new Uint8Array(local.buffer, 30 + nameBuf.length, data.length).set(data);
    parts.push(new Uint8Array(local.buffer));
    // central directory header
    const cd = new DataView(new ArrayBuffer(46 + nameBuf.length));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);              // version made by
    cd.setUint16(6, 20, true);              // version needed
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBuf.length, true);
    cd.setUint32(42, offset, true);         // local header offset
    new Uint8Array(cd.buffer, 46, nameBuf.length).set(nameBuf);
    central.push(new Uint8Array(cd.buffer));
    offset += 30 + nameBuf.length + data.length;
    totalSize += 46 + nameBuf.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const p of parts) { out.set(p, pos); pos += p.length; }
  for (const c of central) { out.set(c, pos); pos += c.length; }
  out.set(new Uint8Array(eocd.buffer), pos);
  return out;
}

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Read pixel dimensions + format from image bytes (PNG / JPEG / GIF). */
function imageDims(u8) {
  if (!u8 || u8.length < 24) return null;
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) {
    return {
      type: 'png', ext: 'png',
      width: ((u8[16] << 24) | (u8[17] << 16) | (u8[18] << 8) | u8[19]) >>> 0,
      height: ((u8[20] << 24) | (u8[21] << 16) | (u8[22] << 8) | u8[23]) >>> 0,
    };
  }
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) {
    return { type: 'png', ext: 'gif', width: u8[6] | (u8[7] << 8), height: u8[8] | (u8[9] << 8) };
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xff) { i++; continue; }
      const marker = u8[i + 1];
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (len < 2) break;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { type: 'jpg', ext: 'jpg', width: (u8[i + 7] << 8) | u8[i + 8], height: (u8[i + 5] << 8) | u8[i + 6] };
      }
      i += 2 + len;
    }
  }
  return null;
}

/**
 * Gather the table's uploaded images (keyed "rowIdx:colIdx") so the DOCX
 * export embeds the real pictures instead of just their file names. Cells
 * keep their text fallback in every other format.
 */
function collectDocxImages(table) {
  const images = new Map();
  let ri = 0;
  for (const row of table.rows || []) {
    (table.columns || []).forEach((c, ci) => {
      if (c.type !== 'image') return;
      const raw = row.values[c.id];
      if (!raw || typeof raw !== 'object' || !raw.url) return;
      const mime = String(raw.mime || '');
      const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif)$/i.test(raw.name || raw.url);
      if (!isImage || typeof raw.url !== 'string' || !raw.url.startsWith('data:')) return;
      try {
        const bytes = base64ToBytes(String(raw.url).split(',')[1] || '');
        const dims = imageDims(bytes);
        if (!dims) return;
        const scale = Math.min(1, 220 / (dims.width || 1));
        images.set(`${ri}:${ci}`, {
          data: bytes, type: dims.type, ext: dims.ext,
          transform: {
            width: Math.max(1, Math.round((dims.width || 1) * scale)),
            height: Math.max(1, Math.round((dims.height || 1) * scale)),
          },
        });
      } catch { /* skip unreadable image */ }
    });
    ri++;
  }
  return images;
}

async function buildDocxBlob(table, aoa, images) {
  const cols = table.columns.length;
  const title = xmlEsc(table.name);
  const desc = table.description ? xmlEsc(table.description) : '';
  const colCount = Math.max(1, cols);
  const colW = Math.floor(9360 / colCount); // ~6.5in page
  const grid = `<w:tblGrid>${new Array(colCount).fill(`<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;

  // ---- embed uploaded images as Word drawings (media + relationships) ----
  const imgList = [...(images || new Map()).entries()];
  const media = {};
  const rels = [];
  let imgN = 0;
  const imgRefs = new Map(); // "ri:ci" -> { rid, cx, cy }
  for (const [key, img] of imgList) {
    if (!img || !img.data || !img.transform) continue;
    imgN++;
    const fname = `image${imgN}.${img.ext || (img.type === 'jpg' ? 'jpg' : 'png')}`;
    const rid = `rIdImg${imgN}`;
    media[`word/media/${fname}`] = img.data;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fname}"/>`);
    imgRefs.set(key, { rid, cx: Math.round(img.transform.width * 9525), cy: Math.round(img.transform.height * 9525) });
  }

  const cellXml = (c, ri, ci) => {
    const shd = ri === 0 ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEAFB"/>' : '';
    const img = imgRefs.get(`${ri}:${ci}`);
    if (img) {
      return `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}</w:tcPr>` +
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${img.cx}" cy="${img.cy}"/>` +
        `<wp:docPr id="${1000 + imgN + ci}" name="Picture ${imgN}"/>` +
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
        `<pic:pic><pic:nvPicPr><pic:cNvPr id="${1000 + imgN + ci}" name="${xmlEsc(c)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
        `<pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
        `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm>` +
        `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
        `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:tc>`;
    }
    return `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${shd}</w:tcPr>` +
      `<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${ri === 0 ? '<w:b/>' : ''}</w:rPr></w:pPr>` +
      `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${ri === 0 ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${xmlEsc(c)}</w:t></w:r></w:p></w:tc>`;
  };
  const rowsXml = aoa.map((cells, ri) =>
    `<w:tr>` + cells.map((c, ci) => cellXml(c, ri, ci)).join('') + `</w:tr>`
  ).join('');
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>${title}</w:t></w:r></w:p>`,
    desc ? `<w:p><w:r><w:rPr><w:color w:val="666666"/></w:rPr><w:t>${desc}</w:t></w:r></w:p>` : '',
    `<w:p><w:r><w:rPr><w:color w:val="999999"/><w:sz w:val="18"/></w:rPr><w:t>Exported ${new Date().toLocaleString()} — ${table.rows ? table.rows.length : 0} rows</w:t></w:r></w:p>`,
    `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>` +
    `<w:top w:val="single" w:sz="4" w:color="D0D0D0"/><w:left w:val="single" w:sz="4" w:color="D0D0D0"/><w:bottom w:val="single" w:sz="4" w:color="D0D0D0"/><w:right w:val="single" w:sz="4" w:color="D0D0D0"/><w:insideH w:val="single" w:sz="4" w:color="D0D0D0"/><w:insideV w:val="single" w:sz="4" w:color="D0D0D0"/>` +
    `</w:tblBorders></w:tblPr>${grid}${rowsXml}</w:tbl>`,
  ].filter(Boolean).join('');
  const docNs = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${docNs}><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    (imgN ? '<Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>' : '') +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = imgN
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`
    : '';
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="44"/><w:b/></w:rPr></w:style></w:styles>`;
  const files = {
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': rootRels,
    'word/document.xml': documentXml,
    'word/styles.xml': styles,
  };
  if (docRels) files['word/_rels/document.xml.rels'] = docRels;
  Object.assign(files, media);
  const bytes = zipStore(files);
  return new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/* ------------------------------------------------------------------ */
/* Attach the standalone helpers to the api object                    */
/* ------------------------------------------------------------------ */

localApi.importParse = importParse;
localApi.importCreate = importCreate;
localApi.exportData = exportData;

export { localApi };
