/**
 * Dashboard — lists every table as a glass card (searchable/filterable),
 * plus a Charts tab for saved chart configurations.
 */
import { api } from '../api.js';
import { icon } from '../icons.js';
import { h, el, modal, toast, confirmDialog, popMenu, timeAgo, debounce, loadingSection, errorSection, withTimeout } from '../util.js';
import { openImport } from '../components/importModal.js';
import { openBuilder, chartTypeLabel } from '../components/chartBuilder.js';
import { openTableAppearance, tableIcon } from '../components/tableAppearance.js';

const TABLE_COLORS = [
  { bg: 'rgba(99,102,241,.15)', border: 'rgba(99,102,241,.4)', icon: '#6366f1' },
  { bg: 'rgba(139,92,246,.15)', border: 'rgba(139,92,246,.4)', icon: '#8b5cf6' },
  { bg: 'rgba(45,212,191,.15)', border: 'rgba(45,212,191,.4)', icon: '#2dd4bf' },
  { bg: 'rgba(245,158,11,.15)', border: 'rgba(245,158,11,.4)', icon: '#f59e0b' },
  { bg: 'rgba(239,68,68,.15)', border: 'rgba(239,68,68,.4)', icon: '#ef4444' },
  { bg: 'rgba(6,182,212,.15)', border: 'rgba(6,182,212,.4)', icon: '#06b6d4' },
  { bg: 'rgba(236,72,153,.15)', border: 'rgba(236,72,153,.4)', icon: '#ec4899' },
  { bg: 'rgba(132,204,22,.15)', border: 'rgba(132,204,22,.4)', icon: '#84cc16' },
  { bg: 'rgba(249,115,22,.15)', border: 'rgba(249,115,22,.4)', icon: '#f97316' },
  { bg: 'rgba(168,85,247,.15)', border: 'rgba(168,85,247,.4)', icon: '#a855f7' },
];

function getTableColor(t) {
  if (t.color) return TABLE_COLORS.find((c) => c.icon === t.color) || TABLE_COLORS[0];
  // deterministic color from table id
  let hash = 0;
  const s = String(t.id || t.name || '');
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0; }
  return TABLE_COLORS[Math.abs(hash) % TABLE_COLORS.length];
}

export default async function render(content) {
  const isChartsTab = location.hash.startsWith('#/charts');
  content.innerHTML = '';
  content.append(loadingSection(isChartsTab ? 'Loading your charts…' : 'Loading your tables…'));

  let tables = [];
  // #/?archived=1 opens the dashboard on the Archived tab (used after
  // archiving from the table workspace so the table is visibly safe).
  let archivedOnly = (location.hash || '').includes('archived=1');
  let charts = [];

  try {
    // Load archived tables too: the Active/Archived tabs filter this list
    // client-side, so an archived table must never look "deleted".
    const [t, c] = await withTimeout(
      Promise.all([api.listTables({ includeArchived: true }), api.listCharts()]),
      15000,
      'The dashboard is taking too long to load — is the server running?',
    );
    tables = t.tables;
    charts = c.charts;
  } catch (e) {
    content.innerHTML = '';
    content.append(errorSection(e.message || String(e), () => render(content)));
    return;
  }
  content.innerHTML = '';

  const root = h('div', {});

  /* ---------------- header ---------------- */
  const head = h('div', { class: 'page-head' },
    h('div', { class: 'grow' },
      h('h1', { text: isChartsTab ? 'Charts' : 'Your tables' }),
      h('div', { class: 'sub', text: isChartsTab
        ? 'Saved chart configurations — data is read live from your tables.'
        : `${tables.length} table${tables.length === 1 ? '' : 's'} · each is an independent dataset with its own schema, formulas, forms and charts.` }),
    ),
  );

  if (isChartsTab) {
    // Charts are generated automatically once a table holds data (one starter
    // chart per table). Extra charts can still be added per-table from its
    // workspace toolbar → Chart.
    head.append(h('button', {
      class: 'btn', html: `${icon('grid', 15)} Go to tables`,
      onclick: () => { location.hash = '#/'; },
    }));
  } else {
    const searchWrap = h('div', { class: 'searchbox' },
      el(icon('search')),
      h('input', { type: 'search', placeholder: 'Search tables…' }),
    );
    head.append(searchWrap);
    head.append(h('button', { class: 'btn', html: `${icon('upload', 15)} Import`, onclick: () => openImport({ onCreated: () => location.reload() }) }));
    head.append(h('button', { class: 'btn primary', html: `${icon('plus', 15)} New table`, onclick: () => openNewTable() }));
  }

  /* ---------------- body ---------------- */
  const body = h('div', {});
  root.append(head, body);

  function visibleTables() {
    const archived = tables.filter((t) => t.archived);
    return archivedOnly ? archived : tables.filter((t) => !t.archived);
  }

  /** Temporary tables created in this tab (the data layer hides other tabs'). */
  function tempTables() { return tables.filter((t) => t.ephemeral); }

  /** Banner summarising this tab's temporary tables, with a one-click clear. */
  function tempBanner() {
    const tmp = tempTables();
    if (!tmp.length) return null;
    const rows = tmp.reduce((n, t) => n + (t.rowCount || 0), 0);
    return h('div', { class: 'linked-banner', role: 'status', style: { marginBottom: '16px' } },
      h('span', { class: 'lb-icon' }, el(icon('clock', 16))),
      h('div', { class: 'lb-text' },
        h('strong', { text: `${tmp.length} temporary table${tmp.length === 1 ? '' : 's'} in this tab` }),
        h('span', { class: 'muted', text: `${rows} row${rows === 1 ? '' : 's'} · stored only here and removed when you close the tab — export anything you want to keep.` }),
      ),
      h('div', { class: 'lb-actions' },
        h('button', { class: 'btn sm', text: 'Clear all now', onclick: clearTemporary }),
      ),
    );
  }

  async function clearTemporary() {
    const n = tempTables().length;
    const ok = await confirmDialog({
      title: 'Remove temporary tables?',
      message: `${n} temporary table${n === 1 ? '' : 's'} will be deleted from this tab. Export first if you need a copy.`,
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      const res = await api.clearEphemeral();
      const removed = res.removed || n;
      tables = (await api.listTables({ includeArchived: true })).tables;
      renderTables();
      toast(`${removed} temporary table${removed === 1 ? '' : 's'} removed`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function renderTables() {
    body.innerHTML = '';
    const list = visibleTables();
    const banner = tempBanner();
    if (banner) body.append(banner);
    const seg = h('div', { class: 'seg', style: { marginBottom: '16px' } },
      h('button', { class: archivedOnly ? '' : 'active', text: `Active (${tables.filter((t) => !t.archived).length})`, onclick: () => { archivedOnly = false; renderTables(); } }),
      h('button', { class: archivedOnly ? 'active' : '', text: `Archived (${tables.filter((t) => t.archived).length})`, onclick: () => { archivedOnly = true; renderTables(); } }),
    );
    body.append(seg);

    if (!list.length) {
      body.append(h('div', { class: 'empty' },
        h('div', { class: 'bigicon' }, '🗂️'),
        h('h3', { text: archivedOnly ? 'Nothing archived yet' : 'No tables yet' }),
        h('p', { text: archivedOnly ? 'Archive tables from their card menu to tidy the dashboard.' : 'Create a table to start collecting data with its own columns and types.' }),
        archivedOnly ? null : h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn primary', text: 'Create your first table', onclick: () => openNewTable() })),
      ));
      return;
    }

    const grid = h('div', { class: 'cardgrid' });
    for (const t of list) {
      grid.append(tableCard(t));
    }
    body.append(grid);
  }

  function tableCard(t) {
    const idx = tables.findIndex((x) => x.id === t.id);
    const tc = getTableColor(t);
    const menuBtn = h('button', { class: 'icon-btn', title: 'Table actions', 'aria-label': `Actions for table ${t.name}`, html: icon('more', 16) });
    const card = h('div', { class: 'tcard glass', role: 'button', tabindex: '0', 'aria-label': `Open table ${t.name}`, style: { animationDelay: `${Math.min(idx, 12) * 25}ms` } },
      h('div', { class: 'actions' }, menuBtn),
      h('div', { class: 'top' },
        h('div', { class: 'iconbox', style: { background: tc.bg, borderColor: tc.border, color: tc.icon } }, el(icon(tableIcon(t)))),
        h('h3', { text: t.name }),
      ),
      h('div', { class: 'desc', text: t.description || 'No description' }),
      h('div', { class: 'meta' },
        h('span', { class: 'chip', text: `${t.rowCount} rows` }),
        h('span', { class: 'chip gray', text: `${t.columnCount} columns` }),
        t.kind === 'linked' ? h('span', { class: 'chip teal', text: 'live view' }) : null,
        t.ephemeral ? h('span', { class: 'chip', title: 'Stored in this browser tab only — removed when you close it', text: 'temporary' }) : null,
        t.archived ? h('span', { class: 'chip amber', text: 'archived' }) : null,
      ),
      h('div', { class: 'time' }, `${timeAgo(t.updatedAt)} · ${t.columns.map((c) => c.type).slice(0, 3).join(' · ')}${t.columnCount > 3 ? '…' : ''}`),
    );
    card.addEventListener('click', (e) => {
      if (e.target.closest('.actions')) return;
      location.hash = `#/t/${t.id}`;
    });
    // keyboard access: the card behaves like a button (Enter / Space opens)
    card.addEventListener('keydown', (e) => {
      if (e.target.closest('.actions')) return; // don't hijack the menu button
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        location.hash = `#/t/${t.id}`;
      }
    });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popMenu(menuBtn, [
        { header: t.name },
        { label: 'Open table', icon: 'table', onClick: () => { location.hash = `#/t/${t.id}`; } },
        { label: 'Rename', icon: 'edit', onClick: () => openNewTable(t) },
        { label: 'Style & icon', icon: 'palette', onClick: () => openTableAppearance({ table: t, onApplied: async () => { try { tables = (await api.listTables({ includeArchived: true })).tables; } catch { /* ignore */ } renderTables(); } }) },
        { label: 'Duplicate', icon: 'copy', onClick: async () => {
          try { const res = await api.duplicateTable(t.id); tables.unshift(res.table); renderTables(); toast('Duplicated', 'ok'); }
          catch (err) { toast(err.message, 'err'); }
        } },
        { label: t.archived ? 'Unarchive' : 'Archive', icon: t.archived ? 'unarchive' : 'archive', onClick: async () => {
          try { await api.setArchived(t.id, !t.archived); tables = (await api.listTables({ includeArchived: true })).tables; renderTables(); }
          catch (err) { toast(err.message, 'err'); }
        } },
        { label: 'Open file location', icon: 'folder', onClick: async () => {
          try { await api.openFileLocation(t.id); toast('Opened the table file in your file manager', 'ok'); }
          catch (err) { toast(err.message, /browser mode/i.test(err.message) ? 'info' : 'err', 5000); }
        } },
        { sep: true },
        { header: 'Export' },
        { label: 'Excel (.xlsx)', icon: 'download', onClick: () => exportTable(t, 'xlsx') },
        { label: 'CSV (.csv)', icon: 'download', onClick: () => exportTable(t, 'csv') },
        { label: 'Word (.docx)', icon: 'download', onClick: () => exportTable(t, 'docx') },
        { sep: true },
        { label: 'Delete table', icon: 'trash', danger: true, onClick: async () => {
          const ok = await confirmDialog({ title: `Delete “${t.name}”?`, message: 'Permanently removes the table, rows and files.', confirmLabel: 'Delete' });
          if (!ok) return;
          try { await api.deleteTable(t.id); tables = tables.filter((x) => x.id !== t.id); renderTables(); toast('Deleted', 'ok'); }
          catch (err) { toast(err.message, 'err'); }
        } },
      ]);
    });
    return card;
  }

  /* ---------------- charts tab ---------------- */
  function renderCharts() {
    body.innerHTML = '';
    if (!charts.length) {
      body.append(h('div', { class: 'empty' },
        h('div', { class: 'bigicon' }, '📊'),
        h('h3', { text: 'No charts yet' }),
        h('p', { text: 'Every table gets a starter chart automatically once it has data. Open a table, add rows, and a chart appears here — or build a custom one from the table toolbar (Chart).' }),
        h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn primary', text: 'Browse your tables', onclick: () => { location.hash = '#/'; } })),
      ));
      return;
    }
    const grid = h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '12px' } });
    for (const c of charts) {
      const tbl = tables.find((t) => t.id === c.config.tableId);
      // Colour-code each saved chart with its source table so the Charts tab
      // matches the table it was built from (icon + accent colour).
      const tcol = tbl ? getTableColor(tbl) : null;
      const cc = tbl && tcol ? tcol.icon : getChartColor(c);
      const card = h('div', { class: 'chartmini glass', onclick: () => openSaved(c) },
        h('div', { class: 'bar', style: { background: cc } }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('h4', { text: c.name }),
          h('div', { class: 'sub', text: `${chartTypeLabel(c.config && c.config.type)}${tbl ? ` · ${tbl.name}` : ' · table deleted'}` }),
        ),
        tbl
          ? h('span', {
            class: 'csrc', title: `Built from “${tbl.name}”`,
            style: { background: tcol.bg, borderColor: tcol.border, color: tcol.icon },
          }, el(icon(tableIcon(tbl), 12)))
          : null,
        h('button', { class: 'btn sm', title: 'Preview chart', html: `${icon('chart', 14)} Preview`, onclick: (e) => { e.stopPropagation(); openSaved(c); } }),
        h('button', { class: 'icon-btn danger', title: 'Delete chart', 'aria-label': `Delete chart ${c.name}`, onclick: (e) => e.stopPropagation() || deleteChart(c) }, el(icon('trash', 15))),
      );
      grid.append(card);
    }
    body.append(grid);
  }

  async function openSaved(chart) {
    try {
      const tbl = (await api.getTable(chart.config.tableId)).table;
      openBuilder({ table: tbl, saved: chart, onSaved: () => location.reload() });
    } catch (e) { toast(e.message, 'err'); }
  }

  function deleteChart(chart) {
    confirmDialog({ title: 'Delete this chart?', message: `“${chart.name}” will be removed from your saved charts.`, confirmLabel: 'Delete chart' })
      .then(async (ok) => {
        if (!ok) return;
        try { await api.deleteChart(chart.id); charts = charts.filter((c) => c.id !== chart.id); renderCharts(); }
        catch (e) { toast(e.message, 'err'); }
      });
  }

  function cap(s) { return String(s || '').replace(/^\w/, (m) => m.toUpperCase()); }

function getChartColor(c) {
  const CHART_COLORS = ['#6366f1','#8b5cf6','#2dd4bf','#f59e0b','#ef4444','#06b6d4','#ec4899','#84cc16','#f97316','#a855f7'];
  if (c.color) return CHART_COLORS.find((x) => x === c.color) || CHART_COLORS[0];
  let hash = 0;
  const s = String(c.id || c.name || '');
  for (let i = 0; i < s.length; i++) { hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0; }
  return CHART_COLORS[Math.abs(hash) % CHART_COLORS.length];
}

  /* ---------------- actions ---------------- */
  function openNewTable(existing) {
    const m = modal({
      title: existing ? 'Rename table' : 'Create a new table',
      sub: existing ? 'Tables are fully independent datasets.' : 'A table is its own dataset — schema, rows, files and formulas are isolated from every other table.',
    });
    const name = h('input', { type: 'text', value: existing ? existing.name : '', placeholder: 'e.g. Product inventory' });
    const desc = h('input', { type: 'text', value: existing ? existing.description || '' : '', placeholder: 'Short description (optional)' });
    m.body.append(
      h('div', { class: 'field' }, h('label', { text: 'Name' }), name),
      h('div', { class: 'field' }, h('label', { text: 'Description' }), desc),
      h('p', { class: 'muted', style: { fontSize: '12.5px', margin: 0 }, text: 'After creating it you can add typed columns (text, numbers, dates, dropdowns, formulas…), rows and more.' }),
    );
    const submit = h('button', { class: 'btn primary', text: existing ? 'Save' : 'Create table' });
    m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), submit);
    name.focus();
    if (existing) name.select();
    submit.addEventListener('click', async () => {
      if (!name.value.trim()) { toast('Give the table a name', 'err'); return; }
      submit.disabled = true;
      try {
        if (existing) {
          await api.updateTable(existing.id, { name: name.value.trim(), description: desc.value.trim() });
          tables = (await api.listTables({ includeArchived: true })).tables;
          toast('Saved', 'ok');
          m.close();
          renderTables();
        } else {
          const res = await api.createTable({ name: name.value.trim(), description: desc.value.trim() });
          toast('Table created', 'ok');
          m.close();
          // Charts are only created when the user explicitly saves one in the
          // chart builder — no silent auto-generated charts on the Charts tab.
          location.hash = `#/t/${res.table.id}`;
        }
      } catch (e) { toast(e.message, 'err'); submit.disabled = false; }
    });
  }

  async function exportTable(t, fmt) {
    try {
      const { blob, filename } = await api.exportData(t.id, fmt);
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Exported ${filename}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---------------- wire search + init ---------------- */
  const searchInput = head.querySelector('.searchbox input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce(async (e) => {
      const q = e.target.value.trim();
      try { tables = (await api.listTables({ includeArchived: true, search: q })).tables; renderTables(); }
      catch (err) { toast(err.message, 'err'); }
    }, 220));
  }

  content.append(root);
  if (isChartsTab) renderCharts(); else renderTables();
}
