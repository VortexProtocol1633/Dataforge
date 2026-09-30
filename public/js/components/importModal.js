/**
 * Import modal: upload .xlsx / .csv / .docx / .pdf, review auto-detected
 * columns and types, adjust the mapping, then create a brand-new table.
 * Word documents yield their tables (or paragraphs); PDFs are read from the
 * text layer, and scanned pages fall back to OCR.
 */
import { api, isBrowserMode } from '../api.js';
import { icon } from '../icons.js';
import { h, el, esc, modal, toast, fileToBase64 } from '../util.js';

const IMPORTABLE = [
  ['text', 'Text'],
  ['number', 'Number'],
  ['currency', 'Currency'],
  ['fraction', 'Fraction'],
  ['boolean', 'Boolean'],
  ['date', 'Date'],
  ['time', 'Time'],
  ['datetime', 'Date & time'],
  ['dropdown', 'Dropdown'],
];

export function openImport({ onCreated } = {}) {
  const m = modal({
    wide: true, tall: true, scroll: true, locked: true,
    title: 'Import a file',
    sub: 'Excel, CSV, Word or PDF — columns and types are detected for you to review.'
  });
  m.foot.append(h('button', { class: 'btn', text: 'Close', onclick: () => m.close() }));
  m.body.innerHTML = '';

  let job = null;
  let currentName = '';

  // ---------------- file step ----------------
  function stepFile() {
    m.body.innerHTML = '';
    const drop = h('div', {
      class: 'glass',
      style: { padding: '44px 20px', textAlign: 'center', cursor: 'pointer', border: '1.5px dashed var(--hairline-2)', borderRadius: '16px' },
    },
      h('div', { style: { fontSize: '34px', marginBottom: '8px', color: 'var(--indigo)' } }, el(icon('upload', 34))),
      h('h3', { text: 'Choose a file' }),
      h('p', { class: 'muted', text: '.xlsx, .xls, .csv, .docx or .pdf — up to 10,000 rows. The importer detects column types and lets you review the mapping. Scanned PDFs are read with OCR.' }),
      h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn primary', text: 'Browse files' })),
    );
    m.body.append(drop);

    const fileInput = h('input', { type: 'file', accept: '.xlsx,.xls,.csv,.docx,.pdf', style: { display: 'none' } });
    drop.append(fileInput);
    const pick = () => fileInput.click();
    drop.addEventListener('click', pick);
    fileInput.addEventListener('change', async () => {
      const f = fileInput.files[0];
      if (!f) return;
      const data = await fileToBase64(f);
      const spinnerEl = el(`<div class="center-msg" style="min-height:200px"><span class="spin"></span><div class="muted">Parsing ${esc(f.name)}…</div></div>`);
      m.body.innerHTML = '';
      m.body.append(spinnerEl);
      try {
        job = await api.importParse(f.name, data);
        stepMapping();
      } catch (e) { toast(e.message, 'err', 5000); stepFile(); }
    });
  }

  // ---------------- mapping step ----------------
  function stepMapping() {
    m.body.innerHTML = '';
    m.panel.querySelector('.modal-head h3').textContent = 'Review import';
    m.body.append(mappingEl(job));
  }

  function mappingEl(j) {
    const root = h('div', {});
    const back = h('button', { class: 'btn sm ghost', text: '← different file', onclick: () => { job = null; stepFile(); } });
    const meta = h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '10px', flexWrap: 'wrap' } },
      back,
      h('span', { class: 'chip', text: j.fileName }),
      h('span', { class: 'chip teal', text: `${j.totalRows} data rows` }),
      h('span', { class: 'chip gray', text: `sheet “${esc(j.sheetName || '')}”` }),
      h('span', { class: 'muted', text: 'first 50 rows shown' }),
    );

    const nameField = h('input', { type: 'text', value: currentName || j.fileName.replace(/\.(xlsx|xls|csv|docx|pdf)$/i, ''), placeholder: 'New table name' });
    const descField = h('input', { type: 'text', placeholder: 'Description (optional)' });
    const cfg = j.columns.map((c) => ({
      index: c.index, name: c.name, type: c.suggestedType, subtype: c.suggestedSubtype, include: true, multi: false,
    }));
    const list = h('div', { class: 'mapgrid' });

    const typeOptions = () => IMPORTABLE.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    const typeChange = (rowEl, rowCfg, sel) => {
      rowCfg.type = sel.value;
      const multiWrap = rowEl.querySelector('[data-role="multi"]');
      multiWrap.style.display = sel.value === 'dropdown' ? '' : 'none';
    };

    const headRow = h('div', { class: 'maprow head' },
      h('div', { text: 'Source column' }), h('div', { text: 'New name' }), h('div', { text: 'Type' }),
      h('div', { text: 'Multi' }), h('div', { text: '' }));
    list.append(headRow);

    for (const c of j.columns) {
      const rowCfg = cfg.find((x) => x.index === c.index);
      const include = h('input', {
        type: 'checkbox', checked: true, title: 'Include this column',
        onchange: (e) => { rowCfg.include = e.target.checked; rowEl.style.opacity = e.target.checked ? 1 : .45; },
      });
      const nameInput = h('input', { type: 'text', value: c.name, oninput: (e) => { rowCfg.name = e.target.value; } });
      const sel = h('select', { onchange: (e) => typeChange(rowEl, rowCfg, e.target) });
      sel.innerHTML = typeOptions();
      sel.value = rowCfg.type;
      const multi = h('input', {
        type: 'checkbox', title: 'Values may hold several options (comma separated)',
        onchange: (e) => { rowCfg.multi = e.target.checked; },
      });
      const sample = c.stats ? `${c.stats.nonEmpty} filled · ${c.stats.distinct} distinct` : '';
      const srcName = h('div', { style: { minWidth: 0 } },
        h('div', { style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: c.name }),
        h('div', { class: 'muted', style: { fontSize: '11px' }, text: sample }),
      );
      const rowEl = h('div', { class: 'maprow' }, srcName, nameInput, sel,
        h('div', { 'data-role': 'multi', style: { display: sel.value === 'dropdown' ? '' : 'none' } }, multi),
        include);
      list.append(rowEl);
    }

    // preview
    const preview = h('div', { class: 'preview-scroll' }, previewTable(j));
    const createBtn = h('button', { class: 'btn primary', html: `${icon('zap', 15)} Create table` });

    // Temporary workspaces exist only in the browser layer — nothing reaches a
    // server, and the table is deleted when this tab is closed (see localstore).
    const browserMode = isBrowserMode();
    const tempBox = h('input', { type: 'checkbox', checked: browserMode, disabled: !browserMode });
    const tempField = h('label', {
      class: 'field',
      style: { display: 'flex', gap: '10px', alignItems: 'flex-start', margin: '2px 0 12px', cursor: browserMode ? 'pointer' : 'default' },
    },
      tempBox,
      h('span', {},
        h('strong', { text: 'Temporary table' }),
        h('div', { class: 'muted', style: { fontSize: '12px' }, text: browserMode
          ? 'Kept only for this browser tab and removed when you close it — export to save a copy on your computer.'
          : 'Available only when the app runs standalone in the browser (no server).' }),
      ),
    );

    root.append(
      meta,
      h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px', margin: '12px 0 0' } },
        h('div', { class: 'field', style: { marginBottom: '6px' } }, h('label', { text: 'New table name' }), nameField),
        h('div', { class: 'field', style: { marginBottom: '6px' } }, h('label', { text: 'Description' }), descField),
      ),
      tempField,
      list,
      h('h4', { style: { marginTop: '16px' }, text: 'Preview' }),
      preview,
      h('div', { style: { marginTop: '16px', textAlign: 'right' } }, createBtn),
    );

    createBtn.addEventListener('click', async () => {
      const name = nameField.value.trim();
      if (!name) { toast('Give the table a name', 'err'); return; }
      currentName = name;
      createBtn.disabled = true;
      createBtn.innerHTML = '<span class="spin"></span> Creating…';
      try {
        const columns = cfg.filter((x) => x.include).map((x) => {
          const options = {};
          if (x.type === 'dropdown') options.multi = x.multi;
          return { index: x.index, name: x.name, type: x.type, subtype: x.subtype || undefined, options };
        });
        const res = await api.importCreate({ jobId: j.jobId, name, description: descField.value.trim(), columns, ephemeral: browserMode && tempBox.checked });
        toast(`Imported ${res.added} rows` + (res.skipped ? ` (${res.skipped} skipped)` : ''), 'ok');
        m.close();
        if (onCreated) onCreated(res.table);
        else location.hash = `#/t/${res.table.id}`;
      } catch (e) { toast(e.message, 'err', 5000); createBtn.disabled = false; createBtn.innerHTML = 'Create table'; }
    });
    return root;
  }

  function previewTable(j) {
    const headers = j.columns.map((c) => c.name);
    const t = h('table');
    const thead = h('thead');
    thead.append(h('tr', {}, ...headers.map((x) => h('th', { text: x }))));
    const tbody = h('tbody');
    for (const row of j.preview.slice(0, 30)) {
      tbody.append(h('tr', {}, ...headers.map((_, i) => h('td', { text: row[i] == null || row[i] === '' ? '' : String(row[i]) }))));
    }
    t.append(thead, tbody);
    return t;
  }

  stepFile();
}
