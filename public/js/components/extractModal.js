/**
 * "Extract into a new table" modal.
 * Copies a chosen subset of columns and rows into a brand-new independent
 * table — either as a detached snapshot (copy) or a live linked view that
 * keeps showing the selected rows with their current values.
 */
import { api } from '../api.js';
import { icon } from '../icons.js';
import { h, modal, toast, confirmDialog } from '../util.js';
import { typeLabel } from '../types.js';

export function openExtract({ table, selectedRowIds = null }) {
  const m = modal({
    title: 'Extract into a new table',
    sub: 'Pick columns and rows to become their own independent table.',
  });

  const nameInput = h('input', { type: 'text', value: `${table.name} — extract` });
  const descInput = h('input', { type: 'text', placeholder: 'Description (optional)' });

  // ---- column picker (chips with checkboxes) ----
  const chosenCols = new Set((table.columns || []).map((c) => c.id));
  const colList = h('div', { class: 'optpills' });
  function renderCols() {
    colList.innerHTML = '';
    for (const c of table.columns || []) {
      const on = chosenCols.has(c.id);
      const pill = h('button', {
        type: 'button',
        class: 'pill',
        style: { cursor: 'pointer', padding: '5px 10px', opacity: on ? 1 : .5 },
        onclick: () => { if (on) chosenCols.delete(c.id); else chosenCols.add(c.id); renderCols(); },
        title: `${typeLabel(c.type)} — click to ${on ? 'remove' : 'add'}`,
      },
        h('span', { text: on ? '✓ ' : '✕ ' }),
        h('span', { text: c.name }));
      colList.append(pill);
    }
  }
  renderCols();

  // ---- row scope radio ----
  const allRows = (table.rows || []).length;
  const hasSelection = selectedRowIds && selectedRowIds.length;
  let scope = hasSelection ? 'selected' : 'all';
  const scopeRadios = h('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } },
    radio('all', `All rows (${allRows})`),
    ...(hasSelection ? [radio('selected', `Only ${selectedRowIds.length} selected row${selectedRowIds.length > 1 ? 's' : ''}`)] : []),
    radio('empty', 'No rows (structure only)'),
  );
  function radio(val, label) {
    const r = h('label', { class: 'check-row' },
      h('input', { type: 'radio', name: 'extract-scope', value: val, checked: scope === val, onchange: () => { scope = val; } }),
      h('span', { text: label }));
    return r;
  }

  // ---- linked vs copy ----
  let mode = 'copy';
  const modeRow = h('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap', marginTop: '4px' } },
    h('label', { class: 'check-row' },
      h('input', { type: 'radio', name: 'extract-mode', value: 'copy', checked: true, onchange: () => { mode = 'copy'; renderModeHint(); } }),
      h('span', { text: 'Snapshot copy' }), h('span', { class: 'muted', text: '— fully detached, independent' })),
    h('label', { class: 'check-row' },
      h('input', { type: 'radio', name: 'extract-mode', value: 'linked', onchange: () => { mode = 'linked'; renderModeHint(); } }),
      h('span', { text: 'Linked live view' }), h('span', { class: 'muted', text: '— tracks source edits' })),
  );
  const modeHint = h('div', { class: 'hint', style: { marginTop: '8px' } });
  function renderModeHint() {
    modeHint.textContent = mode === 'linked'
      ? 'The new table shows exactly the selected rows and columns, live. Changes you make in the source table (values, not schema) appear instantly. It is read-only until you detach it into a snapshot.'
      : 'A point-in-time copy with its own schema and data. Later source changes do not affect it.';
  }
  renderModeHint();

  const warning = h('div', { class: 'fxcheck err', style: { marginTop: '8px' } });
  function checkWarnings() {
    const cols = (table.columns || []).filter((c) => chosenCols.has(c.id));
    const dropping = (table.columns || []).filter((c) => c.type === 'formula' && !chosenCols.has(c.id));
    if (dropping.length) {
      warning.textContent = `Note: formula columns being dropped: ${dropping.map((c) => c.name).join(', ')} — formulas on kept columns that reference them will show an error.`;
      warning.style.display = '';
    } else warning.style.display = 'none';
    return cols;
  }
  checkWarnings();

  m.body.append(
    h('div', { class: 'field' }, h('label', { text: 'New table name' }), nameInput),
    h('div', { class: 'field' }, h('label', { text: 'Description' }), descInput),
    h('div', { class: 'field' },
      h('label', { text: `Columns to include (${table.columns ? table.columns.length : 0})` }),
      colList),
    h('div', { class: 'field' }, h('label', { text: 'Rows' }), scopeRadios),
    h('div', { class: 'field' },
      h('label', { text: 'Mode' }), modeRow, modeHint),
    warning,
  );

  const createBtn = h('button', { class: 'btn primary', html: `${icon('layers', 15)} Extract` });
  m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }), createBtn);

  createBtn.addEventListener('click', async () => {
    const cols = checkWarnings();
    if (!cols.length) { toast('Select at least one column', 'err'); return; }
    const name = nameInput.value.trim();
    if (!name) { toast('Give the new table a name', 'err'); return; }
    let rowIds = null;
    if (scope === 'selected') rowIds = selectedRowIds || [];
    else if (scope === 'empty') rowIds = [];
    createBtn.disabled = true;
    try {
      const res = await api.extract({
        name,
        description: descInput.value.trim(),
        sourceTableId: table.id,
        mode,
        rowIds,
        columnIds: [...cols.map((c) => c.id)],
      });
      toast(mode === 'linked' ? 'Linked live view created' : 'Snapshot table created', 'ok');
      m.close();
      location.hash = `#/t/${res.table.id}`;
    } catch (e) { toast(e.message, 'err'); createBtn.disabled = false; }
  });
}
