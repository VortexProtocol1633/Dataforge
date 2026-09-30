/**
 * Column editor modal — name, data type, subtype and options
 * (required, default, validation, dropdown list, currency symbol, formula).
 */
import { api } from '../api.js';
import { h, esc, el, modal, toast } from '../util.js';
import { TYPES, typeMeta, typeIconSvg, quickNow } from '../types.js';

const FX_HELP = 'Reference columns as [Column Name]; group with ( ) or { }; join text with &. More than 80 functions are grouped below — search or click one to insert it.';

export function openColumnEditor({ table, column = null, onSaved }) {
  const editing = !!column;
  const m = modal({
    wide: true, tall: true, scroll: true, locked: true,
    title: editing ? `Edit column — ${column.name}` : 'Add a column',
    sub: editing ? `Type: ${typeMeta(column.type).label}` : 'Pick a data type and configure it.',
  });
  m.foot.append(h('button', { class: 'btn', text: 'Cancel', onclick: () => m.close() }));

  const draft = {
    name: editing ? column.name : '',
    type: editing ? column.type : 'text',
    subtype: editing ? column.subtype : null,
    options: editing ? JSON.parse(JSON.stringify(column.options || {})) : {},
  };

  /* ---------------- type picker (only when creating) ---------------- */
  const typeSection = h('div', { class: 'full' });
  if (!editing) {
    const groups = {};
    for (const t of TYPES) (groups[t.group] = groups[t.group] || []).push(t);
    const grid = h('div', { class: 'typelist' });
    for (const g of Object.keys(groups)) {
      grid.append(h('div', { class: 'full', style: { gridColumn: '1 / -1' } },
        h('div', { class: 'chip gray', style: { marginBottom: '4px' }, text: g })));
      for (const t of groups[g]) {
        const btn = h('button', {
          type: 'button', class: 'typeopt' + (draft.type === t.id ? ' sel' : ''),
          title: t.blurb,
          onclick: () => {
            draft.type = t.id;
            draft.subtype = t.subtype || null;
            draft.options = defaultsFor(t.id);
            grid.querySelectorAll('.typeopt').forEach((b) => b.classList.remove('sel'));
            btn.classList.add('sel');
            renderFields();
          },
        }, el(typeIconSvg(t.id, 16)), h('span', { text: t.label }));
        grid.append(btn);
      }
    }
    typeSection.append(grid);
  }

  function defaultsFor(type) {
    const o = {};
    if (type === 'currency') o.symbol = '$';
    if (type === 'dropdown') { o.list = []; o.multi = false; }
    if (type === 'text') o.regex = '';
    return o;
  }

  /* ---------------- fields ---------------- */
  const fields = h('div', { class: 'colcfg' });

  function field(label, node, full) {
    return h('div', { class: 'field' + (full ? ' full' : '') }, h('label', { text: label }), node);
  }

  const nameInput = h('input', {
    type: 'text', value: draft.name, placeholder: 'Column name',
    oninput: (e) => { draft.name = e.target.value; },
  });

  const subtypeWrap = h('div', { class: 'field' });
  function renderFields() {
    fields.innerHTML = '';
    const meta = typeMeta(draft.type);
    fields.append(field('Column name', nameInput));
    if (meta.subtypes && meta.subtypes.length) {
      subtypeWrap.innerHTML = '';
      subtypeWrap.append(h('label', { text: 'Variant' }));
      const sel = h('select');
      sel.innerHTML = meta.subtypes.map((s) => `<option value="${s.id}" ${(draft.subtype || meta.subtype) === s.id ? 'selected' : ''}>${s.label}</option>`).join('');
      sel.addEventListener('change', () => { draft.subtype = sel.value; });
      subtypeWrap.append(sel);
      fields.append(subtypeWrap);
    }

    // options per type
    if (draft.type === 'currency') {
      fields.append(field('Currency symbol', h('input', {
        type: 'text', value: draft.options.symbol || '$', style: { maxWidth: '120px' },
        oninput: (e) => { draft.options.symbol = e.target.value || '$'; },
      })));
    }
    if (draft.type === 'dropdown') {
      const listTA = h('textarea', {
        rows: 5, placeholder: 'One option per line',
        oninput: (e) => { draft.options.list = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean); },
      });
      listTA.value = (draft.options.list || []).join('\n');
      fields.append(field('Options', listTA, true));
      const multiChk = h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: !!draft.options.multi, onchange: (e) => { draft.options.multi = e.target.checked; } }),
        h('span', { text: 'Allow selecting several options' }));
      fields.append(field('Selection', multiChk));
    }
    if (draft.type === 'text') {
      const re = h('input', {
        type: 'text', value: draft.options.regex || '', placeholder: 'e.g. ^[A-Z]{3}\\d{2}$',
        oninput: (e) => { draft.options.regex = e.target.value; },
      });
      fields.append(field('Validation pattern (regex)', re, true));
    }
    if (draft.type === 'number' || draft.type === 'currency') {
      fields.append(
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px', gridColumn: '1 / -1' } },
          field('Minimum', h('input', { type: 'number', value: draft.options.min ?? '', oninput: (e) => { draft.options.min = e.target.value; } })),
          field('Maximum', h('input', { type: 'number', value: draft.options.max ?? '', oninput: (e) => { draft.options.max = e.target.value; } })),
        ));
    }
    if (draft.type === 'text') {
      fields.append(
        h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 14px', gridColumn: '1 / -1' } },
          field('Min length', h('input', { type: 'number', value: draft.options.min ?? '', oninput: (e) => { draft.options.min = e.target.value; } })),
          field('Max length', h('input', { type: 'number', value: draft.options.max ?? '', oninput: (e) => { draft.options.max = e.target.value; } })),
        ));
    }
    if (draft.type === 'formula') {
      const ta = h('textarea', { class: 'fxarea', rows: 3, placeholder: 'e.g.  ROUND([Price] * [Qty], 2)' });
      ta.value = draft.options.formula || '';
      const status = h('div', { class: 'fxcheck' });
      const testFx = () => {
        const v = window.DataForgeFx.parseFormula(ta.value);
        status.className = 'fxcheck ' + (v.ok ? 'ok' : 'err');
        status.textContent = v.ok ? 'Formula looks good.' : `Problem: ${v.error}`;
      };
      ta.addEventListener('input', () => {
        draft.options.formula = ta.value;
        testFx();
      });
      const refsWrap = h('div', { class: 'refs', style: { marginTop: '4px' } });
      const cols = (table.columns || []).filter((c) => c.type !== 'formula');
      if (cols.length) {
        refsWrap.append(h('span', { class: 'muted', style: { fontSize: '12px' }, text: 'Insert column:' }));
        for (const c of cols) {
          const pill = h('button', {
            type: 'button', class: 'pill', text: c.name, title: `Insert [${c.name}]`,
            onclick: () => { ta.value += (ta.value && !ta.value.endsWith(' ') ? ' ' : '') + `[${c.name}]`; ta.focus(); draft.options.formula = ta.value; testFx(); },
          });
          refsWrap.append(pill);
        }
      }
      fields.append(field('Formula expression', ta, true), field('References', refsWrap, true));
      const hint = h('div', { class: 'hint', style: { gridColumn: '1 / -1' }, text: FX_HELP });
      fields.append(hint);

      // Searchable function browser — click a chip to insert NAME( into the expression.
      const fxRef = h('div', { class: 'fxref' });
      const meta = (typeof window !== 'undefined' && window.DataForgeFx && window.DataForgeFx.META) || null;
      if (meta && meta.functions && meta.functions.length) {
        const groups = [];
        const byGroup = new Map();
        for (const f of meta.functions) {
          if (!byGroup.has(f.group)) byGroup.set(f.group, []);
          byGroup.get(f.group).push(f);
        }
        const order = ['Math', 'Text', 'Logic', 'Date & time'];
        for (const g of order) if (byGroup.has(g)) { groups.push(g); byGroup.get(g).sort((a, b) => a.name.localeCompare(b.name)); }
        const search = h('input', { type: 'search', placeholder: 'Search functions… (e.g. round, date)' });
        const chipsWrap = h('div', { class: 'fxref-chips' });
        const renderChips = (q) => {
          chipsWrap.innerHTML = '';
          const query = (q || '').toLowerCase();
          let shown = 0;
          for (const g of groups) {
            const list = byGroup.get(g).filter((f) => !query || f.name.toLowerCase().includes(query) || f.desc.toLowerCase().includes(query) || f.sig.toLowerCase().includes(query));
            if (!list.length) continue;
            chipsWrap.append(h('div', { class: 'fxref-group', text: g }));
            for (const f of list) {
              shown++;
              const chip = h('button', {
                type: 'button', class: 'pill fxfn', title: `${f.sig} — ${f.desc}\nExample: ${f.ex}`,
                text: f.name,
                onclick: () => {
                  const snippet = `${f.name}(`;
                  const start = ta.selectionStart ?? ta.value.length;
                  ta.value = ta.value.slice(0, start) + snippet + ta.value.slice(ta.selectionEnd ?? ta.value.length);
                  const pos = start + snippet.length;
                  ta.setSelectionRange(pos, pos);
                  ta.focus();
                  draft.options.formula = ta.value;
                  testFx();
                },
              });
              chipsWrap.append(chip);
            }
          }
          if (!shown) chipsWrap.append(h('div', { class: 'muted', style: { fontSize: '12px' }, text: 'No functions match.' }));
        };
        search.addEventListener('input', () => renderChips(search.value));
        fxRef.append(search, chipsWrap);
        renderChips('');
        fields.append(field('Insert a function', fxRef, true));
      }
      testFx();
    }
    if (!['formula', 'image', 'file'].includes(draft.type)) {
      const def = defaultField();
      fields.append(field('Default value (new rows)', def));
    }

    // required
    const reqChk = h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: !!draft.options.required, onchange: (e) => { draft.options.required = e.target.checked; } }),
      h('span', { text: 'Required — every row must provide a value' }));
    fields.append(field('', reqChk, true));
  }

  function defaultField() {
    const t = draft.type;
    const input = h('input', { type: 'text', placeholder: 'none' });
    const val = draft.options.defaultValue;
    if (val !== undefined && val !== null && val !== '') input.value = typeof val === 'object' ? `${val.n}/${val.d}` : String(val);
    if (t === 'date') input.type = 'date';
    else if (t === 'time') input.type = 'time';
    else if (t === 'datetime') { input.type = 'datetime-local'; if (input.value) input.value = String(input.value).replace(' ', 'T'); }
    else if (t === 'number' || t === 'currency') input.type = 'number';
    else if (t === 'boolean') { input.type = 'checkbox'; input.checked = !!draft.options.defaultValue; }
    const commit = () => {
      if (t === 'boolean') draft.options.defaultValue = input.checked;
      else if (t === 'fraction' && input.value) { const p = parseFracLocal(input.value); draft.options.defaultValue = p ? { n: p.n, d: p.d } : undefined; }
      else if (t === 'date' || t === 'time') draft.options.defaultValue = input.value || undefined;
      else if (t === 'datetime') draft.options.defaultValue = input.value ? input.value.replace('T', ' ') : undefined;
      else if (t === 'number' || t === 'currency') draft.options.defaultValue = input.value === '' ? undefined : Number(input.value);
      else draft.options.defaultValue = input.value || undefined;
    };
    input.addEventListener('change', commit);
    input.addEventListener('input', commit);
    if (draft.type === 'dropdown') {
      // default select from list
      const sel = h('select');
      const opts = (draft.options.list || []);
      sel.innerHTML = `<option value="">none</option>${opts.map((o) => `<option value="${esc(o)}" ${draft.options.defaultValue === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
      sel.addEventListener('change', () => { draft.options.defaultValue = sel.value || undefined; });
      return sel;
    }
    if (t === 'date' || t === 'time' || t === 'datetime') {
      const row = h('div', { style: { display: 'flex', gap: '6px' } });
      const btn = h('button', { type: 'button', class: 'btn sm ghost', text: 'now', onclick: () => { input.value = quickNow(t); commit(); } });
      row.append(input, btn);
      return row;
    }
    return input;
  }
  function parseFracLocal(s) {
    const m = s.trim().match(/^(\d+)\s+(\d+)\/(\d+)$/) || s.trim().match(/^(\d+)\/(\d+)$/) || s.trim().match(/^(\d+)$/);
    if (!m) return null;
    const n = m.length === 4 ? +m[1] * +m[3] + +m[2] : +m[1];
    const d = m.length === 4 ? +m[3] : m.length === 3 ? +m[2] : 1;
    return d ? { n, d } : null;
  }

  /* ---------------- assemble ---------------- */
  const body = h('div', { class: 'split' });
  body.append(typeSection, h('div', {}, fields));
  m.body.append(body);

  const save = h('button', { class: 'btn primary', text: editing ? 'Save changes' : 'Add column' });
  m.foot.append(save);
  renderFields();
  nameInput.focus();

  save.addEventListener('click', async () => {
    const name = draft.name.trim();
    if (!name) { toast('Column name is required', 'err'); nameInput.focus(); return; }
    if ((table.columns || []).some((c) => c.id !== (column && column.id) && c.name.toLowerCase() === name.toLowerCase())) {
      toast('A column with this name already exists', 'err'); return;
    }
    // validate formula now
    if (draft.type === 'formula') {
      const f = window.DataForgeFx.parseFormula(draft.options.formula || '');
      if (!f.ok) { toast(`Formula problem: ${f.error}`, 'err'); return; }
    }
    // sanitize empty numeric ranges
    for (const k of ['min', 'max']) {
      if (draft.options[k] === '') delete draft.options[k];
    }
    const payload = { name, type: draft.type, subtype: draft.subtype || undefined, options: draft.options };
    save.disabled = true;
    try {
      if (editing) await api.updateColumn(table.id, column.id, { name, subtype: draft.subtype, options: draft.options });
      else await api.addColumn(table.id, payload);
      toast(editing ? 'Column updated' : 'Column added', 'ok');
      m.close();
      onSaved && onSaved();
    } catch (e) { toast(e.message, 'err'); save.disabled = false; }
  });
}
