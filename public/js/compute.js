/**
 * Formula recalculation + column summaries (browser side).
 * The engine itself lives in /js/formula.js -> window.DataForgeFx (UMD),
 * shared with the Node server so exports evaluate identically.
 */
import { fmtNum } from './util.js';

const Fx = window.DataForgeFx;

/** Convert a stored raw value into an engine-friendly value. */
export function valueForFx(col, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (col.type) {
    case 'number': case 'currency': return raw;
    case 'fraction': return raw && raw.d ? raw.n / raw.d : raw.n;
    case 'boolean': return !!raw;
    case 'dropdown': return raw; // string or string[]
    default: return raw; // text / date / time / datetime stay strings
  }
}

/** Build a formula evaluation context for one row. */
export function rowContext(table, row) {
  const byName = new Map();
  for (const c of table.columns || []) byName.set(c.name.toLowerCase(), c);
  return {
    getValue(name) {
      const col = byName.get(String(name).toLowerCase());
      if (!col) return undefined;
      return valueForFx(col, row.values ? row.values[col.id] : null);
    },
  };
}

/** Result shape for each formula column in a row: { [colId]: { ok, v, err } } */
export function evalRow(table, row) {
  const out = {};
  for (const col of table.columns || []) {
    if (col.type !== 'formula') continue;
    const expr = (col.options && col.options.formula) || '';
    const compiled = Fx.compile(expr);
    if (!compiled.ok) {
      out[col.id] = { err: compiled.error || 'Invalid formula', v: null };
      continue;
    }
    const v = compiled.run(rowContext(table, row));
    if (v && v.error) out[col.id] = { err: String(v.error).replace(/^#/, ''), v: null };
    else out[col.id] = { ok: true, v };
  }
  return out;
}

/** Pre-compile every formula column once (cheaper than compiling per row). */
export function compileFormulas(table) {
  const list = [];
  for (const col of table.columns || []) {
    if (col.type !== 'formula') continue;
    const expr = (col.options && col.options.formula) || '';
    const c = Fx.compile(expr);
    list.push({ col, expr, compiled: c.ok ? c.run : null, parseError: c.ok ? null : c.error });
  }
  return list;
}

export function evalRowWith(list, table, row) {
  const out = {};
  const ctx = rowContext(table, row);
  for (const f of list) {
    if (f.parseError) { out[f.col.id] = { err: f.parseError, v: null }; continue; }
    const v = f.compiled(ctx);
    out[f.col.id] = v && v.error ? { err: String(v.error).replace(/^#/, ''), v: null } : { ok: true, v };
  }
  return out;
}

/** Human string for a computed formula result. */
export function formulaText(res) {
  if (!res) return '';
  if (res.err) return `#${res.err}`;
  const v = res.v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return fmtNum(v, 8);
  return String(v);
}

/* ------------------------------ summaries --------------------------- */

const SUMMARY_LABELS = { sum: 'Sum', avg: 'Avg', min: 'Min', max: 'Max', count: 'Count', counta: 'Non-empty' };

function numericCol(col) {
  return ['number', 'currency'].includes(col.type);
}

function colRawValues(table, colId) {
  const col = (table.columns || []).find((c) => c.id === colId);
  if (col && col.type === 'formula') {
    // Formula columns: evaluate the formula for each row
    const compiled = compileFormulas(table);
    return (table.rows || []).map((r) => {
      const res = evalRowWith(compiled, table, r)[colId];
      if (!res || res.err) return null;
      return res.v;
    }).filter((v) => v !== null && v !== undefined && v !== '');
  }
  return (table.rows || []).map((r) => r.values && r.values[colId]).filter((v) => v !== null && v !== undefined && v !== '');
}

function colNumeric(table, colId) {
  return colRawValues(table, colId).map((v) => (typeof v === 'number' ? v : Number(v))).filter((v) => isFinite(v));
}

/** Numeric / count summary value for a column+func. Returns text. */
export function summarizeCol(table, col, func) {
  const vals = colRawValues(table, col.id);
  switch (func) {
    // Excel-style: COUNT counts numeric values, COUNTA counts non-empty cells.
    case 'count': return String(colNumeric(table, col.id).length);
    case 'counta': return String(vals.length);
    case 'sum': {
      const nums = colNumeric(table, col.id);
      return nums.length ? nums.reduce((a, b) => a + b, 0) : '—';
    }
    case 'avg': {
      const nums = colNumeric(table, col.id);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : '—';
    }
    case 'min': {
      const nums = colNumeric(table, col.id);
      return nums.length ? Math.min(...nums) : '—';
    }
    case 'max': {
      const nums = colNumeric(table, col.id);
      return nums.length ? Math.max(...nums) : '—';
    }
    default: return '';
  }
}

/** Format a summary value for a column (currency-aware). */
export function formatSummary(col, rawVal) {
  if (rawVal === '—' || rawVal === null || rawVal === undefined) return '—';
  if (typeof rawVal === 'string') return rawVal;
  if (col.type === 'currency') {
    const sym = (col.options && col.options.symbol) || '$';
    return `${sym}${Number(rawVal).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
  return fmtNum(rawVal, 6);
}

export function summaryLabel(f) {
  return SUMMARY_LABELS[f] || f;
}
