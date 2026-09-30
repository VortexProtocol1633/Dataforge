/**
 * Chart builder + renderer (Chart.js).
 *
 * A saved chart is a config JSON:
 *   { tableId, type, xColumn, yColumns:[colId], aggregate, stacked,
 *     title, xTitle, yTitle, showLegend }
 * Data is always read live from the table, so charts stay current.
 */
import { api } from '../api.js';
import { icon } from '../icons.js';
import { h, esc, modal, toast, downloadDataUrl } from '../util.js';
import compute from '../compute-shim.js';
import { isDarkTheme } from '../theme.js';

const Fx = window.DataForgeFx;

export const CHART_TYPES = [
  { id: 'bar', label: 'Bar' },
  { id: 'stacked', label: 'Stacked bar' },
  { id: 'line', label: 'Line' },
  { id: 'pie', label: 'Pie' },
  { id: 'doughnut', label: 'Donut' },
  { id: 'scatter', label: 'Scatter' },
  { id: 'radar', label: 'Radar' },
];

/**
 * Legacy 'area' charts (removed as a pickable type) still open and render —
 * they are mapped to a filled line chart.
 */
export function chartTypeLabel(id) {
  const t = CHART_TYPES.find((x) => x.id === id);
  if (t) return t.label;
  if (id === 'area') return 'Line (filled)';
  return String(id || '').replace(/^\w/, (m) => m.toUpperCase());
}

export const AGGREGATES = [
  { id: 'none', label: 'Raw values' },
  { id: 'count', label: 'Count rows' },
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
  { id: 'min', label: 'Min' },
  { id: 'max', label: 'Max' },
];

const PALETTE = ['#6366f1', '#8b5cf6', '#2dd4bf', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#a855f7'];

/** Resolve a theme CSS variable to a concrete color (canvas can't read CSS vars). */
function cssVar(name) {
  try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined; } catch { return undefined; }
}

/**
 * Full numeric window of a chart's axes, derived from the built data so zoom
 * never depends on layout timing. Category x = 0..labels-1; scatter x is the
 * point range. Returns null when there is nothing to zoom.
 */
function fullDataRanges(cfg, data) {
  const yVals = [];
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const ds of (data && data.datasets) || []) {
    for (const v of ds.data || []) {
      if (cfg.type === 'scatter' && v && typeof v === 'object') {
        if (isFinite(v.x)) { xMin = Math.min(xMin, v.x); xMax = Math.max(xMax, v.x); }
        if (isFinite(v.y)) yVals.push(v.y);
      } else if (typeof v === 'number' && isFinite(v)) {
        yVals.push(v);
      }
    }
  }
  const isCategoryX = cfg.type !== 'scatter';
  if (isCategoryX) {
    xMin = 0;
    xMax = Math.max(0, ((data && data.labels) || []).length - 1);
  }
  if (!isFinite(xMin) || !isFinite(xMax)) xMin = 0, xMax = 1;
  if (xMax - xMin < 1e-9) { xMin -= 1; xMax += 1; }
  let yMin = yVals.length ? Math.min(...yVals) : 0;
  let yMax = yVals.length ? Math.max(...yVals) : 1;
  if (['bar', 'stacked'].includes(cfg.type)) yMin = Math.min(yMin, 0);
  if (!isFinite(yMin) || !isFinite(yMax)) yMin = 0, yMax = 1;
  if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
  return { xMin, xMax, yMin, yMax };
}

/** Resolve a column's numeric value for a row (computed formula columns included). */
function numericOf(table, row, col, fxCache) {
  if (col.type === 'formula') {
    const res = fxCache.get(row.id) && fxCache.get(row.id)[col.id];
    if (res && res.ok && typeof res.v === 'number') return res.v;
    return NaN;
  }
  const v = row.values && row.values[col.id];
  const n = typeof v === 'number' ? v : Number(v);
  return isFinite(n) ? n : NaN;
}

function labelOf(col, v) {
  if (v === null || v === undefined || v === '') return '(empty)';
  if (col.type === 'boolean') return v ? 'Yes' : 'No';
  if (col.type === 'dropdown' && Array.isArray(v)) return v.join(', ');
  if (col.type === 'fraction' && v && typeof v === 'object') return `${v.n}/${v.d}`;
  return String(v);
}

/** Build { labels, datasets } for a table + config. */
export function buildData(table, cfg) {
  const cols = table.columns || [];
  const col = (id) => cols.find((c) => c.id === id);
  // Map keyed by row id — numericOf() calls fxCache.get() for formula columns.
  const fx = new Map();
  for (const row of table.rows || []) fx.set(row.id, compute.evalRow(table, row));

  const x = col(cfg.xColumn);
  const ys = (cfg.yColumns || []).map(col).filter(Boolean);
  const y0 = col(cfg.yColumn);
  if (y0 && !ys.length) ys.push(y0);
  const agg = cfg.aggregate || (cfg.type === 'scatter' ? 'none' : 'count');
  const rows = table.rows || [];

  if (cfg.type === 'scatter') {
    const ycol = ys[0];
    const xcol = x;
    if (!xcol || !ycol) return { labels: [], datasets: [] };
    const pts = rows
      .map((r) => ({ x: numericOf(table, r, xcol, fx), y: numericOf(table, r, ycol, fx) }))
      .filter((p) => isFinite(p.x) && isFinite(p.y));
    return {
      labels: [],
      datasets: [{
        label: `${cfg.yTitle || ycol.name}`,
        data: pts,
        backgroundColor: PALETTE[0],
      }],
    };
  }

  // group rows by distinct values of the x column
  const groups = new Map(); // label -> rows[]
  for (const r of rows) {
    const label = x ? labelOf(x, r.values && r.values[x.id]) : '(all)';
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(r);
  }
  const labels = [...groups.keys()];
  const sortNumeric = x && ['number', 'currency'].includes(x.type);
  if (sortNumeric) labels.sort((a, b) => Number(a) - Number(b));
  const countOf = (g) => g.length;
  const numericOfGroup = (g, c) => {
    const vals = g.map((r) => numericOf(table, r, c, fx)).filter((v) => isFinite(v));
    if (!vals.length) return NaN;
    if (agg === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (agg === 'avg') return vals.reduce((a, b) => a + b, 0) / vals.length;
    if (agg === 'min') return Math.min(...vals);
    if (agg === 'max') return Math.max(...vals);
    return vals[0];
  };

  const isPieLike = ['pie', 'doughnut', 'radar'].includes(cfg.type);
  const datasets = [];

  if (agg === 'count' || !ys.length) {
    datasets.push({
      label: cfg.yTitle || 'Count',
      data: labels.map((l) => countOf(groups.get(l))),
      backgroundColor: isPieLike ? PALETTE : PALETTE.map((c) => c + 'cc'),
      borderColor: PALETTE.map((c) => c),
      borderWidth: 1,
    });
  } else if (isPieLike) {
    const c = ys[0];
    datasets.push({
      label: cfg.yTitle || (c ? c.name : 'Value'),
      data: labels.map((l) => numericOfGroup(groups.get(l), c)),
      backgroundColor: PALETTE,
      borderColor: PALETTE,
      borderWidth: 1,
    });
  } else {
    for (const c of ys) {
      datasets.push({
        label: cfg.yTitle && ys.length === 1 ? cfg.yTitle : c.name,
        data: labels.map((l) => numericOfGroup(groups.get(l), c)),
        backgroundColor: PALETTE[ys.indexOf(c) % PALETTE.length] + (['bar', 'stacked', 'area'].includes(cfg.type) ? 'cc' : ''),
        borderColor: PALETTE[ys.indexOf(c) % PALETTE.length],
        borderWidth: 2,
        fill: cfg.type === 'area',
        pointRadius: cfg.type === 'line' || cfg.type === 'area' ? 2.5 : undefined,
        tension: cfg.type === 'line' || cfg.type === 'area' ? 0.3 : undefined,
        borderRadius: cfg.type === 'bar' || cfg.type === 'stacked' ? 6 : undefined,
      });
    }
  }
  return { labels, datasets };
}

export function chartOptions(cfg, zoom) {
  const stacked = cfg.type === 'stacked';
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
      title: {
        display: !!cfg.title,
        text: cfg.title || '',
        color: cssVar('--text'),
        font: { family: 'Inter', size: 15, weight: '600' },
        padding: { bottom: 14 },
      },
      legend: {
        display: cfg.showLegend !== false,
        position: 'bottom',
        labels: { usePointStyle: true, boxWidth: 8, color: cssVar('--text') || '#1e1b4b', font: { family: 'Inter', size: 12 } },
        onClick: (e, li, legend) => {
          // toggle dataset visibility
          const ci = legend.chart;
          const idx = li.datasetIndex;
          const meta = ci.getDatasetMeta(idx);
          meta.hidden = meta.hidden === false ? true : false;
          ci.update();
        },
      },
      tooltip: {
        backgroundColor: 'rgba(15,18,45,.9)',
        padding: 10,
        cornerRadius: 10,
        titleFont: { family: 'Inter' },
        bodyFont: { family: 'Inter' },
      },
    },
    scales: {},
  };
  if (!['pie', 'doughnut', 'radar'].includes(cfg.type)) {
    base.scales = {
      x: {
        grid: { display: false },
        ticks: { color: cssVar('--text-3') || '#7c86a6' },
        title: { display: !!cfg.xTitle, text: cfg.xTitle || '' },
        ...(zoom ? { min: zoom.xMin, max: zoom.xMax } : {}),
      },
      y: {
        beginAtZero: ['bar', 'stacked'].includes(cfg.type),
        grid: { color: cssVar('--hairline') || 'rgba(23,28,66,.08)' },
        ticks: { color: cssVar('--text-3') || '#7c86a6' },
        title: { display: !!cfg.yTitle, text: cfg.yTitle || '' },
        stacked,
        ...(zoom ? { min: zoom.yMin, max: zoom.yMax } : {}),
      },
    };
  }
  return base;
}

/* ------------------------------- UI --------------------------------- */

export function openBuilder({ table, saved = null, onSaved } = {}) {
  const m = modal({
    wide: true, tall: true, scroll: true, locked: true,
    title: saved ? saved.name || 'Chart' : 'Chart builder',
    sub: table ? `Live data from “${table.name}”` : 'Pick a table, then shape the query.',
  });
  m.panel.style.width = 'min(96vw, 1180px)';
  let cfg = saved ? { ...saved.config } : null;
  // The Area type was removed — reopen any legacy saved chart as a filled line.
  if (cfg && cfg.type === 'area') cfg.type = 'line';

  const state = {
    table,
    tables: null,
    chart: null,
    cfg: cfg || defaultConfig(table),
    tableId: table ? table.id : null,
    zoom: null,     // { xMin, xMax, yMin, yMax } — absolute axis window
    zoomFull: null, // full-range window captured on render
  };

  const refreshChart = () => {
    if (!state.chart) return;
    state.chart.data = buildData(state.table, state.cfg);
    state.chart.options = chartOptions(state.cfg, state.zoom);
    state.chart.update();
  };

  const build = () => {
    // Tear down the previous chart before rebuilding — otherwise every
    // config change leaks a Chart.js instance (plus its ResizeObserver).
    if (state.chart) { try { state.chart.destroy(); } catch { /* ignore */ } state.chart = null; }
    state.zoom = null;
    state.zoomFull = null;
    m.body.innerHTML = '';
    m.body.append(renderLayout(state));
  };

  const renderLayout = (st) => {
    const wrap = h('div', { class: 'builder-cols' });

    // ---------- left: controls ----------
    const controls = h('div', { class: 'left' });

    if (!st.table) {
      const loadTables = async (sel) => {
        try {
          const { tables } = await api.listTables();
          sel.innerHTML = `<option value="">Choose a table…</option>${tables.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}`;
        } catch (e) { toast(e.message, 'err'); }
      };
      // chart-type chips: pick a type up front; it is applied once a table is chosen
      const chipRow = h('div', { class: 'seg' });
      for (const ct of CHART_TYPES) {
        const b = h('button', {
          type: 'button',
          class: pendingType === ct.id ? 'active' : '',
          text: ct.label,
          onclick: () => {
            pendingType = ct.id;
            chipRow.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
            b.classList.add('active');
          },
        });
        chipRow.append(b);
      }
      const tableSel = h('select', { onchange: async (e) => {
        const t = await api.getTable(e.target.value).then((d) => d.table).catch(() => null);
        if (t) {
          st.table = t;
          st.tableId = t.id;
          const base = defaultConfig(t);
          st.cfg = pendingType ? { ...base, type: pendingType } : base;
          if (st.cfg.type === 'scatter') {
            const num = (t.columns || []).filter((c) => ['number', 'currency', 'formula'].includes(c.type));
            st.cfg.xColumn = num[0] && num[0].id;
            st.cfg.yColumns = [num[1] || num[0]].filter(Boolean).map((c) => c.id);
            st.cfg.aggregate = 'none';
          }
          build();
        }
      } });
      controls.append(
        h('div', { class: 'field' }, h('label', { text: 'Table' }), tableSel),
        h('div', { class: 'field' }, h('label', { text: 'Chart type' }), chipRow),
      );
      loadTables(tableSel);
      return finishCol(wrap, controls, st, m, build, onSaved, saved);
    }

    const t = st.table;
    const cols = t.columns || [];
    const xOptions = () => cols.map((c) => `<option value="${c.id}" ${st.cfg.xColumn === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const yOptions = (excludeId) => cols
      .filter((c) => ['number', 'currency', 'formula'].includes(c.type))
      .filter((c) => !excludeId || c.id !== excludeId)
      .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const aggDefault = st.cfg.aggregate || 'count';

    const typeSel = h('select', { onchange: (e) => {
      st.cfg.type = e.target.value;
      if (e.target.value === 'scatter') {
        const num = cols.filter((c) => ['number', 'currency', 'formula'].includes(c.type));
        st.cfg.xColumn = num[0] && num[0].id; st.cfg.yColumns = [num[1] || num[0]].filter(Boolean).map((c) => c.id);
        st.cfg.aggregate = 'none';
      }
      build();
    } });
    typeSel.innerHTML = CHART_TYPES.map((t2) => `<option value="${t2.id}" ${st.cfg.type === t2.id ? 'selected' : ''}>${t2.label}</option>`).join('');

    const controlsInner = [
      h('div', { class: 'field' }, h('label', { text: 'Chart type' }), typeSel),
      h('div', { class: 'field' }, h('label', { text: 'Chart title' }),
        h('input', { type: 'text', value: st.cfg.title || '', placeholder: 'e.g. Sales by region (optional)', oninput: (e) => { st.cfg.title = e.target.value; refreshChart(); } })),
      h('div', { class: 'field' }, h('p', { class: 'muted', style: { fontSize: '11.5px', margin: '0 0 4px' }, text: 'Select the X-axis column to group data by, then pick value columns and aggregation.' })),
    ];

    if (st.cfg.type === 'scatter') {
      const xSel = h('select', { onchange: (e) => { st.cfg.xColumn = e.target.value; } });
      const ySel = h('select', { onchange: (e) => { st.cfg.yColumns = [e.target.value]; } });
      xSel.innerHTML = cols.filter((c) => ['number', 'currency', 'formula'].includes(c.type)).map((c) => `<option value="${c.id}" ${st.cfg.xColumn === c.id ? 'selected' : ''}>${esc(c.name)} (X)</option>`).join('');
      ySel.innerHTML = cols.filter((c) => ['number', 'currency', 'formula'].includes(c.type)).map((c) => `<option value="${c.id}" ${(st.cfg.yColumns || [])[0] === c.id ? 'selected' : ''}>${esc(c.name)} (Y)</option>`).join('');
      controlsInner.push(
        h('div', { class: 'field' }, h('label', { text: 'X — numeric' }), xSel),
        h('div', { class: 'field' }, h('label', { text: 'Y — numeric' }), ySel),
      );
      xSel.addEventListener('change', refreshChart);
      ySel.addEventListener('change', refreshChart);
    } else {
      if (cols.length) {
        const xSel = h('select', { onchange: (e) => { st.cfg.xColumn = e.target.value; refreshChart(); }, html: xOptions() });
        controlsInner.push(h('div', { class: 'field' }, h('label', { text: 'X-axis — group by (labels)' }), h('p', { class: 'muted', style: { fontSize: '11px', margin: '-3px 0 2px' }, text: 'Choose a text, dropdown, or category column' }), xSel));
      }

      const aggField = h('div', { class: 'field' }, h('label', { text: 'Y-axis aggregation' }), h('p', { class: 'muted', style: { fontSize: '11px', margin: '-3px 0 2px' }, text: 'How to combine values in each group' }), (() => {
        const s = h('select', { onchange: (e) => { st.cfg.aggregate = e.target.value; build(); } });
        s.innerHTML = AGGREGATES.map((a) => `<option value="${a.id}" ${aggDefault === a.id ? 'selected' : ''}>${a.label}</option>`).join('');
        return s;
      })());

      const isPie = ['pie', 'doughnut', 'radar'].includes(st.cfg.type);
      if (isPie) {
        const ySel = h('select', { onchange: (e) => { st.cfg.yColumns = [e.target.value]; refreshChart(); } });
        ySel.innerHTML = `<option value="">— count rows —</option>${yOptions()}`;
        ySel.value = (st.cfg.yColumns || [])[0] || '';
        controlsInner.push(
          h('div', { class: 'field' }, h('label', { text: 'Value column' }), ySel),
          aggField,
        );
      } else {
        const ySel = h('select', { multiple: true, size: Math.min(6, Math.max(2, yOptions().length ? 3 : 1)), onchange: (e) => {
          st.cfg.yColumns = [...e.target.selectedOptions].map((o) => o.value);
          refreshChart();
        } });
        ySel.innerHTML = yOptions();
        const chosen = new Set(st.cfg.yColumns || []);
        [...ySel.options].forEach((o) => { if (chosen.has(o.value)) o.selected = true; });
        controlsInner.push(
          h('div', { class: 'field' }, h('label', { text: 'Y-axis — value columns' }), h('p', { class: 'muted', style: { fontSize: '11px', margin: '-3px 0 2px' }, text: 'Hold Ctrl/Cmd to select multiple numeric columns' }), ySel),
          aggField,
          h('label', { class: 'check-row' },
            h('input', { type: 'checkbox', checked: st.cfg.stacked || st.cfg.type === 'stacked', onchange: (e) => { st.cfg.stacked = e.target.checked; refreshChart(); } }),
            h('span', { text: 'Stack series' })),
        );
      }
    }
    controlsInner.push(
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' } },
        h('div', { class: 'field' }, h('label', { text: 'X label' }), h('input', { type: 'text', value: st.cfg.xTitle || '', oninput: (e) => { st.cfg.xTitle = e.target.value; refreshChart(); } })),
        h('div', { class: 'field' }, h('label', { text: 'Y label' }), h('input', { type: 'text', value: st.cfg.yTitle || '', oninput: (e) => { st.cfg.yTitle = e.target.value; refreshChart(); } })),
      ),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: st.cfg.showLegend !== false, onchange: (e) => { st.cfg.showLegend = e.target.checked; refreshChart(); } }),
        h('span', { text: 'Show legend' })),
    );
    controls.append(...controlsInner);
    return finishCol(wrap, controls, st, m, build, onSaved, saved);
  };

  let pendingType = null; // chart type picked before a table is selected

  const finishCol = (wrap, controls, st, modalRef, rebuild, onSavedCb, savedCfg) => {
    // ---------- right: canvas ----------
    const right = h('div', { class: 'chart-tools' });
    if (!st.table) {
      // no table chosen yet — nothing to query or render
      right.append(h('div', { class: 'chart-canvasbox glass', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '260px', color: 'var(--text-2)' } },
        h('p', { text: 'Choose a table on the left to start building the chart.' })));
      wrap.append(controls, right);
      return wrap;
    }
    if (!(st.table.columns || []).length) {
      // table exists but has no columns — nothing to group or plot yet
      right.append(h('div', { class: 'chart-canvasbox glass', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '260px', color: 'var(--text-2)' } },
        h('p', { text: 'This table has no columns yet — add a column first, then build a chart.' })));
      wrap.append(controls, right);
      return wrap;
    }
    const box = h('div', { class: 'chart-canvasbox glass' });
    const canvas = h('canvas');
    box.append(canvas);
    const isCartesian = !['pie', 'doughnut', 'radar'].includes(st.cfg.type);
    const opts = chartOptions(st.cfg, st.zoom);
    const data = buildData(st.table, st.cfg);
    st.chart = new window.Chart(canvas, { type: st.cfg.type === 'stacked' ? 'bar' : st.cfg.type, data, options: opts });

    // ---- per-chart zoom: buttons + mouse wheel inside the figure box ----
    if (isCartesian) {
      // Full axis window derived from the data (layout-independent — the chart
      // may still be off-DOM when it is created, so scale.min/max are unreliable).
      st.zoomFull = fullDataRanges(st.cfg, data);
      const applyZoom = (factor) => {
        const full = st.zoomFull;
        if (!full) return;
        // grow/shrink the CURRENT window around its centre so zooming back out
        // widens it again (an all-data window is `null`)
        const cur = st.zoom || full;
        const grow = (lo, hi, f) => {
          const span = (hi - lo) * f;
          const mid = (lo + hi) / 2;
          return { min: mid - span / 2, max: mid + span / 2 };
        };
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
        let nx = grow(cur.xMin, cur.xMax, factor);
        let ny = grow(cur.yMin, cur.yMax, factor);
        // integer-snap category x so whole bars stay visible
        if (st.cfg.type !== 'scatter') {
          nx.min = Math.round(nx.min);
          nx.max = Math.round(nx.max);
        }
        nx.min = clamp(nx.min, full.xMin, full.xMax);
        nx.max = clamp(nx.max, full.xMin, full.xMax);
        ny.min = clamp(ny.min, full.yMin, full.yMax);
        ny.max = clamp(ny.max, full.yMin, full.yMax);
        if (nx.max - nx.min < 1e-6 || ny.max - ny.min < 1e-6) return;
        const zoomedOut = nx.min <= full.xMin + 1e-6 && nx.max >= full.xMax - 1e-6
          && ny.min <= full.yMin + 1e-6 && ny.max >= full.yMax - 1e-6;
        st.zoom = zoomedOut ? null : { xMin: nx.min, xMax: nx.max, yMin: ny.min, yMax: ny.max };
        st.chart.options = chartOptions(st.cfg, st.zoom);
        st.chart.update();
      };
      const zoomIn = () => applyZoom(0.7);
      const zoomOut = () => applyZoom(1.4);
      const zoomReset = () => {
        st.zoom = null;
        st.chart.options = chartOptions(st.cfg, null);
        st.chart.update();
      };
      const zoomWrap = h('div', { class: 'chart-zoom', role: 'group', 'aria-label': 'Chart zoom controls' },
        h('span', { class: 'zlbl', text: 'Zoom' }),
        h('button', { type: 'button', text: '−', title: 'Zoom out', 'aria-label': 'Zoom out the chart', onclick: zoomOut }),
        h('button', { type: 'button', text: '+', title: 'Zoom in', 'aria-label': 'Zoom in the chart', onclick: zoomIn }),
        h('span', { class: 'zsep' }),
        h('button', { type: 'button', text: '↺', title: 'Reset zoom', 'aria-label': 'Reset chart zoom', onclick: zoomReset }),
      );
      box.append(zoomWrap);
      // wheel zoom (over the figure box; Ctrl not required)
      box.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.deltaY < 0) zoomIn(); else zoomOut();
      }, { passive: false });
    }

    const info = h('div', { class: 'muted', style: { fontSize: '12px' } },
      `${(st.table.rows || []).length} rows · ${data.labels.length} group${data.labels.length === 1 ? '' : 's'}`);
    const saveBtn = h('button', { class: 'btn primary sm', text: savedCfg ? 'Update saved chart' : 'Save chart' });
    const exportPng = h('button', { class: 'btn sm', html: `${icon('download', 14)} PNG` });
    const exportJpg = h('button', { class: 'btn sm', html: `${icon('download', 14)} JPG` });
    const nameInput = h('input', { type: 'text', placeholder: 'Chart name', value: (savedCfg && savedCfg.name) || st.cfg.title || 'Untitled chart' });

    right.append(
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', width: '100%', marginBottom: '10px' } },
        h('div', { class: 'field', style: { margin: 0, flex: '1 1 180px' } }, nameInput),
        saveBtn,
        exportPng,
        exportJpg,
      ),
      info,
      box,
    );

    const doSave = async () => {
      saveBtn.disabled = true;
      try {
        const payload = { name: nameInput.value.trim() || 'Untitled chart', config: { ...st.cfg, tableId: st.table.id, title: st.cfg.title || nameInput.value.trim() || undefined } };
        const res = await api.saveChart(payload);
        toast(savedCfg ? 'Chart updated' : 'Chart saved', 'ok');
        if (onSavedCb) onSavedCb(res.chart);
        modalRef.close();
      } catch (e) { toast(e.message, 'err'); saveBtn.disabled = false; }
    };
    saveBtn.addEventListener('click', doSave);

    const doExport = async (fmt) => {
      // Force a re-render so the canvas has correct dimensions
      st.chart.resize();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(canvas.width || 0, Math.round(canvas.offsetWidth * dpr), 800);
      const h = Math.max(canvas.height || 0, Math.round(canvas.offsetHeight * dpr), 500);
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d');
      ctx.fillStyle = isDarkTheme() ? (cssVar('--bg-base') || '#0f1330') : '#ffffff';
      ctx.fillRect(0, 0, off.width, off.height);
      ctx.drawImage(canvas, 0, 0, off.width, off.height);
      const dataUrl = off.toDataURL(mime, fmt === 'jpg' ? 0.92 : undefined);
      const base = String(dataUrl).split(',')[1];
      const fname = `${(nameInput.value.trim() || 'chart').replace(/[^\w\s-]/g, '').replace(/\s+/g, '_') || 'chart'}.${fmt}`;
      downloadDataUrl(dataUrl, fname);
      try { await api.saveChartImage({ name: fname.replace(/\.(png|jpg)$/, ''), format: fmt, data: base }); toast(`Exported ${fname}`, 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    exportPng.addEventListener('click', () => doExport('png'));
    exportJpg.addEventListener('click', () => doExport('jpg'));

    wrap.append(controls, right);
    return wrap;
  };

  // modal footer: done button (footer hidden, handled by locked close)
  m.foot.append(h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));
  build();
  return m;
}

function defaultConfig(table) {
  const cols = (table && table.columns) || [];
  const numeric = cols.filter((c) => ['number', 'currency', 'formula'].includes(c.type));
  const groupCol = cols.find((c) => ['dropdown', 'text'].includes(c.type) && c.type !== 'formula') || cols[0];
  const y = numeric[0];
  return {
    tableId: table ? table.id : null,
    type: 'bar',
    xColumn: groupCol ? groupCol.id : null,
    yColumns: y ? [y.id] : [],
    yColumn: y ? y.id : null,
    aggregate: y ? 'sum' : 'count',
    stacked: false,
    showLegend: true,
  };
}


