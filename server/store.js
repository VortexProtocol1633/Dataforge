'use strict';
/**
 * Per-entity table store.
 *
 * Every Table is persisted as its own logical unit:
 *   data/tables/<tableId>.json          -> the table document (schema + rows)
 *   data/files/<tableId>/               -> that table's uploaded images/files
 *
 * A linked (extraction) table stores only a *link spec* and is expanded live
 * from its source on read, so edits to the source are reflected immediately.
 * See `resolveTable()` below.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { uid, nowISO, sanitizeName } = require('./util');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const TABLES_DIR = path.join(DATA_DIR, 'tables');
const FILES_DIR = path.join(DATA_DIR, 'files');
const CHARTS_FILE = path.join(DATA_DIR, 'charts.json');

const TYPES = [
  'text', 'number', 'fraction', 'date', 'time', 'datetime', 'dropdown',
  'image', 'file', 'boolean', 'currency', 'formula',
];

/** Table-card colour palette (hex) + the icon set a user can pin to a table. */
const TABLE_PALETTE = ['#6366f1', '#8b5cf6', '#2dd4bf', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#a855f7'];
const TABLE_ICONS = ['table', 'layers', 'grid', 'list', 'chart', 'file', 'image', 'calendar', 'clock', 'link', 'zap', 'dollar'];
const HEX_RE = /^#[0-9a-f]{6}$/i;
const randomColor = () => TABLE_PALETTE[Math.floor(Math.random() * TABLE_PALETTE.length)];

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
function maybeStarterChart(t) {
  const cfg = starterChartConfig(t);
  if (!cfg) return;
  const existing = chartStore.list(t.ownerId).some((c) => c.config && c.config.tableId === t.id);
  if (existing) return;
  chartStore.save(t.ownerId, { name: `${t.name} overview`.slice(0, 120), config: cfg });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function ensureDirs() {
  for (const d of [DATA_DIR, TABLES_DIR, FILES_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
ensureDirs();

/* ------------------------------------------------------------------ */
/* Value coercion / validation                                        */
/* ------------------------------------------------------------------ */

function coerceFraction(raw) {
  // accepts {n,d}, "3/4", "1 1/2" (mixed -> improper), 0.75-ish? (keep n/d only)
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object' && raw !== null) {
    const n = parseInt(raw.n, 10);
    const d = parseInt(raw.d, 10);
    return fraction(n, d);
  }
  let s = String(raw).trim();
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); }
  let n = 0;
  let d = 1;
  const mixed = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  const simple = s.match(/^(\d+)\/(\d+)$/);
  const whole = s.match(/^(\d+)$/);
  if (mixed) { n = parseInt(mixed[1], 10) * parseInt(mixed[3], 10) + parseInt(mixed[2], 10); d = parseInt(mixed[3], 10); }
  else if (simple) { n = parseInt(simple[1], 10); d = parseInt(simple[2], 10); }
  else if (whole) { n = parseInt(whole[1], 10); }
  else return null;
  if (d === 0) return null;
  return fraction(neg ? -n : n, d);
}

function fraction(n, d) {
  if (d === 0) d = 1;
  const g = gcd(Math.abs(n), Math.abs(d)) || 1;
  n /= g; d /= g;
  if (d < 0) { n = -n; d = -d; }
  return { n, d };
}
function gcd(a, b) { return b ? gcd(b, a % b) : a; }

/** Coerce a raw user/import value into the canonical stored form for a column type. */
function coerceValue(type, subtype, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  switch (type) {
    case 'text':
      return String(raw);
    case 'number':
    case 'currency': {
      const n = Number(raw);
      if (raw === true) return 1;
      if (raw === false) return 0;
      if (!Number.isFinite(n)) return null;
      return subtype === 'integer' ? Math.round(n) : n;
    }
    case 'fraction':
      return coerceFraction(raw);
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const t = String(raw).trim().toLowerCase();
      return ['true', '1', 'yes', 'y', 'on', '✓', 'x'].includes(t);
    }
    case 'date':
      return String(raw).slice(0, 10);
    case 'time':
      return String(raw).slice(0, 5);
    case 'datetime': {
      const s = String(raw).replace('T', ' ');
      return s.length >= 16 ? s.slice(0, 16) : s;
    }
    case 'dropdown': {
      if (Array.isArray(raw)) return raw.map(String);
      if (raw === true) return ['true'];
      if (raw === false) return ['false'];
      return String(raw);
    }
    case 'image':
    case 'file':
      if (typeof raw === 'string') {
        // imported url / path reference -> keep as remote reference
        return { url: raw, name: raw.split('/').pop() || raw, imported: true };
      }
      return raw && typeof raw === 'object' ? { url: raw.url, name: String(raw.name || ''), size: raw.size, mime: raw.mime } : null;
    case 'formula':
      return null; // computed, never stored
    default:
      return String(raw);
  }
}

function validateNumberConstraint(type, value, options) {
  if ((type === 'number' || type === 'currency') && value != null) {
    if (options.min != null && options.min !== '' && value < Number(options.min)) throw new HttpError(400, `Value ${value} is below the minimum ${options.min}`);
    if (options.max != null && options.max !== '' && value > Number(options.max)) throw new HttpError(400, `Value ${value} is above the maximum ${options.max}`);
  }
  if (type === 'text' && value != null) {
    if (options.min != null && options.min !== '' && value.length < Number(options.min)) throw new HttpError(400, `Text is shorter than the minimum ${options.min}`);
    if (options.max != null && options.max !== '' && value.length > Number(options.max)) throw new HttpError(400, `Text is longer than the maximum ${options.max}`);
    if (options.regex) {
      try { if (!new RegExp(options.regex).test(String(value))) throw new HttpError(400, 'Text does not match the required pattern'); }
      catch (e) { if (e instanceof HttpError) throw e; }
    }
  }
  if (type === 'dropdown' && Array.isArray(options.list) && options.list.length && value != null) {
    const list = options.list.map(String);
    const vals = Array.isArray(value) ? value : [value];
    for (const v of vals) if (!list.includes(String(v))) throw new HttpError(400, `"${v}" is not one of the allowed options`);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Table document helpers                                             */
/* ------------------------------------------------------------------ */

async function readTable(id) {
  const file = path.join(TABLES_DIR, `${id}.json`);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Table not found');
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function writeTable(table) {
  table.updatedAt = nowISO();
  const file = path.join(TABLES_DIR, `${table.id}.json`);
  await fsp.writeFile(file, JSON.stringify(table, null, 2));
  return table;
}

async function listTables(owner) {
  const names = await fsp.readdir(TABLES_DIR);
  const tables = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const t = JSON.parse(await fsp.readFile(path.join(TABLES_DIR, name), 'utf8'));
      if (t.ownerId === owner) tables.push(t);
    } catch (e) { /* skip corrupt file */ }
  }
  tables.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return tables;
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

/**
 * Expand a stored table. For linked extractions the columns and rows are
 * resolved live from the source table (read-only view).
 */
async function resolveTable(table) {
  if (table.kind !== 'linked' || !table.link) return table;
  let source;
  try { source = await readTable(table.link.sourceTableId); } catch (e) { source = null; }
  if (!source) {
    return { ...table, columns: [], rows: [], linkError: 'Source table no longer exists.' };
  }
  const colIds = new Set(table.link.columnIds || []);
  const columns = source.columns.filter((c) => colIds.has(c.id)).map((c) => JSON.parse(JSON.stringify(c)));
  const rowIdSet = new Set(table.link.rowIds || []);
  const rows = source.rows.filter((r) => rowIdSet.has(r.id)).map((r) => JSON.parse(JSON.stringify(r)));
  return { ...table, columns, rows, linked: true, sourceTableId: table.link.sourceTableId };
}

/** Validate a column definition supplied by the client. */
function buildColumn(def) {
  if (!def || typeof def.name !== 'string' || !def.name.trim()) throw new HttpError(400, 'Column name is required');
  if (!TYPES.includes(def.type)) throw new HttpError(400, `Unknown column type "${def.type}"`);
  const col = {
    id: 'col_' + uid(9),
    name: def.name.trim(),
    type: def.type,
    subtype: def.subtype || (def.type === 'number' ? 'decimal' : def.type === 'text' ? 'single' : null),
    options: { ...(def.options || {}) },
  };
  if (col.type === 'formula') {
    col.options.formula = String(col.options.formula || '').trim();
    if (!col.options.formula) throw new HttpError(400, 'Formula column requires an expression');
  }
  if (col.type === 'dropdown') {
    col.options.list = Array.isArray(col.options.list) ? col.options.list.map(String).slice(0, 500) : [];
    col.options.multi = !!col.options.multi;
  }
  return col;
}

/* ------------------------------------------------------------------ */
/* Public store API                                                   */
/* ------------------------------------------------------------------ */

const store = {
  TYPES,

  // -- tables --------------------------------------------------------
  async create(owner, { name, description = '', columns = [], rows = [], color, icon } = {}) {
    if (!name || !String(name).trim()) throw new HttpError(400, 'Table name is required');
    const table = {
      id: 'tbl_' + uid(10),
      ownerId: owner,
      name: String(name).trim().slice(0, 120),
      description: String(description || '').slice(0, 500),
      kind: 'table',
      color: (typeof color === 'string' && HEX_RE.test(color)) ? color.toLowerCase() : randomColor(),
      icon: TABLE_ICONS.includes(icon) ? icon : null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      archived: false,
      columns: [],
      rows: [],
      summaries: [], // { columnId, func: sum|avg|min|max|count|counta }
    };
    for (const cdef of columns) {
      const col = buildColumn(cdef);
      if (table.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
        throw new HttpError(400, `Duplicate column name "${col.name}"`);
      }
      table.columns.push(col);
    }
    for (const rowValues of rows) {
      table.rows.push(await store.addRow(table, rowValues, { persist: false }));
    }
    fs.mkdirSync(path.join(FILES_DIR, table.id), { recursive: true });
    await writeTable(table);
    maybeStarterChart(table);
    return table;
  },

  async list(owner, { includeArchived = false } = {}) {
    const all = await listTables(owner);
    return includeArchived ? all.map(summarize) : all.filter((t) => !t.archived).map(summarize);
  },

  async get(owner, id) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'You do not have access to this table');
    return resolveTable(t);
  },

  async updateMeta(owner, id, { name, description, color, icon } = {}) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    if (name !== undefined) {
      if (!String(name).trim()) throw new HttpError(400, 'Table name cannot be empty');
      t.name = String(name).trim().slice(0, 120);
    }
    if (description !== undefined) t.description = String(description).slice(0, 500);
    if (color !== undefined) t.color = (typeof color === 'string' && HEX_RE.test(color)) ? color.toLowerCase() : null;
    if (icon !== undefined) t.icon = TABLE_ICONS.includes(icon) ? icon : null;
    await writeTable(t);
    return resolveTable(t);
  },

  async duplicate(owner, id) {
    const raw = await readTable(id);
    if (raw.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    // A linked view stores no data of its own — duplicate its live content.
    const t = raw.kind === 'linked' ? await resolveTable(raw) : raw;
    const copy = JSON.parse(JSON.stringify(t));
    copy.id = 'tbl_' + uid(10);
    copy.ownerId = owner;
    copy.name = `${t.name} (copy)`.slice(0, 120);
    copy.createdAt = nowISO();
    copy.updatedAt = nowISO();
    copy.archived = false;
    copy.kind = 'table';
    copy.link = undefined;
    delete copy.linked;
    delete copy.sourceTableId;
    copy.color = randomColor(); // duplicate stands out from its source on the dashboard
    // Regenerate column ids AND remap every row value onto the new ids,
    // otherwise the copy's cells would all be orphaned/empty.
    const colIdMap = new Map(t.columns.map((c) => [c.id, 'col_' + uid(9)]));
    copy.columns = t.columns.map((c) => ({ ...c, id: colIdMap.get(c.id) }));
    copy.rows = t.rows.map((r) => {
      const values = {};
      for (const [oldId, newId] of colIdMap) {
        if (r.values[oldId] !== undefined) values[newId] = JSON.parse(JSON.stringify(r.values[oldId]));
      }
      return { ...r, id: 'row_' + uid(10), values };
    });
    fs.mkdirSync(path.join(FILES_DIR, copy.id), { recursive: true });
    // copy uploaded files referenced by image/file cells (linked views store
    // their uploads under the source table's folder)
    const srcTableId = t.kind === 'linked' ? t.sourceTableId : t.id;
    const srcDir = path.join(FILES_DIR, srcTableId);
    if (fs.existsSync(srcDir)) {
      for (const f of fs.readdirSync(srcDir)) {
        const dest = path.join(FILES_DIR, copy.id, f);
        fs.copyFileSync(path.join(srcDir, f), dest);
      }
      for (const row of copy.rows) {
        for (const [oldColId, newColId] of colIdMap) {
          const v = row.values[newColId];
          if (v && typeof v === 'object' && v.url) {
            v.url = v.url.replace(`/${srcTableId}/`, `/${copy.id}/`);
          }
        }
      }
    }
    await writeTable(copy);
    return copy;
  },

  async setArchived(owner, id, archived) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    t.archived = !!archived;
    await writeTable(t);
    return { ok: true };
  },

  async remove(owner, id) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    await fsp.rm(path.join(TABLES_DIR, `${id}.json`), { force: true });
    await fsp.rm(path.join(FILES_DIR, id), { recursive: true, force: true });
    // drop chart configs pointing at the removed table
    const charts = loadCharts().filter((c) => c.owner !== owner || c.config.tableId !== id);
    saveCharts(charts);
    return { ok: true };
  },

  // -- columns -------------------------------------------------------
  async addColumn(owner, id, def) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const col = buildColumn(def);
    if (t.columns.some((c) => c.name.toLowerCase() === col.name.toLowerCase())) {
      throw new HttpError(400, `A column named "${col.name}" already exists`);
    }
    t.columns.push(col);
    await writeTable(t);
    return col;
  },

  async updateColumn(owner, id, colId, patch) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const col = t.columns.find((c) => c.id === colId);
    if (!col) throw new HttpError(404, 'Column not found');
    const merged = {
      ...col,
      ...patch,
      name: patch.name !== undefined ? String(patch.name).trim() : col.name,
      subtype: patch.subtype !== undefined ? patch.subtype : col.subtype,
      options: { ...col.options, ...(patch.options || {}) },
    };
    if (!merged.name) throw new HttpError(400, 'Column name cannot be empty');
    if (merged.type === 'dropdown') merged.options.list = Array.isArray(merged.options.list) ? merged.options.list.map(String) : [];
    if (merged.type === 'formula') merged.options.formula = String(merged.options.formula || '').trim();
    if (t.columns.some((c) => c.id !== colId && c.name.toLowerCase() === merged.name.toLowerCase())) {
      throw new HttpError(400, `A column named "${merged.name}" already exists`);
    }
    Object.assign(col, merged);
    // When a column is renamed, formulas that referenced the old name would
    // break — leave references to the user (client warns). Keep data intact.
    await writeTable(t);
    return col;
  },

  async removeColumn(owner, id, colId) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const idx = t.columns.findIndex((c) => c.id === colId);
    if (idx === -1) throw new HttpError(404, 'Column not found');
    t.columns.splice(idx, 1);
    for (const row of t.rows) delete row.values[colId];
    t.summaries = t.summaries.filter((s) => s.columnId !== colId);
    await writeTable(t);
    return { ok: true };
  },

  async reorderColumns(owner, id, orderedIds) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    if (orderedIds.length !== t.columns.length || new Set(orderedIds).size !== t.columns.length) {
      throw new HttpError(400, 'Column id list must contain every column exactly once');
    }
    const byId = new Map(t.columns.map((c) => [c.id, c]));
    t.columns = orderedIds.map((cid) => byId.get(cid)).filter(Boolean);
    await writeTable(t);
    return { ok: true };
  },

  // -- rows ----------------------------------------------------------
  async addRow(tableOrId, values, { persist = true, owner } = {}) {
    const t = typeof tableOrId === 'object' ? tableOrId : await readTable(tableOrId);
    if (owner !== undefined && t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const row = { id: 'row_' + uid(10), createdAt: nowISO(), values: {} };
    for (const col of t.columns) {
      if (col.type === 'formula') continue;
      const raw = values && values[col.id] !== undefined ? values[col.id] : col.options.defaultValue;
      const v = coerceValue(col.type, col.subtype, raw);
      // A brand-new row may be created blank even when columns are required
      // (the user fills it in afterwards); required-ness is enforced on update.
      validateNumberConstraint(col.type, v, col.options);
      row.values[col.id] = v;
    }
    const wasEmpty = t.rows.length === 0;
    t.rows.push(row);
    if (persist) {
      if (owner !== undefined && t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
      await writeTable(t);
      // First row in a previously empty table → auto-save its starter chart.
      if (wasEmpty) maybeStarterChart(t);
    }
    return row;
  },

  async updateRow(owner, id, rowId, values) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const row = t.rows.find((r) => r.id === rowId);
    if (!row) throw new HttpError(404, 'Row not found');
    for (const col of t.columns) {
      if (col.type === 'formula') continue;
      if (!(col.id in (values || {}))) continue;
      const raw = values[col.id];
      const v = coerceValue(col.type, col.subtype, raw);
      if (v === null && col.options.required && col.type !== 'boolean') {
        throw new HttpError(400, `"${col.name}" is required`);
      }
      validateNumberConstraint(col.type, v, col.options);
      row.values[col.id] = v;
    }
    await writeTable(t);
    return row;
  },

  /** Insert many rows at once (used by the importer); invalid rows are skipped. */
  async bulkAdd(owner, id, payloads) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const wasEmpty = t.rows.length === 0;
    let added = 0;
    let skipped = 0;
    for (const p of payloads || []) {
      const row = { id: 'row_' + uid(10), createdAt: nowISO(), values: {} };
      let fail = false;
      for (const col of t.columns) {
        if (col.type === 'formula') continue;
        const raw = p.values && p.values[col.id] !== undefined ? p.values[col.id] : col.options.defaultValue;
        const v = coerceValue(col.type, col.subtype, raw);
        if (v === null && col.options.required && col.type !== 'boolean') { fail = true; break; }
        try { validateNumberConstraint(col.type, v, col.options); } catch (e) { fail = true; break; }
        row.values[col.id] = v;
      }
      if (fail) { skipped++; continue; }
      t.rows.push(row);
      added++;
    }
    await writeTable(t);
    // Import into a fresh shell → auto-save its starter chart.
    if (wasEmpty && added > 0) maybeStarterChart(t);
    return { added, skipped };
  },

  async removeRows(owner, id, rowIds) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const set = new Set(rowIds);
    const before = t.rows.length;
    t.rows = t.rows.filter((r) => !set.has(r.id));
    await writeTable(t);
    return { ok: true, removed: before - t.rows.length };
  },

  // -- linked / snapshot extraction ----------------------------------
  /** Create a new table from a row/column subset of an existing one. */
  async extract(owner, { name, description = '', sourceTableId, mode = 'copy', rowIds = null, columnIds = null }) {
    const src = await readTable(sourceTableId);
    if (src.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const rowSet = rowIds ? new Set(rowIds) : null;
    const colSet = columnIds ? new Set(columnIds) : null;
    const cols = colSet ? src.columns.filter((c) => colSet.has(c.id)) : src.columns;
    const rows = rowSet ? src.rows.filter((r) => rowSet.has(r.id)) : src.rows;
    if (!cols.length) throw new HttpError(400, 'No columns selected');
    if (mode === 'linked') {
      const t = {
        id: 'tbl_' + uid(10),
        ownerId: owner,
        name: String(name || `${src.name} view`).trim().slice(0, 120),
        description: String(description || '').slice(0, 500),
        kind: 'linked',
        color: src.color || randomColor(),
        icon: src.icon || null,
        createdAt: nowISO(),
        updatedAt: nowISO(),
        archived: false,
        columns: [], rows: [], summaries: [],
        link: { sourceTableId, rowIds: rows.map((r) => r.id), columnIds: cols.map((c) => c.id) },
      };
      fs.mkdirSync(path.join(FILES_DIR, t.id), { recursive: true });
      await writeTable(t);
      return resolveTable(t);
    }
    // snapshot copy
    const copy = {
      id: 'tbl_' + uid(10),
      ownerId: owner,
      name: String(name || `${src.name} extract`).trim().slice(0, 120),
      description: String(description || '').slice(0, 500),
      kind: 'table',
      color: randomColor(),
      icon: src.icon || null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      archived: false,
      columns: cols.map((c) => JSON.parse(JSON.stringify(c))),
      rows: [],
      summaries: [],
    };
    // Reuse the original column ids for the snapshot so formulas & data carry over.
    for (const r of rows) {
      const nr = { id: 'row_' + uid(10), createdAt: nowISO(), values: {} };
      for (const c of cols) {
        if (c.type === 'formula') continue;
        if (r.values[c.id] !== undefined) nr.values[c.id] = JSON.parse(JSON.stringify(r.values[c.id]));
      }
      copy.rows.push(nr);
    }
    fs.mkdirSync(path.join(FILES_DIR, copy.id), { recursive: true });
    await writeTable(copy);
    maybeStarterChart(copy);
    return copy;
  },

  /** Convert a linked table into a detached snapshot. */
  async detach(owner, id) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    if (t.kind !== 'linked') return t;
    const resolved = await resolveTable(t);
    const copy = {
      id: t.id, ownerId: owner, name: t.name, description: t.description,
      kind: 'table', color: t.color || randomColor(), icon: t.icon || null,
      createdAt: t.createdAt, updatedAt: nowISO(), archived: false,
      columns: resolved.columns.map((c) => JSON.parse(JSON.stringify(c))),
      rows: resolved.rows.map((r) => ({ id: 'row_' + uid(10), createdAt: r.createdAt, values: { ...r.values } })),
      summaries: [],
    };
    await writeTable(copy);
    return copy;
  },

  async summaries(owner, id, summaryList) {
    const t = await readTable(id);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    const valid = ['sum', 'avg', 'min', 'max', 'count', 'counta'];
    t.summaries = (Array.isArray(summaryList) ? summaryList : [])
      .filter((s) => s && valid.includes(s.func) && t.columns.some((c) => c.id === s.columnId))
      .map((s) => ({ columnId: s.columnId, func: s.func }));
    await writeTable(t);
    return { ok: true };
  },

  // -- uploaded files (images / attachments) -------------------------
  async saveFile(owner, tableId, { filename, data, mime = 'application/octet-stream' }) {
    const t = await readTable(tableId);
    if (t.ownerId !== owner) throw new HttpError(403, 'Forbidden');
    if (!data) throw new HttpError(400, 'No file data supplied');
    const buf = Buffer.from(data, 'base64');
    if (buf.length > 20 * 1024 * 1024) throw new HttpError(413, 'File exceeds the 20 MB limit');
    const ext = path.extname(filename || '').slice(0, 10).toLowerCase();
    const storedName = `${Date.now().toString(36)}_${sanitizeName(path.basename(filename || 'file', ext), 'file')}${ext}`;
    const dir = path.join(FILES_DIR, tableId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, storedName), buf);
    return { url: `/uploads/${tableId}/${storedName}`, name: String(filename || storedName), size: buf.length, mime };
  },
};

/* ------------------------------------------------------------------ */
/* Chart configurations (saved chart builder settings)                */
/* ------------------------------------------------------------------ */

function loadCharts() {
  if (!fs.existsSync(CHARTS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CHARTS_FILE, 'utf8')); } catch (e) { return []; }
}
function saveCharts(charts) {
  fs.writeFileSync(CHARTS_FILE, JSON.stringify(charts, null, 2));
}

const chartStore = {
  list(owner) {
    return loadCharts().filter((c) => c.owner === owner).sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  },
  get(owner, id) {
    const c = loadCharts().find((x) => x.id === id && x.owner === owner);
    if (!c) throw new HttpError(404, 'Chart not found');
    return c;
  },
  save(owner, { id, name, config }) {
    const charts = loadCharts();
    const now = nowISO();
    if (id) {
      const c = charts.find((x) => x.id === id && x.owner === owner);
      if (!c) throw new HttpError(404, 'Chart not found');
      Object.assign(c, { name: String(name || c.name).slice(0, 120), config, updatedAt: now });
      saveCharts(charts);
      return c;
    }
    const c = { id: 'ch_' + uid(9), owner, name: String(name || 'Untitled chart').slice(0, 120), config, createdAt: now, updatedAt: now };
    charts.push(c);
    saveCharts(charts);
    return c;
  },
  remove(owner, id) {
    saveCharts(loadCharts().filter((x) => !(x.id === id && x.owner === owner)));
    return { ok: true };
  },
};

module.exports = { store, chartStore, HttpError, TYPES, coerceValue, coerceFraction };
