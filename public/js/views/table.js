/**
 * Table workspace — the heart of DataForge.
 * Renders a live data grid with one column editor per data type, formula
 * recalculation, summary row, column drag-reordering and the row/column
 * action menus (form view, share, extract, export, delete…).
 */
import { api, assetUrl, sharePageUrl } from '../api.js';
import { icon } from '../icons.js';
import { el, h, esc, modal, toast, confirmDialog, popMenu, loadingSection, errorSection, withTimeout } from '../util.js';
import { typeMeta, cellHTML, attachEditor, typeIconSvg } from '../types.js';
import computeNs from '../compute-shim.js';
const compute = computeNs;
import { openColumnEditor } from '../components/columnEditor.js';
import { openExtract } from '../components/extractModal.js';
import { openImport } from '../components/importModal.js';
import { openRowForm } from '../components/rowForm.js';
import { openBuilder } from '../components/chartBuilder.js';
import { openTableAppearance, tableIcon } from '../components/tableAppearance.js';

const Fx = window.DataForgeFx;

/** rgba tint pair for a #rrggbb accent colour. */
function colorTint(hex) {
  const h = String(hex || '').replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(h)) return { bg: 'var(--grad-soft)', border: 'rgba(139,92,246,.22)', color: 'var(--indigo)' };
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return { bg: `rgba(${r},${g},${b},.13)`, border: `rgba(${r},${g},${b},.42)`, color: `#${h}` };
}

export default async function render(content, route) {
  const tableId = route.id;
  const view = h('div', {});
  content.append(view);
  view.append(loadingSection('Loading table…'));

  let table;
  try {
    table = (await withTimeout(api.getTable(tableId), 15000, 'The table is taking too long to load — is the server running?')).table;
  } catch (e) {
    view.innerHTML = '';
    const isNotFound = e && /not found/i.test(e.message);
    view.append(isNotFound
      ? h('div', { class: 'glass', style: { padding: '30px', textAlign: 'center' } },
        h('h3', { text: 'Table not found' }), h('p', { class: 'muted', text: e.message }),
        h('a', { href: '#/', text: '← Back to dashboard' }))
      : errorSection(e.message || String(e), () => render(content, route)));
    return;
  }
  view.innerHTML = '';

  const state = {
    table,
    sel: new Set(),
    filter: '',
    sort: null, // { colId, dir: 1 | -1 }
    summaryEnabled: (table.summaries && table.summaries.length) > 0,
    rowSummaryEnabled: false,
    rowSummaryFunc: 'sum',
    busyRows: new Set(),
  };

  /* ================= helpers ================= */
  const fxList = () => compute.compileFormulas(state.table);
  let formulas = [];
  function formulaRes(row) {
    return compute.evalRowWith(formulas, state.table, row);
  }

  /** Compute a row-wise summary value (sum/avg/min/max/count) across all numeric columns. */
  function rowSummaryValue(row, func) {
    const cols = (state.table.columns || []).filter((c) => ['number', 'currency', 'formula'].includes(c.type));
    const nums = cols.map((c) => {
      if (c.type === 'formula') {
        const res = formulaRes(row)[c.id];
        return res && res.ok && typeof res.v === 'number' ? res.v : NaN;
      }
      const v = row.values[c.id];
      const n = typeof v === 'number' ? v : Number(v);
      return isFinite(n) ? n : NaN;
    }).filter((v) => isFinite(v));
    if (!nums.length) return '\u2014';
    switch (func) {
      case 'sum': return nums.reduce((a, b) => a + b, 0);
      case 'avg': return nums.reduce((a, b) => a + b, 0) / nums.length;
      case 'min': return Math.min(...nums);
      case 'max': return Math.max(...nums);
      case 'count': return nums.length;
      default: return nums.reduce((a, b) => a + b, 0);
    }
  }

  function formatRowSummary(val) {
    if (val === '\u2014') return '\u2014';
    return typeof val === 'number' ? compute.formatSummary({ type: 'number' }, val) : String(val);
  }

  function columnById(id) { return (state.table.columns || []).find((c) => c.id === id); }

  async function reload() {
    try {
      state.table = (await api.getTable(tableId)).table;
      renderAll();
    } catch (e) { toast(e.message, 'err'); }
  }

  function matchesFilter(row) {
    if (!state.filter) return true;
    const q = state.filter.toLowerCase();
    const parts = (state.table.columns || []).map((c) => {
      if (c.type === 'formula') {
        const r = formulaRes(row)[c.id];
        return compute.formulaText(r);
      }
      const v = row.values[c.id];
      if (v === null || v === undefined) return '';
      if (c.type === 'boolean') return v ? 'yes true' : 'no false';
      if (c.type === 'image' || c.type === 'file') return (v.name || '');
      if (c.type === 'fraction' && typeof v === 'object') return `${v.n} ${v.d} ${v.n}/${v.d}`;
      return String(v);
    }).join(' ').toLowerCase();
    return parts.includes(q);
  }

  /** Column types that can be sorted (image/file attachments cannot). */
  const SORTABLE_TYPES = new Set(['text', 'number', 'currency', 'fraction', 'formula', 'date', 'time', 'datetime', 'dropdown', 'boolean']);

  /** Comparable sort key for one row+column (formula results resolved live). */
  function colSortValue(row, col) {
    if (col.type === 'formula') {
      const res = formulaRes(row)[col.id];
      if (res && res.ok) {
        if (typeof res.v === 'number') return { n: res.v };
        if (typeof res.v === 'boolean') return { n: res.v ? 1 : 0 };
        return { s: compute.formulaText(res) };
      }
      return { empty: true };
    }
    const v = row.values[col.id];
    if (v === null || v === undefined || v === '') return { empty: true };
    switch (col.type) {
      case 'number': case 'currency': {
        const n = Number(v);
        return isFinite(n) ? { n } : { s: String(v) };
      }
      case 'fraction': return v && typeof v === 'object' ? { n: v.d ? v.n / v.d : v.n } : { n: Number(v) };
      case 'boolean': return { n: v ? 1 : 0 };
      case 'dropdown': return { s: Array.isArray(v) ? v.join(', ') : String(v) };
      default: return { s: String(v) };
    }
  }

  function compareSort(a, b) {
    if (a.empty && b.empty) return 0;
    if (a.empty) return 1; // blank cells always sort last
    if (b.empty) return -1;
    if (a.n !== undefined && b.n !== undefined) return a.n - b.n;
    return String(a.s == null ? '' : a.s).localeCompare(String(b.s == null ? '' : b.s), undefined, { numeric: true, sensitivity: 'base' });
  }

  function setSort(colId, dir) {
    state.sort = colId && dir ? { colId, dir } : null;
    renderGrid();
  }

  const filteredRows = () => {
    const rows = (state.table.rows || []).filter(matchesFilter);
    if (state.sort) {
      const col = columnById(state.sort.colId);
      if (col) {
        rows.sort((r1, r2) => compareSort(colSortValue(r1, col), colSortValue(r2, col)) * state.sort.dir);
      }
    }
    return rows;
  };

  /* ================= layout ================= */
  function renderAll() {
    formulas = fxList();
    view.innerHTML = '';
    view.append(renderLinkedBanner(), renderHead(), renderToolbar(), renderGridShell());
  }

  function renderLinkedBanner() {
    if (!state.table.linked) return el('<div></div>');
    const src = state.table.sourceTableId;
    const banner = h('div', { class: 'linked-banner', role: 'status' },
      h('span', { class: 'lb-icon' }, el(icon('link', 16))),
      h('div', { class: 'lb-text' },
        h('strong', { text: 'Read-only live view' }),
        h('span', { html: 'Mirrors the selected rows of <span class="lb-src muted">the source table</span> — edits here are disabled until you detach.' }),
      ),
      h('div', { class: 'lb-actions' },
        h('a', { class: 'btn sm', href: `#/t/${src}`, text: 'Open source' }),
        h('button', {
          class: 'btn sm primary', text: 'Detach to editable snapshot',
          onclick: async () => {
            try {
              const res = await api.detach(tableId);
              state.table = res.table;
              toast('Detached — the table is now an independent copy', 'ok');
              renderAll();
            } catch (e) { toast(e.message, 'err'); }
          },
        }),
      ),
    );
    // show the source table's name once it loads (it replaces the generic label)
    api.getTable(src).then(({ table }) => {
      const nameEl = banner.querySelector('.lb-src');
      if (nameEl) nameEl.textContent = table.name;
    }).catch(() => { /* keep the generic label */ });
    return banner;
  }

  function renderHead() {
    const t = state.table;
    const tc = colorTint(t.color);
    const head = h('div', { class: 'tw-head' },
      h('button', { class: 'back', onclick: () => (location.hash = '#/'), html: `${icon('arrowL', 15)} Dashboard` }),
      h('div', { class: 'tw-title' },
        h('div', { class: 'tw-icrow' },
          el(`<span class="tw-ic" style="background:${tc.bg};border-color:${tc.border};color:${tc.color}">${icon(tableIcon(t), 15)}</span>`),
          h('h1', {},
            h('span', { text: t.name }),
            t.kind === 'linked' ? h('span', { class: 'chip teal', text: 'live view' }) : null,
            t.archived ? h('span', { class: 'chip amber', text: 'archived' }) : null,
          ),
        ),
        h('div', { class: 'desc', title: 'Click to edit description', text: t.description || 'No description yet — click to edit', contenteditable: 'plaintext-only' }),
      ),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', {
          class: 'btn', title: 'Table colour & icon', 'aria-label': 'Table colour and icon', html: icon('palette', 15),
          onclick: () => openTableAppearance({
            table: state.table,
            onApplied: ({ color, icon }) => {
              state.table.color = color;
              state.table.icon = icon;
              const badge = view.querySelector('.tw-ic');
              if (badge) {
                const tt = colorTint(color);
                badge.style.background = tt.bg;
                badge.style.borderColor = tt.border;
                badge.style.color = tt.color;
                badge.innerHTML = icon(tableIcon({ ...state.table, icon }), 15);
              }
            },
          }),
        }),
        h('button', {
          class: 'btn', title: 'Rename table', 'aria-label': 'Rename table', html: icon('edit', 15),
          onclick: (e) => renameTable(e.currentTarget),
        }),
        h('button', { class: 'btn', title: 'Duplicate table', 'aria-label': 'Duplicate table', html: icon('copy', 15), onclick: duplicateTable }),
        h('button', { class: 'btn', title: t.archived ? 'Unarchive' : 'Archive', 'aria-label': t.archived ? 'Unarchive table' : 'Archive table', html: icon(t.archived ? 'unarchive' : 'archive', 15), onclick: toggleArchive }),
        h('button', { class: 'btn', title: 'Open file location — show this table’s backend file in the file manager', 'aria-label': 'Open file location', html: icon('folder', 15), onclick: openFileLocation }),
        h('button', { class: 'btn', title: 'Delete table', 'aria-label': 'Delete table', html: icon('trash', 15), onclick: deleteTable }),
      ),
    );
    // inline description editing
    const PLACEHOLDER = 'No description yet — click to edit';
    const descEl = head.querySelector('.desc');
    descEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); descEl.blur(); }
    });
    descEl.addEventListener('blur', async () => {
      // The placeholder is UI text, never a real value — a blur without edits
      // must not persist it as the description.
      const next = descEl.textContent.trim();
      if (next !== PLACEHOLDER && next !== (t.description || '')) {
        try { await api.updateTable(tableId, { description: next }); t.description = next; toast('Description saved', 'ok'); }
        catch (err) { toast(err.message, 'err'); descEl.textContent = t.description || ''; }
      }
      if (!t.description) descEl.textContent = PLACEHOLDER;
      descEl.removeAttribute('contenteditable');
      setTimeout(() => descEl.setAttribute('contenteditable', 'plaintext-only'), 0);
    });
    return head;
  }

  function renameTable(btn) {
    const m = modal({ title: 'Rename table', sub: 'Tables are fully independent data sets.' });
    const input = h('input', { type: 'text', value: state.table.name });
    m.body.append(h('div', { class: 'field' }, input));
    m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }));
    m.foot.append(h('button', {
      class: 'btn primary', text: 'Save',
      onclick: async () => {
        const name = input.value.trim();
        if (!name) return;
        try { await api.updateTable(tableId, { name }); m.close(); reload(); }
        catch (e) { toast(e.message, 'err'); }
      },
    }));
    input.focus(); input.select();
  }

  async function duplicateTable() {
    try {
      const res = await api.duplicateTable(tableId);
      toast('Table duplicated', 'ok');
      location.hash = `#/t/${res.table.id}`;
    } catch (e) { toast(e.message, 'err'); }
  }

  async function toggleArchive() {
    const toArchived = !state.table.archived;
    try {
      await api.setArchived(tableId, toArchived);
      // Land on the dashboard's Archived tab so it is obvious the table is
      // safe — archiving only hides it from the Active list, never deletes it.
      toast(toArchived ? 'Table archived — it is safe under the Archived tab' : 'Table unarchived — back on the Active list', 'ok');
      location.hash = toArchived ? '#/?archived=1' : '#/';
    } catch (e) { toast(e.message, 'err'); }
  }

  async function deleteTable() {
    const ok = await confirmDialog({
      title: `Delete “${state.table.name}”?`,
      message: 'This permanently deletes the table, all of its rows and its uploaded files.',
      confirmLabel: 'Delete table',
    });
    if (!ok) return;
    try { await api.deleteTable(tableId); toast('Table deleted', 'ok'); location.hash = '#/'; }
    catch (e) { toast(e.message, 'err'); }
  }

  /** Reveal the table's backend JSON file in the OS file manager (backend mode). */
  async function openFileLocation() {
    try {
      await api.openFileLocation(tableId);
      toast('Opened the table file in your file manager', 'ok');
    } catch (e) {
      if (e instanceof Error && /browser mode/i.test(e.message)) {
        toast(e.message, 'info', 6000);
      } else {
        toast(e.message || 'Could not open the file location', 'err');
      }
    }
  }

  /* ================= toolbar ================= */
  function renderToolbar() {
    const t = state.table;
    const addRowBtn = h('button', {
      class: 'btn primary', html: `${icon('plus', 15)} Add row`,
      disabled: !t.columns.length || !!t.linked,
      onclick: addRow,
    });
    const addColBtn = h('button', {
      class: 'btn', html: `${icon('plus', 15)} Column`,
      disabled: !!t.linked,
      onclick: () => openColumnEditor({ table: t, onSaved: reload }),
    });
    const extractBtn = h('button', { class: 'btn', html: `${icon('layers', 15)} Extract`, onclick: () => openExtract({ table: t, selectedRowIds: state.sel.size ? [...state.sel] : null }) });
    const chartBtn = h('button', { class: 'btn', html: `${icon('chart', 15)} Chart`, onclick: () => openBuilder({ table: t }) });
    const exportBtn = h('button', { class: 'btn', html: `${icon('download', 15)} Export`, onclick: (e) => openExportMenu(e.currentTarget) });
    const importBtn = h('button', { class: 'btn', title: 'Import a file (Excel, CSV, Word, PDF) into a new table', 'aria-label': 'Import a file (Excel, CSV, Word, PDF) into a new table', html: icon('upload', 15), onclick: () => openImport({}) });

    // summary toggle
    const sumToggle = h('div', {
      class: 'toggle' + (state.summaryEnabled ? ' on' : ''), title: 'Show per-column summary row',
      onclick: async () => {
        state.summaryEnabled = !state.summaryEnabled;
        sumToggle.classList.toggle('on', state.summaryEnabled);
        if (state.summaryEnabled && !t.summaries.length) t.summaries = quickSummaries();
        await saveSummaries();
      },
    });

    // row-wise summary toggle
    const rowSumToggle = h('div', {
      class: 'toggle' + (state.rowSummaryEnabled ? ' on' : ''), title: 'Show per-row summary column',
      onclick: () => {
        state.rowSummaryEnabled = !state.rowSummaryEnabled;
        rowSumToggle.classList.toggle('on', state.rowSummaryEnabled);
        renderGrid();
      },
    });

    // row filter
    const search = h('div', { class: 'searchbox hide-m' },
      el(icon('search')),
      h('input', {
        type: 'search', placeholder: 'Filter rows…',
        oninput: (e) => { state.filter = e.target.value.trim().toLowerCase(); renderGrid(); },
      }),
    );

    const toolbar = h('div', { class: 'toolbar glass' },
      addRowBtn, addColBtn, h('span', { class: 'sep' }),
      extractBtn, chartBtn, h('span', { class: 'sep' }),
      exportBtn, importBtn,
      h('div', { class: 'grow' }),
      h('span', { class: 'rowcount', text: `${filteredRows().length} row${filteredRows().length === 1 ? '' : 's'}` }),
      h('span', { class: 'chip gray hide-m', title: 'Column summary row', html: `${icon('fx', 13)}&nbsp;` }, 'Σ'),
      sumToggle,
      h('span', { class: 'chip gray hide-m', title: 'Row summary column', style: { marginLeft: '4px' }, html: `${icon('fx', 13)}&nbsp;` }, 'RΣ'),
      rowSumToggle,
      search,
    );
    return toolbar;
  }

  function openExportMenu(anchor) {
    const t = state.table;
    popMenu(anchor, [
      { header: `Export ${t.name}` },
      { label: 'Excel (.xlsx)', icon: 'table', onClick: () => exportFmt('xlsx') },
      { label: 'CSV (.csv)', icon: 'list', onClick: () => exportFmt('csv') },
      { label: 'Word (.docx)', icon: 'file', onClick: () => exportFmt('docx') },
      { sep: true },
      { label: 'Chart as image…', icon: 'chart', onClick: () => openBuilder({ table: t }) },
    ]);
  }

  async function exportFmt(fmt) {
    toast(`Exporting ${fmt.toUpperCase()}…`, 'info');
    try {
      const { blob, filename } = await api.exportData(tableId, fmt);
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: filename });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast(`Exported ${filename}`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  function quickSummaries() {
    const out = [];
    for (const c of state.table.columns || []) {
      if (c.type === 'number' || c.type === 'currency') out.push({ columnId: c.id, func: 'sum' });
    }
    if (!out.length) for (const c of state.table.columns || []) out.push({ columnId: c.id, func: 'count' });
    return out.slice(0, 6);
  }

  async function saveSummaries() {
    try {
      const res = await api.putSummaries(tableId, state.summaryEnabled ? state.table.summaries : []);
      // response ok; keep local
      renderGrid();
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ================= row ops ================= */
  async function addRow() {
    if (!state.table.columns.length) { toast('Add a column first', 'info'); return; }
    try {
      const res = await api.addRow(tableId, {});
      state.table.rows.push(res.row);
      renderGrid();
      toast('Row added', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function commitCell(row, col, raw) {
    state.busyRows.add(row.id);
    try {
      const res = await api.updateRow(tableId, row.id, { [col.id]: raw });
      row.values = res.row.values;
      renderGrid();
    } catch (e) {
      toast(`${col.name}: ${e.message}`, 'err');
      renderGrid();
    } finally {
      state.busyRows.delete(row.id);
    }
  }

  /* ================= grid ================= */
  function renderGridShell() {
    const shell = h('div', { class: 'grid-shell glass' });
    const tableEl = h('table', { class: 'df' });
    shell.append(tableEl);
    renderGridInto(tableEl);
    const el2 = h('div', {});
    const bar = h('div', {
      class: 'glass',
      'data-role': 'bulkbar',
      style: { marginTop: '10px', padding: '10px 16px', display: state.sel.size ? 'flex' : 'none', alignItems: 'center', gap: '10px' },
    },
      h('span', { class: 'chip', text: `${state.sel.size} selected` }),
      h('button', { class: 'btn sm', text: 'Clear', onclick: () => { state.sel.clear(); renderGrid(); } }),
      h('div', { class: 'grow' }),
      h('button', { class: 'btn sm', html: `${icon('layers', 14)} Extract selected`, onclick: () => openExtract({ table: state.table, selectedRowIds: [...state.sel] }) }),
      h('button', { class: 'btn sm danger', html: `${icon('trash', 14)} Delete selected`, onclick: () => bulkDelete() }),
    );
    el2.append(shell, bar);
    return el2;
  }

  async function bulkDelete() {
    if (!state.sel.size) return;
    const ok = await confirmDialog({
      title: `Delete ${state.sel.size} row${state.sel.size > 1 ? 's' : ''}?`,
      message: 'This cannot be undone.',
      confirmLabel: 'Delete rows',
    });
    if (!ok) return;
    try {
      await api.deleteRows(tableId, [...state.sel]);
      state.sel.clear();
      reload();
      toast('Rows deleted', 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  let dragCol = null;

  function renderGridInto(tableEl) {
    const t = state.table;
    const cols = t.columns || [];
    const rows = filteredRows();
    tableEl.innerHTML = '';

    // ---------- thead ----------
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    const mkTh = (label, extra) => {
      const th = h('th', { ...(extra || {}) }, label);
      tr.append(th);
      return th;
    };
    const allChecked = rows.length > 0 && rows.every((r) => state.sel.has(r.id));
    const anyChecked = state.sel.size > 0;
    const selTh = h('th', { class: 'pin sel-col', 'aria-label': 'Select all rows', title: 'Select / deselect all rows' },
      h('label', { class: 'ck' + (anyChecked && !allChecked ? ' indet' : '') },
        h('input', {
          type: 'checkbox', checked: allChecked, 'aria-label': 'Select all rows',
          onchange: (e) => {
            const on = e.target.checked;
            if (on) rows.forEach((r) => state.sel.add(r.id)); else state.sel.clear();
            renderGrid();
          },
        }),
        el('<span class="tick">' + icon('check', 11) + '<i class="bar"></i></span>'),
      ));
    const numTh = h('th', { style: { width: '46px' } }, h('div', { class: 'th-in', style: { minWidth: 'auto', justifyContent: 'center' }, text: '#' }));
    tr.append(selTh, numTh);

    for (const col of cols) {
      const meta = typeMeta(col.type);
      const th = document.createElement('th');
      th.draggable = !t.linked;
      const inner = h('div', { class: 'th-in', title: `${meta.label} column${col.options && col.options.required ? ' · required' : ''}` },
        h('span', { class: 'coldrag', html: icon('drag', 14) }),
        el(typeIconSvg(col.type, 13)),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: col.name }),
        state.sort && state.sort.colId === col.id
          ? h('span', { class: 'sortind', title: state.sort.dir === 1 ? 'Sorted ascending (A→Z / low→high)' : 'Sorted descending (Z→A / high→low)', text: state.sort.dir === 1 ? '↑' : '↓' })
          : null,
        col.type === 'formula'
          ? h('span', { class: 'chip gray', style: { fontSize: '9.5px', padding: '1px 5px' }, text: 'formula' })
          : null,
        h('button', {
          class: 'icon-btn sm colmenu', title: 'Column actions', 'aria-label': `Actions for column ${col.name}`, html: icon('more', 14),
          onclick: (e) => openColMenu(e.currentTarget, col),
        }),
      );
      // drag & drop reorder
      if (!t.linked) {
        th.addEventListener('dragstart', (e) => {
          dragCol = col.id;
          th.classList.add('dragcol');
          e.dataTransfer.effectAllowed = 'move';
        });
        th.addEventListener('dragend', () => {
          dragCol = null;
          document.querySelectorAll('th.dragcol, th.drop-target').forEach((x) => x.classList.remove('dragcol', 'drop-target'));
        });
        th.addEventListener('dragover', (e) => {
          if (!dragCol || dragCol === col.id) return;
          e.preventDefault();
          th.classList.add('drop-target');
        });
        th.addEventListener('dragleave', () => th.classList.remove('drop-target'));
        th.addEventListener('drop', async (e) => {
          e.preventDefault();
          th.classList.remove('drop-target');
          if (!dragCol || dragCol === col.id) return;
          const from = cols.findIndex((c) => c.id === dragCol);
          const to = cols.findIndex((c) => c.id === col.id);
          if (from < 0 || to < 0) return;
          const next = [...cols];
          const [moved] = next.splice(from, 1);
          next.splice(to, 0, moved);
          const orderedIds = next.map((c) => c.id);
          t.columns = next;
          try { await api.reorderColumns(tableId, orderedIds); renderGrid(); }
          catch (err) { toast(err.message, 'err'); reload(); }
        });
      }
      th.append(inner);
      tr.append(th);
    }
    // row summary column header
    if (state.rowSummaryEnabled) {
      const rsTh = h('th', { style: { minWidth: '80px' } }, h('div', { class: 'th-in' },
        h('span', { class: 'fx-badge', html: icon('fx', 11) }),
        h('span', { text: `Row ${compute.summaryLabel(state.rowSummaryFunc)}` }),
      ));
      tr.append(rsTh);
    }
    thead.append(tr);
    tableEl.append(thead);

    // ---------- tbody ----------
    const tbody = document.createElement('tbody');
    const bigColspan = String(cols.length + 3 + (state.rowSummaryEnabled ? 1 : 0));
    if (!cols.length) {
      const tr2 = h('tr', {},
        h('td', { colspan: bigColspan, style: { padding: '44px 20px', textAlign: 'center', color: 'var(--text-2)' } },
          h('div', { style: { fontSize: '30px', marginBottom: '8px' } }, el(icon('table', 30))),
          h('p', { style: { margin: '0 0 12px' }, text: 'This table has no columns yet — add one to start storing data.' }),
        ));
      tbody.append(tr2);
    } else if (!rows.length) {
      const tr2 = h('tr', {},
        h('td', { colspan: bigColspan, style: { padding: '44px 20px', textAlign: 'center', color: 'var(--text-2)' } },
          h('p', { style: { margin: '0 0 4px' }, text: state.filter ? 'No rows match the filter.' : 'No rows yet.' }),
          state.filter ? null : h('p', { class: 'muted', style: { margin: 0 }, text: 'Click “Add row” to create the first record.' }),
        ));
      tbody.append(tr2);
    }

    rows.forEach((row, i) => {
      const tr2 = document.createElement('tr');
      if (state.sel.has(row.id)) tr2.classList.add('sel');
      const cell = (html) => {
        const td = h('td', { html });
        return td;
      };
      // selector
      const selTd = h('td', { class: 'rowsel pin' },
        h('div', { class: 'cell' },
          h('label', { class: 'ck', title: 'Select row' },
            h('input', {
              type: 'checkbox', checked: state.sel.has(row.id), 'aria-label': `Select row ${i + 1}`,
              onclick: (e) => { e.stopPropagation(); },
              onchange: (e) => {
                if (e.target.checked) state.sel.add(row.id); else state.sel.delete(row.id);
                tr2.classList.toggle('sel', state.sel.has(row.id));
                updateBulkBar();
                syncSelectAllUi();
              },
            }),
            el('<span class="tick">' + icon('check', 11) + '<i class="bar"></i></span>'),
          )));
      const numTd = h('td', { class: 'rowsel' }, h('div', { class: 'cell muted', text: String(i + 1) }));
      tr2.append(selTd, numTd);

      for (const col of cols) {
        const td = document.createElement('td');
        const raw = row.values[col.id];
        const isFormula = col.type === 'formula';
        let contentHTML;
        if (isFormula) {
          const res = formulaRes(row)[col.id];
          contentHTML = res && res.err
            ? `<div class="cell fcell"><span class="err" title="${esc(res.err)}">#${esc(res.err)}</span></div>`
            : `<div class="cell fcell${compute.formulaText(res) ? '' : ' empty'}">${compute.formulaText(res) ? `<span class="val">${esc(compute.formulaText(res))}</span>` : '<span>—</span>'}</div>`;
        } else {
          contentHTML = cellHTML(col, raw);
        }
        td.innerHTML = contentHTML;
        const isNum = ['number', 'currency'].includes(col.type) && !isFormula;
        if (isNum) td.classList.add('numcell');
        wireCell(td, row, col, raw);
        tr2.append(td);
      }

      // row summary cell
      if (state.rowSummaryEnabled) {
        const rsVal = rowSummaryValue(row, state.rowSummaryFunc);
        const rsTd = h('td', { class: 'numcell' }, h('div', { class: 'cell', style: { justifyContent: 'flex-end', fontWeight: 600 } },
          h('span', { class: 'chip', text: formatRowSummary(rsVal) })
        ));
        tr2.append(rsTd);
      }

      // trailing row menu
      const menuTd = h('td', { style: { width: '42px', padding: 0 } }, h('div', { class: 'cell', style: { justifyContent: 'center' } },
        h('button', { class: 'icon-btn', title: 'Row actions', 'aria-label': `Actions for row ${i + 1}`, html: icon('more', 15), onclick: (e) => openRowMenu(e.currentTarget, row) })));
      tr2.append(menuTd);
      tbody.append(tr2);
    });
    tableEl.append(tbody);

    // ---------- tfoot (summary) ----------
    if (state.summaryEnabled && cols.length) {
      const tfoot = document.createElement('tfoot');
      const tr3 = document.createElement('tr');
      const blank = h('td', { colspan: '2' }, h('div', { class: 'sumcell' }));
      tr3.append(blank);
      for (const col of cols) {
        const summary = (state.table.summaries || []).find((s) => s.columnId === col.id);
        const td = h('td', {}, h('div', { class: 'sumcell', style: { textAlign: ['number', 'currency'].includes(col.type) ? 'right' : 'left' } },
          summary
            ? h('span', {}, h('span', { class: 'muted', style: { fontWeight: 600, fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '.05em' }, text: compute.summaryLabel(summary.func) + '  ' }),
              h('span', { text: formatColSummary(col, summary.func) }))
            : h('span', { class: 'muted', style: { fontSize: '11px' }, text: '—' }),
        ));
        tr3.append(td);
      }
      const blank2 = h('td', {}, '');
      tr3.append(blank2);
      tfoot.append(tr3);
      tableEl.append(tfoot);
    }
  }

  function formatColSummary(col, func) {
    const v = compute.summarizeCol(state.table, col, func);
    return compute.formatSummary(col, v);
  }

  function renderGrid() {
    const shell = view.querySelector('.grid-shell');
    if (shell) {
      const tbl = shell.querySelector('table.df');
      if (tbl) renderGridInto(tbl);
    }
    updateBulkBar();
    const rc = view.querySelector('.rowcount');
    if (rc) rc.textContent = `${filteredRows().length} row${filteredRows().length === 1 ? '' : 's'}`;
  }

  function updateBulkBar() {
    const bar = view.querySelector('[data-role="bulkbar"]');
    if (!bar) return;
    bar.style.display = state.sel.size ? 'flex' : 'none';
    const chip = bar.querySelector('span.chip');
    if (chip) chip.textContent = `${state.sel.size} selected`;
  }

  /** Keep the header select-all control in sync when individual rows toggle. */
  function syncSelectAllUi() {
    const headCk = view.querySelector('.grid-shell thead .ck');
    if (!headCk) return;
    const input = headCk.querySelector('input');
    if (!input) return;
    const rows = filteredRows();
    const all = rows.length > 0 && rows.every((r) => state.sel.has(r.id));
    const some = state.sel.size > 0 && !all;
    headCk.classList.toggle('indet', some);
    input.checked = all;
  }

  /* ---------- cell wiring ---------- */
  function wireCell(td, row, col, raw) {
    const cellDiv = td.querySelector('.cell');
    if (!cellDiv) return;
    const t = state.table;
    const isFormula = col.type === 'formula';

    // image lightbox / file open
    const img = td.querySelector('[data-role="img"]');
    if (img) {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        const ov = el('<div class="lightbox"></div>');
        ov.append(h('img', { src: img.src, alt: '' }));
        ov.addEventListener('click', () => ov.remove());
        document.body.append(ov);
      });
    }
    const fileChip = td.querySelector('[data-role="file"]');
    if (fileChip) {
      fileChip.addEventListener('click', (e) => {
        e.stopPropagation();
        const rec = fileChip.dataset.url || (raw && raw.url ? assetUrl(raw.url) : null);
        if (rec) window.open(rec, '_blank');
      });
    }

    const boolView = td.querySelector('[data-role="boolview"]');
    if (boolView) {
      boolView.addEventListener('click', (e) => { e.stopPropagation(); if (!t.linked) startEdit(td, row, col); });
    }

    if (t.linked || isFormula) return;
    cellDiv.addEventListener('click', (e) => {
      if (e.defaultPrevented) return;
      if (td.querySelector('input,select,textarea')) return;
      if (state.busyRows.has(row.id)) return;
      startEdit(td, row, col);
    });
  }

  function startEdit(td, row, col) {
    const cellDiv = td.querySelector('.cell');
    if (!cellDiv) return;
    const busy = () => { if (cellDiv) cellDiv.innerHTML = ''; };
    attachEditor(col, row.values[col.id], cellDiv, {
      commit: (raw) => commitCell(row, col, raw),
      cancel: () => renderGrid(),
      busy,
      upload: async (name, data, mime) => {
        const rec = await api.saveFile(tableId, { filename: name, data, mime });
        return rec.file;
      },
    });
    const first = cellDiv.querySelector('input,textarea,select');
    if (first && first.focus) setTimeout(() => first.focus(), 0);
  }

  /* ---------- menus ---------- */
  function openColMenu(btn, col) {
    const t = state.table;
    const summary = (t.summaries || []).find((s) => s.columnId === col.id);
    const summaryItems = ['sum', 'avg', 'min', 'max', 'count'].map((f) => ({
      label: `${summary && summary.func === f ? '✓ ' : ''}Summary: ${compute.summaryLabel(f)}`,
      icon: 'fx',
      onClick: () => setColumnSummary(col.id, f),
    }));
    const sortedAsc = state.sort && state.sort.colId === col.id && state.sort.dir === 1;
    const sortedDesc = state.sort && state.sort.colId === col.id && state.sort.dir === -1;
    const sortItems = SORTABLE_TYPES.has(col.type)
      ? [
        { label: sortedAsc ? '✓ Sort ascending (A→Z / low→high)' : 'Sort ascending (A→Z / low→high)', icon: 'chevronD', onClick: () => setSort(col.id, 1) },
        { label: sortedDesc ? '✓ Sort descending (Z→A / high→low)' : 'Sort descending (Z→A / high→low)', icon: 'chevronD', onClick: () => setSort(col.id, -1) },
        ...(state.sort && state.sort.colId === col.id ? [{ label: 'Clear sort', icon: 'x', onClick: () => setSort(null, null) }] : []),
        { sep: true },
      ]
      : [];
    popMenu(btn, [
      { header: col.name },
      { label: 'Configure / rename', icon: 'edit', onClick: () => openColumnEditor({ table: t, column: col, onSaved: reload }) },
      { label: col.options && col.options.required ? 'Optional (un-require)' : 'Required', icon: 'check', onClick: () => toggleRequired(col) },
      { sep: true },
      ...sortItems,
      ...(state.summaryEnabled ? summaryItems : []),
      ...(state.summaryEnabled && summary ? [{ label: 'Remove summary', icon: 'x', onClick: () => setColumnSummary(col.id, null) }] : []),
      { sep: true },
      { label: 'Delete column', icon: 'trash', danger: true, onClick: () => deleteColumn(col) },
    ]);
  }

  async function toggleRequired(col) {
    try {
      await api.updateColumn(tableId, col.id, { options: { ...col.options, required: !(col.options && col.options.required) } });
      col.options.required = !(col.options && col.options.required);
      toast(col.options.required ? `“${col.name}” is now required` : `“${col.name}” is now optional`, 'ok');
    } catch (e) { toast(e.message, 'err'); }
  }

  async function setColumnSummary(colId, func) {
    const list = [...(state.table.summaries || [])].filter((s) => s.columnId !== colId);
    if (func) list.push({ columnId: colId, func });
    state.table.summaries = list;
    await saveSummaries();
    renderGrid();
  }

  async function deleteColumn(col) {
    // warn if formulas reference it
    const refs = [];
    for (const c of state.table.columns) {
      if (c.type !== 'formula') continue;
      const names = Fx.referencedColumns(c.options.formula || '');
      if (names.some((n) => n.toLowerCase() === col.name.toLowerCase())) refs.push(c.name);
    }
    const hasData = state.table.rows.some((r) => r.values[col.id] !== null && r.values[col.id] !== undefined && r.values[col.id] !== '');
    const ok = await confirmDialog({
      title: `Delete column “${col.name}”?`,
      message: [
        hasData ? `All values in this column will be removed from every row.` : '',
        refs.length ? `Formula columns using it will break: ${refs.join(', ')}.` : '',
        'This cannot be undone.',
      ].filter(Boolean).join(' '),
      confirmLabel: 'Delete column',
    });
    if (!ok) return;
    try {
      await api.deleteColumn(tableId, col.id);
      toast('Column deleted', 'ok');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  }

  function openRowMenu(btn, row) {
    const idx = (state.table.rows || []).indexOf(row);
    popMenu(btn, [
      { header: `Row ${idx + 1}` },
      { label: 'Open form view', icon: 'edit', onClick: () => openRowForm({ table: state.table, row, onRowChanged: () => reload() }) },
      { label: 'Share read-only link', icon: 'link', onClick: async () => {
        try {
          const res = await api.shareRow(tableId, row.id);
          const url = sharePageUrl(res.token);
          try { await navigator.clipboard.writeText(url); toast('Link copied', 'ok'); }
          catch { window.prompt('Share link:', url); }
        } catch (e) { toast(e.message, 'err'); }
      } },
      { label: 'Duplicate row', icon: 'copy', onClick: async () => {
        try {
          const values = {};
          for (const c of state.table.columns) {
            if (c.type === 'formula') continue;
            const v = row.values[c.id];
            if (v !== null && v !== undefined) values[c.id] = Array.isArray(v) ? [...v] : (typeof v === 'object' ? { ...v } : v);
          }
          const res = await api.addRow(tableId, values);
          state.table.rows.push(res.row);
          renderGrid();
        } catch (e) { toast(e.message, 'err'); }
      } },
      { sep: true },
      { label: 'Delete row', icon: 'trash', danger: true, onClick: async () => {
        const ok2 = await confirmDialog({ title: 'Delete this row?', message: 'This removes the row permanently.', confirmLabel: 'Delete row' });
        if (!ok2) return;
        try { await api.deleteRows(tableId, [row.id]); state.sel.delete(row.id); reload(); toast('Row deleted', 'ok'); }
        catch (e) { toast(e.message, 'err'); }
      } },
    ]);
  }

  renderAll();
}
