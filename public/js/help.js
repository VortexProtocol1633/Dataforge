/**
 * Help — a searchable how-to guide for every part of DataForge.
 * Opened from the top-bar "Help" button; openHelp({ topic }) jumps straight
 * to the section relevant to the current screen.
 *
 * Steps are authored HTML (see the <b>/<code>/<kbd> markup below) — they are
 * static content, never user input.
 */
import { h, el, modal } from './util.js';
import { icon } from './icons.js';

const TOPICS = [
  { id: 'sign-in', group: 'Start here', icon: 'logout', title: 'Sign in & where your data lives',
    summary: 'DataForge runs as a static website (Live Server) or against the optional Node backend — the UI is identical either way.',
    steps: [
      'Use the demo account — <b>admin</b> / <b>admin123</b> — or the account you created.',
      'In Live Server / standalone mode everything (tables, rows, charts, uploads) is stored <b>locally in your browser</b> (IndexedDB). Nothing is sent anywhere.',
      'Backend mode (<code>npm start</code>) saves data to the <code>data/</code> folder instead and adds OCR for scanned PDFs.',
    ] },
  { id: 'dashboard', group: 'Start here', icon: 'grid', title: 'The dashboard',
    summary: 'Your landing page lists every table as a card and hosts the Charts tab.',
    shots: [
      { src: 'assets/help/dashboard.png', caption: 'Every table is a colour-coded card; the ⋯ menu opens its actions.' },
    ],
    steps: [
      'Each card shows the table name, row/column counts, column types and last-updated time.',
      'Give tables their own <b>colour and icon</b> — card menu → <b>Style &amp; icon</b> — so they are easy to spot.',
      'Use the search box to filter tables by name or description.',
      'Switch between <b>Active</b> and <b>Archived</b> tables with the tabs above the grid.',
      'The <b>Charts</b> tab in the top bar lists your saved charts.',
    ],
    tip: 'Click a card to open the table. The ⋯ menu on a card gives you style, rename, duplicate, archive and delete.' },
  { id: 'appearance', group: 'Start here', icon: 'palette', title: 'Table colours, icons & the theme',
    summary: 'Identify tables at a glance and switch the app between light and dark.',
    steps: [
      'On any table card, open ⋯ → <b>Style &amp; icon</b> to pick a colour and an icon. The same button (palette) lives in the table workspace header.',
      'The colour tints the card icon badge on the dashboard and the badge next to the table title inside the workspace.',
      'Use the theme toggle in the top bar to switch between light and dark — your choice is remembered for next time.',
    ] },
  { id: 'create-table', group: 'Tables', icon: 'plus', title: 'Create a table',
    summary: 'A table is an independent dataset with its own columns, rows, files and charts.',
    steps: [
      'On the dashboard, click <b>New table</b>.',
      'Give it a name (and optionally a short description), then click <b>Create table</b>.',
      'You land in the empty table — click <b>Column</b> to add your first column, then <b>Add row</b> to start entering data.',
    ],
    tip: 'You can also create a table from a file (Import) or from a subset of another table (Extract).' },
  { id: 'table-overview', group: 'Tables', icon: 'table', title: 'Work with a table',
    summary: 'The table workspace: title bar, toolbar and the editable grid.',
    shots: [
      { src: 'assets/help/table.png', caption: 'The workspace: coloured title badge, toolbar and the live grid.' },
    ],
    steps: [
      'Toolbar: <b>Add row</b>, <b>Column</b>, <b>Extract</b>, <b>Chart</b>, <b>Export</b>, import, a row filter and the summary toggle.',
      'Buttons next to the title: table colour &amp; icon (palette), rename, duplicate, archive/unarchive and delete the table.',
      'Click the description under the title to edit it inline.',
      'Drag column headers to reorder columns.',
      'Click a cell to edit it — <kbd class="kbd">Enter</kbd> or clicking away saves, <kbd class="kbd">Esc</kbd> cancels.',
    ] },
  { id: 'columns', group: 'Columns', icon: 'layers', title: 'Column types & options',
    summary: 'Every column has a data type and per-type options.',
    steps: [
      'Add a column with the <b>Column</b> button and pick a type: Text (single/multi-line), Number (integer/decimal), Fraction, Boolean, Currency, Date, Time, Date &amp; time, Dropdown, Image, File or Formula.',
      'Options depend on the type: required, default value, min/max validation, a text pattern (regex), dropdown option list, currency symbol, formula expression.',
      'Use the ⋯ menu in a column header to configure/rename, mark it required, set its summary, or delete it.',
      'Dropdown columns can allow selecting several options (multi-select).',
    ] },
  { id: 'formulas', group: 'Columns', icon: 'fx', title: 'Formula columns',
    summary: 'Excel-style computed columns that recalculate whenever source data changes.',
    shots: [
      { src: 'assets/help/column-formula.png', caption: 'Adding a Formula column — expression box, live validation and click-to-insert function chips.' },
    ],
    steps: [
      '<b>How to create a Formula column:</b>',
      'Click the <b>Column</b> button in the toolbar and select <b>Formula</b> from the type list.',
      'Give the column a name (e.g. "Total") and write a formula expression in the <b>Formula</b> field.',
      'Reference other columns by name in square brackets — names may contain spaces. Example: <code>[Unit price] * [Qty]</code>.',
      'The formula editor validates your expression in real time. A green checkmark means it is valid; red text shows the error.',
      'Click <b>Save</b> to add the column. Every row will now show the computed result automatically.',
      '<b>Brackets &amp; order:</b> group with <code>( )</code> or <code>{ }</code> — innermost pairs evaluate first, then powers (<code>^</code>), unary signs, <code>* / %</code>, <code>+ -</code>, text join <code>&amp;</code>, comparisons and finally <code>&amp;&amp;</code> / <code>||</code>.',
      'An optional <code>=</code> prefix is accepted, Excel-style: <code>=ROUND([Price] * [Qty], 2)</code>.',
      'The full reference (80+ functions with signatures and examples) is searchable below — use the sandbox to try formulas live on sample rows.',
      'Formula results update live — change any source cell and the formula recalculates instantly.',
      'Formulas evaluate the same way in the grid, the row form, charts and exports.',
    ],
    tip: 'Formula columns are read-only — you edit the source columns and the formula updates automatically. If you see an error, check that referenced column names exist and are spelled correctly — and that you used [Square brackets] for column references.' },
  { id: 'rows', group: 'Rows', icon: 'list', title: 'Add, edit & delete rows',
    summary: 'Grid editing and row actions.',
    steps: [
      '<b>Add row</b> appends a record — type values straight into the new cells.',
      'Select rows with the checkboxes to <b>Delete selected</b> or <b>Extract selected</b>.',
      'The ⋯ menu at the end of a row: open the form view, share a read-only link, duplicate or delete the row.',
      'Filter rows with the search box in the toolbar.',
    ] },
  { id: 'row-form', group: 'Rows', icon: 'edit', title: 'Row form view & sharing',
    summary: 'One field per column for a single row, plus read-only sharing.',
    steps: [
      'Row ⋯ menu → <b>Open form view</b>: one input per column respecting the column type; edits save immediately.',
      '<b>Share…</b> creates a public read-only link (<code>#/share/…</code>) — print it to PDF with the browser\u2019s Print button.',
      'The form footer also lets you delete the row.',
    ] },
  { id: 'summaries', group: 'Rows', icon: 'check', title: 'Summary row',
    summary: 'Per-column totals shown in the footer of the grid.',
    steps: [
      'Toggle the <b>Σ</b> switch in the toolbar to show or hide the summary row.',
      'By default numeric columns get a Sum; non-numeric columns get a Count.',
      'Change what a column shows (Sum / Avg / Min / Max / Count / Non-empty) from its header ⋯ menu → Summary.',
    ] },
  { id: 'row-summary', group: 'Rows', icon: 'check', title: 'Row-wise summary',
    summary: 'Show a computed summary for each row across all numeric columns.',
    steps: [
      'Toggle the <b>RΣ</b> switch in the toolbar to show or hide the row summary column.',
      'The row summary adds a trailing column that computes a value across all numeric columns (including formula results) in each row.',
      'By default it shows the <b>Sum</b> of all numeric values in the row.',
      'Use the column ⋯ menu on the row summary header to change the function (Sum / Avg / Min / Max / Count).',
      'Row summaries are useful for totals, averages or quick checks across wide tables.',
    ],
    tip: 'Row summaries include formula column results. If a formula produces an error in a row, that value is skipped in the row summary.' },
  { id: 'extract', group: 'Rows', icon: 'layers', title: 'Extract rows/columns into a new table',
    summary: 'Turn a subset of a table into its own table.',
    steps: [
      'Click <b>Extract</b> in the toolbar (or select rows first and use <b>Extract selected</b>).',
      'Pick the columns (chips), the row scope (all / selected / structure only) and the mode.',
      '<b>Snapshot copy</b> — a detached, independent table.',
      '<b>Linked live view</b> — shows exactly those rows live; it is read-only until you <b>Detach to editable snapshot</b>.',
    ] },
  { id: 'import', group: 'Files & data', icon: 'upload', title: 'Import a file',
    summary: '.xlsx, .xls, .csv, .docx and text-layer .pdf files — up to 10,000 rows.',
    steps: [
      'Click <b>Import</b> on the dashboard (or the import icon in a table toolbar) and choose a file.',
      'Column types are auto-detected — review and adjust names, types, multi-select and skipped columns.',
      'Click <b>Create table</b>: the new table opens with your data.',
      'Word files: the largest table in the document is imported; a document without tables becomes one text column.',
      'PDFs are read from their text layer; scanned PDFs need OCR (backend mode only).',
    ] },
  { id: 'upload-files', group: 'Files & data', icon: 'image', title: 'Upload files & images',
    summary: 'Image and File columns store attachments of up to 20 MB.',
    steps: [
      'Add an <b>Image</b> or <b>File</b> column (Column → pick the type).',
      'Click the empty cell and choose a file from your computer.',
      'Images show a thumbnail — click it to enlarge. Files open in a new tab.',
      'Uploaded files belong to the table: they are removed when the table is deleted.',
    ] },
  { id: 'export', group: 'Files & data', icon: 'download', title: 'Export tables & data',
    summary: 'Excel, CSV and Word export with formula columns evaluated.',
    steps: [
      'From a table card ⋯ menu, or the table toolbar <b>Export</b> menu, choose Excel (.xlsx), CSV (.csv) or Word (.docx).',
      'Computed formula columns are evaluated and types are preserved (numbers numeric, dates ISO, fractions n/d, booleans TRUE/FALSE).',
      'Word (.docx) exports embed the photos of Image columns directly in the table; Excel and CSV carry the file name instead.',
      'In Live Server mode the file downloads; with the backend it is also saved under Saves/Tables.',
    ] },
  { id: 'create-chart', group: 'Charts', icon: 'chart', title: 'Create a chart',
    summary: 'Every table gets a starter chart; fine-tune it from any table.',
    shots: [
      { src: 'assets/help/chart-builder.png', caption: 'The chart builder lives on the table toolbar and reads live data.' },
    ],
    steps: [
      '<b>Auto-generated:</b> the first time a table holds data (rows + columns), DataForge saves a starter “<i>Table name</i> overview” bar chart for it automatically — you will find it on the <b>Charts</b> tab. No setup needed.',
      '<b>Customise:</b> open a table and click the toolbar <b>Chart</b> button (or open a saved chart card) to launch the builder.',
      'Pick the chart type (Bar, Stacked bar, Line, Pie, Donut, Scatter, Radar) and the aggregation (Count / Sum / Avg / Min / Max).',
      'Choose the grouping column (labels) and one or several value columns (ctrl/cmd-click for several).',
      'Set a chart title and axis labels if you like, then <b>Save chart</b> to keep it on the Charts tab.',
      'Charts read data live — edit the table and the chart updates.',
    ] },
  { id: 'save-chart', group: 'Charts', icon: 'check', title: 'Save, reopen & export charts',
    summary: 'Keep chart configs on the Charts tab and export images.',
    steps: [
      'Give the chart a name and click <b>Save chart</b>; it appears on the <b>Charts</b> tab.',
      'Click a saved chart to reopen it — its data stays live.',
      'The <b>PNG</b> / <b>JPG</b> buttons download an image of the chart.',
      'Click a legend entry to toggle a series on/off.',
      'Delete a saved chart with the trash icon on its card.',
    ] },
];

const GROUP_ORDER = ['Start here', 'Tables', 'Columns', 'Rows', 'Files & data', 'Charts'];

/** Open the help modal, optionally on a specific topic (falls back to the first). */
export function openHelp({ topic } = {}) {
  const m = modal({
    wide: true, tall: true, scroll: true, locked: true,
    title: 'Help',
    sub: 'How-to guides for creating tables, charts, formulas, imports and more.',
  });
  const layout = h('div', { class: 'help-layout' });
  const side = h('div', { class: 'help-side' });
  const search = h('input', { type: 'search', placeholder: 'Search help…' });
  // RTL outer keeps the topic list's scrollbar on the LEFT (next to the list
  // itself); the inner wrapper restores LTR reading for the entries.
  const list = h('div', { class: 'help-topics' });
  const listInner = h('div', { class: 'help-topics-inner' });
  list.append(listInner);
  const pane = h('div', { class: 'help-pane' });
  side.append(search, list);
  layout.append(side, pane);
  m.body.append(layout);
  m.foot.append(h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));

  let activeId = topic && TOPICS.some((t) => t.id === topic) ? topic : TOPICS[0].id;

  function renderList(filter) {
    listInner.innerHTML = '';
    const q = (filter || '').toLowerCase();
    const byGroup = new Map();
    for (const t of TOPICS) {
      const hay = `${t.title} ${t.summary || ''} ${(t.steps || []).join(' ')} ${t.tip || ''}`.toLowerCase();
      if (q && !hay.includes(q)) continue;
      if (!byGroup.has(t.group)) byGroup.set(t.group, []);
      byGroup.get(t.group).push(t);
    }
    let any = false;
    for (const g of GROUP_ORDER) {
      const items = byGroup.get(g);
      if (!items || !items.length) continue;
      listInner.append(h('div', { class: 'help-group', text: g }));
      for (const t of items) {
        any = true;
        listInner.append(h('button', {
          class: 'help-topic-btn' + (t.id === activeId ? ' active' : ''),
          onclick: () => select(t.id),
        }, el(icon(t.icon, 14)), h('span', { text: t.title })));
      }
    }
    if (!any) listInner.append(h('div', { class: 'help-empty', text: 'No help topics match your search.' }));
  }

  function renderPane(id) {
    const t = TOPICS.find((x) => x.id === id);
    if (!t) return;
    pane.innerHTML = '';
    pane.append(
      h('div', { class: 'help-topic-head' },
        h('span', { class: 'help-topic-icon' }, el(icon(t.icon, 18))),
        h('h3', { text: t.title }),
      ),
      t.summary ? h('p', { class: 'muted', style: { marginTop: 0 }, text: t.summary }) : null,
      (t.shots || []).length
        ? h('div', { class: 'help-shots' }, ...(t.shots || []).map((s) =>
          h('figure', { class: 'help-shot' },
            h('img', { src: s.src, alt: s.caption || '', loading: 'lazy' }),
            s.caption ? h('figcaption', { text: s.caption }) : null,
          )))
        : null,
      (t.steps || []).length
        ? h('ol', { class: 'help-steps' }, ...(t.steps || []).map((s) => h('li', { html: s })))
        : null,
      id === 'formulas' ? buildFxLab() : null,
      t.tip ? h('div', { class: 'help-tip' }, el(icon('zap', 13)), h('span', { html: t.tip })) : null,
    );
  }

  function select(id) {
    activeId = id;
    renderList(search.value);
    renderPane(id);
  }

  search.addEventListener('input', () => renderList(search.value));
  renderList('');
  renderPane(activeId);
  setTimeout(() => search.focus(), 60);
}

/* ----------------------- formulas sandbox + reference ---------------------- */

const SAMPLE_COLS = ['Item', 'Qty', 'Unit price', 'Region', 'Ordered'];
const SAMPLE_ROWS = [
  ['Office chair', 12, 89.9, 'North', '2024-03-02'],
  ['Desk lamp', 60, 18.5, 'South', '2024-03-11'],
  ['Bookshelf', 8, 149.0, 'East', '2024-04-01'],
  ['LED panel', 24, 42.0, 'West', '2024-04-19'],
];

function fmtFxVal(v) {
  if (v === null || v === undefined || v === '') return '<span class="muted">— blank —</span>';
  if (typeof v === 'boolean') return v ? '<b>TRUE</b>' : '<b>FALSE</b>';
  if (typeof v === 'number' && isFinite(v)) return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
  return String(v);
}

/** The interactive “try a formula” lab + searchable function reference. */
function buildFxLab() {
  const wrap = h('div', { class: 'fxlab glass' });
  wrap.append(h('h4', { style: { margin: '0 0 4px' }, text: '🎛 Try it live — the formula lab' }),
    h('p', { class: 'muted', style: { margin: '0 0 10px', fontSize: '12.5px' }, text: 'Pick a sample row, write a formula against its columns, and watch it evaluate instantly. Click an example to load it.' }));

  const Fx = window.DataForgeFx;
  const rowSel = h('select');
  SAMPLE_ROWS.forEach((_, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `Sample row ${i + 1}`;
    rowSel.append(o);
  });
  const valuesRow = h('div', { class: 'fxlab-rowvals' });
  valuesRow.append(...SAMPLE_COLS.map((c, i) =>
    h('span', { class: 'chip gray' }, h('b', { text: c }), h('span', { class: 'muted', style: { fontWeight: 400 }, text: ' = ' }), h('span', { text: String(SAMPLE_ROWS[0][i]) }))));

  const ta = h('textarea', { class: 'fxarea', rows: 2, style: { fontFamily: 'ui-monospace, monospace', fontSize: '12.5px' } });
  ta.value = 'ROUND([Qty] * [Unit price], 2)';
  const status = h('div', { class: 'fxcheck ok' });
  const result = h('div', { class: 'fxlab-result' });

  function run() {
    const row = SAMPLE_ROWS[Number(rowSel.value) || 0];
    const map = {};
    SAMPLE_COLS.forEach((c, i) => { map[c.toLowerCase()] = row[i]; });
    const r = Fx.evaluate(ta.value, { getValue: (name) => (Object.prototype.hasOwnProperty.call(map, String(name).toLowerCase()) ? map[String(name).toLowerCase()] : undefined) });
    if (!r.ok) {
      status.className = 'fxcheck err';
      status.textContent = `Problem: ${r.error}`;
      result.innerHTML = '';
      return;
    }
    status.className = 'fxcheck ok';
    status.textContent = 'Formula looks good — result on this row:';
    result.innerHTML = fmtFxVal(r.value);
  }
  ta.addEventListener('input', run);
  rowSel.addEventListener('change', () => {
    const i = Number(rowSel.value) || 0;
    valuesRow.innerHTML = '';
    SAMPLE_COLS.forEach((c, k) => {
      valuesRow.append(h('span', { class: 'chip gray' }, h('b', { text: c }), h('span', { class: 'muted', style: { fontWeight: 400 }, text: ' = ' }), h('span', { text: String(SAMPLE_ROWS[i][k]) })));
    });
    run();
  });

  const EXAMPLES = [
    'ROUND([Qty] * [Unit price], 2)',
    'IF([Qty] > 20, "Bulk order", "Small")',
    'CONCAT([Item], " — ", [Region])',
    '{ [Qty] + 100 } % 7',
    'UPPER(LEFT([Item], 3))',
    'DATEDIFF("2024-12-31", [Ordered], "d")',
    'IFERROR(1 / ([Qty] - 60), "no divisor")',
    'PROPER([Item]) & " · " & TEXTJOIN(",", "a", "b")',
    'EVEN([Qty]) - ODD([Qty])',
    '[Qty] * [Unit price] >= 1000',
  ];
  const exRow = h('div', { class: 'fxlab-examples' });
  for (const e of EXAMPLES) {
    exRow.append(h('button', { type: 'button', class: 'pill fxfn', text: e, title: `Example: ${e}`, onclick: () => { ta.value = e; run(); } }));
  }

  const top = h('div', { class: 'fxlab-top' },
    h('div', { class: 'field', style: { margin: 0 } }, h('label', { text: 'Evaluate on' }), rowSel),
    valuesRow,
  );
  const editorBox = h('div', { class: 'fxlab-editor' }, ta, h('div', { class: 'fxlab-meta' }, status, result));

  // ---- searchable full function reference ----
  const ref = h('div', { class: 'fxref help-fxref' });
  const meta = Fx && Fx.META;
  if (meta && meta.functions && meta.functions.length) {
    const byGroup = new Map();
    for (const f of meta.functions) {
      if (!byGroup.has(f.group)) byGroup.set(f.group, []);
      byGroup.get(f.group).push(f);
    }
    const order = ['Math', 'Text', 'Logic', 'Date & time'];
    const search = h('input', { type: 'search', placeholder: 'Search the function reference… (e.g. round, text, date)' });
    const body = h('div', { class: 'fxref-body' });
    const render = (q) => {
      body.innerHTML = '';
      const query = (q || '').toLowerCase();
      let any = false;
      for (const g of order) {
        if (!byGroup.has(g)) continue;
        const list = byGroup.get(g).slice().sort((a, b) => a.name.localeCompare(b.name))
          .filter((f) => !query || f.name.toLowerCase().includes(query) || (f.desc || '').toLowerCase().includes(query) || (f.sig || '').toLowerCase().includes(query));
        if (!list.length) continue;
        any = true;
        body.append(h('div', { class: 'fxref-group', text: g }));
        const grid = h('div', { class: 'fxref-grid' });
        for (const f of list) {
          grid.append(h('div', { class: 'fxfn-card' },
            h('button', { type: 'button', class: 'pill fxfn', text: f.name, onclick: () => { ta.value = (ta.value ? ta.value + ' ' : '') + `${f.name}(`; run(); } }),
            h('code', { text: f.sig }),
            h('p', { text: f.desc }),
            h('span', { class: 'muted', style: { fontSize: '11px', fontFamily: 'ui-monospace, monospace' }, text: `↳ ${f.ex}` }),
          ));
        }
        body.append(grid);
      }
      if (!any) body.append(h('div', { class: 'muted', style: { fontSize: '12px', padding: '6px' }, text: 'No functions match your search.' }));
    };
    search.addEventListener('input', () => render(search.value));
    ref.append(
      h('h4', { style: { margin: '0 0 6px' }, text: '📚 Function reference (click to insert into the box above)' }),
      search, body,
    );
    render('');
  } else {
    ref.append(h('p', { class: 'muted', text: 'The formula engine is unavailable here.' }));
  }

  wrap.append(top, editorBox, h('p', { class: 'muted', style: { fontSize: '12px', margin: '8px 0 4px' }, text: 'Example formulas — click any to try it:' }), exRow, ref);
  run();
  return wrap;
}

/** Topic id matching a route — used to open help on the relevant section. */
export function helpTopicForRoute() {
  const hash = location.hash || '#/';
  if (hash.startsWith('#/charts')) return 'create-chart';
  if (hash.startsWith('#/t/')) return 'table-overview';
  if (hash.startsWith('#/share/')) return 'row-form';
  if (hash.startsWith('#/login')) return 'sign-in';
  return 'create-table';
}